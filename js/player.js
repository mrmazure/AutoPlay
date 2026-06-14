import { Queue } from "./queue.js";

const FADE_MS = 1000;
const STEP_MS = 50;
const SIL_RMS = 0.06;
const SIL_FRM = 10;
// Pool de platines : permet à la piste sortante de jouer jusqu'à sa fin
// (chevauchement) sans jamais être écrasée par la platine de la suivante.
const players = [document.getElementById("player1"), document.getElementById("player2"), document.getElementById("player3")];
// Dedicated player for stream URLs — intentionally NOT connected to Web Audio API
// to avoid CORS-related muting (browsers silence cross-origin audio routed through
// createMediaElementSource when the server doesn't send CORS headers).
const playerStream = document.getElementById("player-stream");
// Éléments de pré-écoute (PFL) — eux aussi hors du graphe Web Audio master,
// routables vers une 2e carte son via setSinkId (cf. applyPreviewOutput).
const previewPlayers = [document.getElementById("player-preview-a"), document.getElementById("player-preview-b"), document.getElementById("player-preview-c")];
let previewDeviceId = null;
let streamActive = false;
let active = 0;
let currentFile = null; // Objet (File / dossier-picked / item URL) de la piste à l'antenne
let masterVol = 1;
let ctx = null;
let masterGain = null;
let masterAnalyser = null;
let pendingOutputDeviceId = null;
const sourceNodes = new Map(); // Store MediaElementSources to avoid re-creation errors

function getCtx() {
    if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = ctx.createGain();
        masterAnalyser = ctx.createAnalyser();
        masterAnalyser.fftSize = 256;
        masterGain.connect(masterAnalyser);
        masterAnalyser.connect(ctx.destination);

        // Connect players to master
        players.forEach(p => connectPlayer(p));

        // Start visualizer
        requestAnimationFrame(drawVisualizer);

        // Apply pending output device if set
        if (pendingOutputDeviceId && typeof ctx.setSinkId === 'function') {
            ctx.setSinkId(pendingOutputDeviceId).catch(() => {});
        }
    }
    return ctx;
}

function connectPlayer(audioEl) {
    const context = getCtx();
    if (!sourceNodes.has(audioEl)) {
        const source = context.createMediaElementSource(audioEl);
        source.connect(masterGain);
        sourceNodes.set(audioEl, source);
    }
}

export const setMasterVolume = (vol) => {
    masterVol = vol;
    playerStream.volume = vol; // Always update directly (not routed through Web Audio)
    if (masterGain) {
        masterGain.gain.setTargetAtTime(vol, getCtx().currentTime, 0.1);
    } else {
        players.forEach(p => p.volume = vol);
    }
};

export const fadeOut = (player, seconds = 1) => new Promise((resolve) => {
    if (player.__fading) return resolve();
    player.__fading = true;
    // 20 paliers/s (50 ms) : la durée totale du fondu = `seconds`.
    const step = player.volume / Math.max(1, seconds * 20);
    const interval = setInterval(() => {
        player.volume = Math.max(0, player.volume - step);
        if (player.volume === 0) {
            clearInterval(interval);
            player.pause();
            player.__fading = false;
            player.volume = 1;
            if (player === playerStream) {
                // Clear src so the stream isn't kept alive and streamActive is reset
                player.src = '';
                streamActive = false;
            } else {
                player.currentTime = 0;
            }
            resolve();
        }
    }, 50);
});

function observeSilence(player) {
    // Reverted to RMS based detection (Step 70 logic)
    const context = getCtx();
    let silenceAnalyser = player.__silenceAnalyser;
    if (!silenceAnalyser) {
        silenceAnalyser = context.createAnalyser();
        silenceAnalyser.fftSize = 1024;
        const source = sourceNodes.get(player);
        source.connect(silenceAnalyser);
        player.__silenceAnalyser = silenceAnalyser;
    }

    const dataArray = new Uint8Array(silenceAnalyser.fftSize);
    let silenceFrames = 0;
    let triggered = false;

    // Schedule next check: use setTimeout when the tab is hidden so silence
    // detection keeps running even in background / minimised window.
    const scheduleCheck = () =>
        document.hidden ? setTimeout(check, 50) : requestAnimationFrame(check);

    const check = () => {
        if (triggered || player.paused) return;

        // Une piste suivante a déjà démarré (cette platine n'est plus à l'antenne) :
        // on arrête de surveiller → la piste sortante joue jusqu'à sa fin, sans fondu.
        if (players[active] !== player) return;

        if (player.duration && player.currentTime < 0.7 * player.duration) {
            scheduleCheck();
            return;
        }

        const remaining = player.duration - player.currentTime;

        // End of file check (0.3s trigger) – safety net, always runs
        if (remaining < 0.3 && window.autoNext) {
            triggered = true;
            if (players[active] === player) playNext(false);
            fadeOut(player);
            return;
        }

        // Respect the visual cue point: don't fire silence detection before it.
        // tick() in ui.js owns the transition at nextCuePct; silence detection
        // is only a fallback for when no cue is active or it has been passed.
        const cuePct = window.nextCuePct;
        if (typeof cuePct === 'number' && player.currentTime / player.duration < cuePct) {
            scheduleCheck();
            return;
        }

        // Silence check
        silenceAnalyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);

        if (rms < SIL_RMS) {
            silenceFrames++;
        } else {
            silenceFrames = 0;
        }

        if (silenceFrames >= SIL_FRM && window.autoNext) {
            triggered = true;
            if (players[active] === player) playNext(false);
            fadeOut(player);
            return;
        }

        scheduleCheck();
    };
    scheduleCheck();
}

// Choisit une platine libre (autre que l'active), de préférence inutilisée /
// en pause / terminée. Évite d'écraser une piste sortante encore en lecture.
function pickFreeDeck() {
    const others = players.filter((_, i) => i !== active);
    return others.find(p => !p.currentSrc || p.paused || p.ended) || others[0];
}

function playNext(manual = false) {
    // Fade out whatever is currently playing
    if (manual) {
        if (streamActive) {
            fadeOut(playerStream);
        } else {
            const current = players[active];
            if (!current.paused) fadeOut(current);
        }
    }

    const nextFile = Queue.next();
    if (!nextFile) {
        if (streamActive) {
            playerStream.pause();
            playerStream.src = '';
            streamActive = false;
        }
        currentFile = null;
        document.dispatchEvent(new CustomEvent("trackclear"));
        return null;
    }
    currentFile = nextFile;

    // --- Stream URL: use dedicated player, bypasses Web Audio (avoids CORS muting) ---
    if (nextFile._isUrl) {
        if (streamActive) {
            playerStream.pause();
            playerStream.src = '';
        }
        streamActive = true;

        playerStream.src = nextFile._url;
        playerStream.volume = masterVol;
        playerStream.load();

        // Some streams fire loadedmetadata, others don't — handle both
        let metaFired = false;
        const fireChange = (dur) => {
            if (metaFired) return;
            metaFired = true;
            document.dispatchEvent(new CustomEvent('trackchange', {
                detail: { file: nextFile, duration: dur }
            }));
        };
        playerStream.onloadedmetadata = () => fireChange(playerStream.duration);
        playerStream.oncanplay = () => fireChange(Infinity);
        setTimeout(() => fireChange(Infinity), 4000); // final safety fallback

        playerStream.play().catch(console.warn);
        return nextFile;
    }

    // --- Regular file ---
    // Stop stream if one was active
    if (streamActive) {
        playerStream.pause();
        playerStream.src = '';
        streamActive = false;
    }

    const nextPlayer = pickFreeDeck();
    nextPlayer.src = URL.createObjectURL(nextFile);
    nextPlayer.volume = 1;
    nextPlayer.load();

    getCtx().resume().catch(() => { });

    nextPlayer.onloadedmetadata = () => {
        document.dispatchEvent(new CustomEvent("trackchange", {
            detail: {
                file: nextFile,
                duration: nextPlayer.duration
            }
        }));
    };

    nextPlayer.play().catch(console.warn);
    active = players.indexOf(nextPlayer);

    observeSilence(nextPlayer);
    return nextFile;
}

// Visualizer Loop
function drawVisualizer() {
    const canvas = document.getElementById("visualizer");
    if (!canvas || !masterAnalyser) {
        requestAnimationFrame(drawVisualizer);
        return;
    }

    const canvasCtx = canvas.getContext("2d");
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    const bufferLength = masterAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    masterAnalyser.getByteFrequencyData(dataArray);

    canvasCtx.clearRect(0, 0, width, height);

    const barWidth = (width / bufferLength) * 2;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * height; // Scale to height
        canvasCtx.fillStyle = `rgba(99, 102, 241, ${dataArray[i] / 255})`;
        canvasCtx.fillRect(x, height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
    }

    requestAnimationFrame(drawVisualizer);
}


// Déclenche le passage au titre suivant au point NEXT.
// Par défaut la piste sortante N'EST PAS coupée : elle joue jusqu'à sa fin
// (chevauchement avec la suivante). Un fondu de sortie n'est appliqué que si
// la piste définit _mix.fadeOut > 0 (durée du fondu, à partir du point NEXT).
function advance(prevDeck) {
    const outFile = currentFile;
    playNext(false);
    const fade = outFile && outFile._mix && outFile._mix.fadeOut;
    if (fade > 0 && prevDeck) fadeOut(prevDeck, fade);
}

players.forEach(p => {
    p.addEventListener("ended", () => {
        // Only trigger next if this is the ACTIVE player ending naturally.
        // If it's a previous player fading out, ignore.
        if (p === players[active]) {
            if (window.autoNext) {
                playNext(false);
            } else {
                document.dispatchEvent(new CustomEvent("trackclear"));
            }
        }
    });

    // Primary NEXT cue trigger.
    // timeupdate is fired by the browser's media engine — it is never
    // throttled during audio playback, regardless of tab visibility,
    // minimised window, or background state. This replaces any
    // requestAnimationFrame / setTimeout polling for the cue point.
    p.addEventListener('timeupdate', () => {
        if (p !== players[active] || !p.duration) return;
        const pct = p.currentTime / p.duration;
        if (typeof window.nextCuePct === 'number' && window.autoNext && pct >= window.nextCuePct) {
            window.nextCuePct = null; // prevent tick() in ui.js from double-firing
            advance(p);
        }
    });
});

// Réinitialise la piste courante quand la lecture est arrêtée/vidée.
document.addEventListener("trackclear", () => { currentFile = null; });

export const Player = {
    getCurrent: () => streamActive ? playerStream : players[active],
    getCurrentFile: () => currentFile,
    playNext: playNext,
    advance: advance
};

export const applyAudioOutput = async (deviceId) => {
    const promises = [];
    if (ctx && typeof ctx.setSinkId === 'function') {
        promises.push(ctx.setSinkId(deviceId).catch(() => {}));
    } else {
        pendingOutputDeviceId = deviceId;
    }
    if ('setSinkId' in HTMLAudioElement.prototype) {
        players.forEach(p => promises.push(p.setSinkId(deviceId).catch(() => {})));
        promises.push(playerStream.setSinkId(deviceId).catch(() => {}));
    }
    if (promises.length > 0) await Promise.all(promises);
};

// ── Pré-écoute (PFL) ──────────────────────────────────────────────────────
// Route les deux éléments de pré-écoute vers une carte son distincte.
export const applyPreviewOutput = async (deviceId) => {
    previewDeviceId = deviceId;
    if ('setSinkId' in HTMLAudioElement.prototype) {
        await Promise.all(previewPlayers.map(p => p.setSinkId(deviceId).catch(() => {})));
    }
};

// Lecteur d'arrangement de pré-écoute : joue jusqu'à 3 pistes posées sur une
// timeline partagée (avec chevauchements), sur la carte PFL, avec tête de
// lecture et recherche (seek). Chaque piste k utilise l'élément previewPlayers
// [k % 2] : deux pistes adjacentes ne partagent jamais le même élément.
let arr = null;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function clearElement(el) {
    if (!el.__file && !el.src) return;
    el.pause();
    el.onloadedmetadata = null;
    if (el.src) { try { URL.revokeObjectURL(el.src); } catch (_) {} el.removeAttribute('src'); el.load(); }
    el.__file = null;
    el.__ready = false;
    el.__trk = null;
}

// Assigne un fichier à un élément et le positionne à `localTime`.
function setElementTrack(el, file, localTime) {
    if (el.__file === file) {
        if (el.paused) el.play().catch(() => {});
        return;
    }
    if (el.src) { try { URL.revokeObjectURL(el.src); } catch (_) {} }
    el.__file = file;
    el.__ready = false;
    el.__seekTo = Math.max(0, localTime);
    el.src = URL.createObjectURL(file);
    el.load();
    el.onloadedmetadata = () => {
        el.__ready = true;
        try { el.currentTime = clampN(el.__seekTo, 0, el.duration || el.__seekTo); } catch (_) {}
        el.play().catch(() => {});
    };
}

function stopPreview() {
    if (arr) { arr.cancelled = true; if (arr.raf) cancelAnimationFrame(arr.raf); arr = null; }
    previewPlayers.forEach(p => { clearElement(p); p.volume = 1; });
}

/**
 * Joue un arrangement sur la carte PFL.
 * Par défaut AUCUN fondu : chaque piste démarre et reste à 100 %, et la piste
 * sortante joue jusqu'à sa fin même quand la suivante a commencé. Un fondu de
 * sortie n'est appliqué que si la piste définit `fadeOut > 0` (en secondes,
 * à partir de son point NEXT).
 * @param tracks  [{ file, start, dur, next, isLast, fadeOut }]  (temps absolus en s)
 * @param fromSec position de départ (s) sur la timeline
 * @param onTick  callback(playheadSec) à chaque frame
 * @param onEnd   callback() en fin d'arrangement
 */
async function playArrangement({ tracks, fromSec = 0, onTick, onEnd }) {
    stopPreview();
    const usable = tracks.filter(t => t.file && !t.file._isUrl);
    if (!usable.length) return;
    if (previewDeviceId) await applyPreviewOutput(previewDeviceId);

    const end = Math.max(...usable.map(t => t.start + t.dur));
    const state = { tracks: usable, onTick, onEnd, end, cancelled: false,
                    base: clampN(fromSec, 0, end), t0: performance.now() / 1000, needSeek: true, raf: null };
    arr = state;

    const loop = () => {
        if (!arr || state.cancelled) return;
        const playhead = state.base + (performance.now() / 1000 - state.t0);
        if (playhead >= state.end) { onTick?.(state.end); stopPreview(); onEnd?.(); return; }

        state.tracks.forEach((trk, k) => {
            const el = previewPlayers[k % previewPlayers.length];
            const local = playhead - trk.start;
            const fade = trk.fadeOut > 0 ? trk.fadeOut : 0;
            // Sans fondu : audible jusqu'à la fin du fichier. Avec fondu :
            // on coupe une fois le fondu terminé (next + fadeOut).
            const audibleEnd = fade > 0
                ? Math.min(trk.start + trk.dur, trk.start + trk.next + fade)
                : trk.start + trk.dur;
            const active = playhead >= trk.start && playhead < audibleEnd;

            if (active) {
                if (el.__trk !== k) { el.__trk = k; setElementTrack(el, trk.file, local); }
                else if (state.needSeek && el.__ready) {
                    try { el.currentTime = clampN(local, 0, el.duration || local); } catch (_) {}
                    if (el.paused) el.play().catch(() => {});
                }
                // Volume : 100 % par défaut ; fondu de sortie optionnel après NEXT.
                let g = 1;
                if (fade > 0) {
                    const fs = trk.start + trk.next;
                    if (playhead > fs) g = Math.max(0, 1 - (playhead - fs) / fade);
                }
                el.volume = clampN(g, 0, 1);
            } else if (el.__trk === k) {
                clearElement(el);
            }
        });

        state.needSeek = false;
        onTick?.(playhead);
        state.raf = requestAnimationFrame(loop);
    };
    state.raf = requestAnimationFrame(loop);
}

// Déplace la tête de lecture de l'arrangement en cours.
function seekArrangement(sec) {
    if (!arr) return;
    arr.base = clampN(sec, 0, arr.end);
    arr.t0 = performance.now() / 1000;
    arr.needSeek = true;
}

export const Preview = {
    playArrangement,
    seek: seekArrangement,
    stop: stopPreview,
    isPlaying: () => !!arr,
    isAvailable: () => 'setSinkId' in HTMLAudioElement.prototype
};

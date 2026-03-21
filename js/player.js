import { Queue } from "./queue.js";

const FADE_MS = 1000;
const STEP_MS = 50;
const SIL_RMS = 0.06;
const SIL_FRM = 10;
const players = [document.getElementById("player1"), document.getElementById("player2")];
// Dedicated player for stream URLs — intentionally NOT connected to Web Audio API
// to avoid CORS-related muting (browsers silence cross-origin audio routed through
// createMediaElementSource when the server doesn't send CORS headers).
const playerStream = document.getElementById("player-stream");
let streamActive = false;
let active = 0;
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

export const fadeOut = (player) => new Promise((resolve) => {
    if (player.__fading) return resolve();
    player.__fading = true;
    const step = player.volume / 20;
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
        document.dispatchEvent(new CustomEvent("trackclear"));
        return null;
    }

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

    const nextPlayer = players[1 - active];
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
    active = 1 - active;

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
            const prev = p;
            playNext(false);
            fadeOut(prev);
        }
    });
});

export const Player = {
    getCurrent: () => streamActive ? playerStream : players[active],
    playNext: playNext
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

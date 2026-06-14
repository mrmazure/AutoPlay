import { Queue as e } from "./queue.js";
import { Player as t, fadeOut as a } from "./player.js";
import { Waveform, detectFadeOutCue } from "./waveform.js";
import { openMixEditor } from "./mix-editor.js";
import { reconnectItem } from "./playlist-io.js";

const $ = e => document.getElementById(e),
    queue = $("queue"),
    hint = $("drop-hint"),
    nowT = $("now-title"),
    upNext = $("next-track-name"),
    hist = $("history-list"),
    // bar = $("progress-bar"),
    progress = $("progress"),
    waveformCanvas = $("waveform"),
    meta = $("time-meta"),
    clock = $("clock"),
    introCd = $("intro-countdown"),
    fmt = e => `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(Math.floor(e % 60)).padStart(2, "0")}`;

let currentWaveform = null;
let currentIntroSec = null; // fin d'intro (s) de la piste en cours, null = aucune
let introPct = null;        // position de l'intro (ratio 0-1), null = non affiché
let fadeEndPct = null;      // fin du fondu de sortie (ratio 0-1), null = pas de fondu
let nextCuePct = null;   // 0-1 ratio of track, null = inactive
window.nextCuePct = null; // mirrored for cross-module access (player.js)
function setNextCuePct(v) { nextCuePct = v; window.nextCuePct = v; }
let isDraggingCue = false;
const CUE_HIT_PX = 12;  // pixels tolerance to grab the marker

export const UI = {
    renderQueue() {
        e.ensurePicks();
        queue.innerHTML = "";
        e.all().forEach((n, r) => {
            const isFolder = !!n._isFolder;
            const isUrl = !!n._isUrl;
            const isMissing = !!n._placeholder; // fichier/dossier à recharger
            const li = document.createElement("li");
            li.className = "queue-item"
                + (isFolder ? " queue-folder" : "")
                + (isUrl ? " queue-url-track" : "")
                + (isMissing ? " queue-missing" : "");
            li.dataset.id = n._id;
            li.draggable = true;

            const icon = isMissing ? (n._kind === "folder" ? "📁 " : "📄 ")
                : isFolder ? "📁 " : isUrl ? "🌐 " : "";
            const durTxt = isMissing
                ? (n._kind === "folder" ? (n._count || 0) + " fich." : (n._dur && isFinite(n._dur) ? fmt(n._dur) : "?"))
                : isFolder ? n._files.length + " fich."
                    : (n._dur && isFinite(n._dur) ? fmt(n._dur) : (isUrl ? "flux" : "--:--"));
            const sub = isMissing
                ? (n._needsPermission
                    ? `<span class="folder-pick missing-note">🔌 à reconnecter (clique pour autoriser)</span>`
                    : `<span class="folder-pick missing-note">⚠ à recharger (re-déposez le fichier)</span>`)
                : (isFolder && n._picked ? `<span class="folder-pick">↳ ${n._picked.name}</span>` : "");

            li.innerHTML = `
                <div class="qi-info">
                    <span class="file-name">${icon}${n.name}</span>
                    ${sub}
                </div>
                <span class="duration">${durTxt}</span>
            `;

            // ❌ supprimer (toujours présent)
            const delBtn = document.createElement("button");
            delBtn.className = "delete-btn";
            delBtn.textContent = "❌";
            delBtn.title = "Supprimer de la playlist";
            delBtn.onclick = ev => { ev.stopPropagation(); e.remove(r); UI.renderQueue(); };

            if (isMissing) {
                // Emplacement non jouable : pas de bouton Play / Mix.
                if (n._needsPermission && n._handle) {
                    const rcBtn = document.createElement("button");
                    rcBtn.className = "reconnect-btn";
                    rcBtn.title = "Reconnecter (autoriser l'accès au fichier/dossier)";
                    rcBtn.textContent = "🔌";
                    rcBtn.onclick = async ev => {
                        ev.stopPropagation();
                        const ok = await reconnectItem(r);
                        if (ok) UI.renderQueue();
                    };
                    li.append(rcBtn, delBtn);
                } else {
                    li.append(delBtn);
                }
            } else {
                // ▶ jouer immédiatement
                const playBtn = document.createElement("button");
                playBtn.className = "play-item-btn";
                playBtn.title = "Jouer immédiatement";
                playBtn.textContent = "▶";
                playBtn.onclick = ev => {
                    ev.stopPropagation();
                    const all = e.all();
                    const item = all.splice(r, 1)[0];
                    e.set([item, ...all]);
                    const cur = t.getCurrent();
                    cur && !cur.paused && a(cur);
                    t.playNext();
                    UI.renderQueue();
                };

                // Éditeur de mix
                const mixBtn = document.createElement("button");
                mixBtn.className = "mix-item-btn";
                mixBtn.title = "Éditeur de mix (points intro / enchaînement)";
                mixBtn.textContent = "MIX";
                mixBtn.onclick = ev => { ev.stopPropagation(); openMixEditor(r); };

                // ⧉ dupliquer
                const dupBtn = document.createElement("button");
                dupBtn.className = "dup-item-btn";
                dupBtn.title = "Dupliquer cet élément";
                dupBtn.textContent = "⧉";
                dupBtn.onclick = ev => { ev.stopPropagation(); e.duplicate(r); UI.renderQueue(); };

                li.append(playBtn, mixBtn, dupBtn, delBtn);
            }

            li.addEventListener("dragstart", () => li.classList.add("dragging"));
            li.addEventListener("dragend", () => li.classList.remove("dragging"));
            queue.append(li);
        });
        hint.style.display = e.all().length ? "none" : "flex";
        const np = e.peek();
        upNext.textContent = np
            ? (np._isFolder ? "📁 " + np.name + (np._picked ? " → " + np._picked.name : " (aléatoire)") : np.name)
            : "–";
    },
    async updateCurrent(file, dur) {
        nowT.textContent = file.name, meta.dataset.total = dur;
        const r = (new Date).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit"
        });
        hist.insertAdjacentHTML("afterbegin", `<li>${r} – ${file.name}</li>`);

        // Flux live : masquer la progress bar
        if (!isFinite(dur)) {
            progress.style.display = 'none';
            currentWaveform = null;
            currentIntroSec = null;
            introPct = null; fadeEndPct = null;
            setNextCuePct(null);
            return;
        }

        // Generate Waveform
        progress.style.display = '';
        currentWaveform = null;
        currentIntroSec = null;
        introPct = null; fadeEndPct = null;

        const mix = file._mix;
        // Points de mix mémorisés : appliqués immédiatement (sans attendre l'onde).
        if (mix && mix.next != null) setNextCuePct(Math.min(0.999, mix.next / dur));
        else setNextCuePct(0.93); // repli ~93 % le temps que l'onde se charge
        if (mix && mix.intro != null) currentIntroSec = mix.intro;
        applyMixMarkers(mix, dur);

        drawWaveform(0);

        if (file instanceof File || file instanceof Blob) {
            try {
                currentWaveform = await Waveform.getCached(file, 800);
                if (currentWaveform) {
                    // Auto-détection du point NEXT seulement (l'intro reste manuelle).
                    if (!(mix && mix.next != null)) setNextCuePct(detectFadeOutCue(currentWaveform));
                }
            } catch (err) {
                console.warn("Waveform gen failed", err);
            }
        }
    },
    clearCurrent() {
        nowT.textContent = "–", meta.textContent = "", currentWaveform = null, currentIntroSec = null, setNextCuePct(null), drawWaveform(0), progress.style.display = '';
        introPct = null; fadeEndPct = null;
        introCd.hidden = true; introCd.classList.remove("blink");
    },
    tick() {
        const e = t.getCurrent();
        if (!e || e.paused) {
            // bar.style.width = "0%";
            updateIntroCountdown(null);
            if (!window.autoNext) UI.clearCurrent();
        } else if (e.duration) {
            if (isFinite(e.duration)) {
                // NEXT cue trigger: fallback for foreground (primary is timeupdate in player.js).
                if (window.nextCuePct !== null && window.autoNext) {
                    const pct = e.currentTime / e.duration;
                    if (pct >= window.nextCuePct) {
                        setNextCuePct(null);
                        t.advance(e);
                    }
                }
                const remaining = e.duration - e.currentTime;
                meta.textContent = `Durée : ${fmt(meta.dataset.total || e.duration)} | Restant : ${fmt(remaining)}`;
                drawWaveform(e.currentTime / e.duration);
                updateIntroCountdown(e);
            } else {
                // Flux live (durée infinie)
                meta.textContent = `🔴 EN DIRECT | Écoulé : ${fmt(e.currentTime)}`;
                updateIntroCountdown(null);
            }
        }
        clock.textContent = (new Date).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
        // Use setTimeout when hidden so the cue-point trigger keeps firing
        // even when the tab is in background or the window is minimised.
        document.hidden ? setTimeout(UI.tick, 250) : requestAnimationFrame(UI.tick);
    }
};

// Affiche / met à jour le décompte d'intro de la piste en cours.
// Clignote (classe .blink) dans les 5 dernières secondes de l'intro.
function updateIntroCountdown(audioEl) {
    if (!audioEl || currentIntroSec == null || !isFinite(audioEl.duration)) {
        if (!introCd.hidden) { introCd.hidden = true; introCd.classList.remove("blink"); }
        return;
    }
    const rem = currentIntroSec - audioEl.currentTime;
    if (rem <= 0 || rem > audioEl.duration) {
        if (!introCd.hidden) { introCd.hidden = true; introCd.classList.remove("blink"); }
        return;
    }
    introCd.hidden = false;
    introCd.textContent = `🎤 INTRO ${rem < 10 ? rem.toFixed(1) : Math.ceil(rem)} s`;
    introCd.classList.toggle("blink", rem <= 5);
}

function drawWaveform(progressPct) {
    if (!waveformCanvas) return;
    const ctx = waveformCanvas.getContext("2d");

    // Only resize the canvas backing store if the element has a real size.
    // Setting canvas.width/height to 0 clears it permanently and causes
    // the waveform to disappear on small screens or during layout transitions.
    const lw = waveformCanvas.offsetWidth;
    const lh = waveformCanvas.offsetHeight;
    if (lw > 0 && waveformCanvas.width !== lw) waveformCanvas.width = lw;
    if (lh > 0 && waveformCanvas.height !== lh) waveformCanvas.height = lh;

    const w = waveformCanvas.width;
    const h = waveformCanvas.height;
    if (!w || !h) return; // layout not ready yet, skip frame

    ctx.clearRect(0, 0, w, h);

    if (!currentWaveform) {
        // Draw loading or empty line
        ctx.fillStyle = "#333";
        ctx.fillRect(0, h / 2 - 1, w, 2);
        // Still draw the markers even without waveform data
        drawMixMarkers(ctx, w, h);
        drawCueMarker(ctx, w, h);
        return;
    }

    const barW = w / currentWaveform.length;
    const center = h / 2;

    // Draw Background (Unplayed)
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)"; // Muted color
    for (let i = 0; i < currentWaveform.length; i++) {
        const val = currentWaveform[i];
        const barH = Math.max(2, val * h * 0.8);
        ctx.fillRect(i * barW, center - barH / 2, barW, barH);
    }

    // Draw Progress (Played) - using simple overlay or clipping
    // Clipping method
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w * progressPct, h);
    ctx.clip();

    ctx.fillStyle = "#6366f1"; // Accent color
    for (let i = 0; i < currentWaveform.length; i++) {
        const val = currentWaveform[i];
        const barH = Math.max(2, val * h * 0.8);
        ctx.fillRect(i * barW, center - barH / 2, barW, barH);
    }
    ctx.restore();

    // ── Marqueurs : intro (vert) + fondu de sortie (orange) + NEXT (rouge) ──
    drawMixMarkers(ctx, w, h);
    drawCueMarker(ctx, w, h);
}

// Calcule les ratios des marqueurs intro / fondu à partir des points de mix.
function applyMixMarkers(mix, dur) {
    introPct = (mix && mix.intro != null && isFinite(dur) && mix.intro > 0) ? mix.intro / dur : null;
    fadeEndPct = (mix && mix.next != null && mix.fadeOut > 0 && isFinite(dur))
        ? Math.min(1, (mix.next + mix.fadeOut) / dur) : null;
}

// Dessine, sur la waveform principale, le point d'intro et le fondu de sortie.
function drawMixMarkers(ctx, w, h) {
    // Fondu de sortie : rampe orange de NEXT (haut) à la fin du fondu (bas)
    if (fadeEndPct !== null && nextCuePct !== null && fadeEndPct > nextCuePct) {
        const fx = nextCuePct * w, fex = fadeEndPct * w;
        ctx.save();
        ctx.fillStyle = 'rgba(245,158,11,0.18)';
        ctx.beginPath();
        ctx.moveTo(fx, 0); ctx.lineTo(fex, 0); ctx.lineTo(fex, h); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(fx, 2); ctx.lineTo(fex, h - 2); ctx.stroke();
        ctx.restore();
    }
    // Point d'intro : ligne verte + libellé
    if (introPct !== null && introPct > 0) {
        const mx = Math.round(introPct * w);
        ctx.save();
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke();
        const tri = 6;
        ctx.fillStyle = '#22c55e';
        ctx.beginPath(); ctx.moveTo(mx - tri, 0); ctx.lineTo(mx + tri, 0); ctx.lineTo(mx, tri * 1.4); ctx.closePath(); ctx.fill();
        ctx.font = 'bold 10px Inter, system-ui, sans-serif';
        const tw = ctx.measureText('INTRO').width;
        const lx = Math.min(Math.max(mx, tw / 2 + 4), w - tw / 2 - 4);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(lx - tw / 2 - 3, 2, tw + 6, 13);
        ctx.fillStyle = '#22c55e';
        ctx.textBaseline = 'top'; ctx.textAlign = 'center';
        ctx.fillText('INTRO', lx, 3);
        ctx.restore();
    }
}

function drawCueMarker(ctx, w, h) {
    if (nextCuePct === null) return;
    const mx = Math.round(nextCuePct * w);
    const col = isDraggingCue ? '#ff8080' : '#ef4444';

    ctx.save();

    // Subtle red tint on the zone AFTER the marker
    ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
    ctx.fillRect(mx, 0, w - mx, h);

    // Red vertical line
    ctx.strokeStyle = col;
    ctx.lineWidth = isDraggingCue ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, h);
    ctx.stroke();

    // Small downward triangle handle at the top (drag grip visual)
    const tri = 6;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(mx - tri, 0);
    ctx.lineTo(mx + tri, 0);
    ctx.lineTo(mx, tri * 1.4);
    ctx.closePath();
    ctx.fill();

    // "NEXT" label at the bottom with a dark backing for readability
    ctx.font = 'bold 10px Inter, system-ui, sans-serif';
    const tw = ctx.measureText('NEXT').width;
    // Keep label inside canvas bounds
    const lx = Math.min(Math.max(mx, tw / 2 + 4), w - tw / 2 - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(lx - tw / 2 - 3, h - 14, tw + 6, 13);
    ctx.fillStyle = col;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    ctx.fillText('NEXT', lx, h - 1);

    ctx.restore();
}

progress.addEventListener("click", (e => {
    const n = t.getCurrent();
    if (!n.duration) return;
    const {
        left: r,
        width: a
    } = progress.getBoundingClientRect();
    n.currentTime = (e.clientX - r) / a * n.duration
}));

// ── NEXT cue marker — pointer drag logic ──────────────────────────────────

// Update cursor and block seek-clicks that land on the marker
waveformCanvas.addEventListener('mousemove', evt => {
    if (nextCuePct === null) { waveformCanvas.style.cursor = ''; return; }
    const r = waveformCanvas.getBoundingClientRect();
    const dist = Math.abs((evt.clientX - r.left) - nextCuePct * r.width);
    waveformCanvas.style.cursor = dist <= CUE_HIT_PX ? 'ew-resize' : '';
});

// Block the seek-click when the user clicks directly on the marker
waveformCanvas.addEventListener('click', evt => {
    if (nextCuePct === null) return;
    const r = waveformCanvas.getBoundingClientRect();
    const dist = Math.abs((evt.clientX - r.left) - nextCuePct * r.width);
    if (dist <= CUE_HIT_PX) evt.stopPropagation();
});

// Start dragging when pointer goes down near the marker
waveformCanvas.addEventListener('pointerdown', evt => {
    if (nextCuePct === null) return;
    const r = waveformCanvas.getBoundingClientRect();
    const dist = Math.abs((evt.clientX - r.left) - nextCuePct * r.width);
    if (dist > CUE_HIT_PX) return;
    isDraggingCue = true;
    waveformCanvas.setPointerCapture(evt.pointerId);
    waveformCanvas.style.cursor = 'ew-resize';
    evt.stopPropagation();
    evt.preventDefault();
});

// Move the marker while dragging
waveformCanvas.addEventListener('pointermove', evt => {
    if (!isDraggingCue) return;
    const r = waveformCanvas.getBoundingClientRect();
    setNextCuePct(Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width)));
    evt.preventDefault();
});

// Release drag
waveformCanvas.addEventListener('pointerup', () => {
    if (!isDraggingCue) return;
    isDraggingCue = false;
    waveformCanvas.style.cursor = '';
    // Mémorise le point NEXT déplacé sur la piste en cours (cohérence éditeur ↔ direct).
    const f = t.getCurrentFile?.();
    const cur = t.getCurrent();
    if (f && cur && isFinite(cur.duration) && nextCuePct != null) {
        f._mix = f._mix || { intro: null, next: null };
        f._mix.next = nextCuePct * cur.duration;
    }
});

waveformCanvas.addEventListener('pointercancel', () => { isDraggingCue = false; });

// Right-click near the marker → remove it
waveformCanvas.addEventListener('contextmenu', evt => {
    if (nextCuePct === null) return;
    const r = waveformCanvas.getBoundingClientRect();
    const dist = Math.abs((evt.clientX - r.left) - nextCuePct * r.width);
    if (dist <= CUE_HIT_PX * 2) {
        evt.preventDefault();
        setNextCuePct(null);
        const f = t.getCurrentFile?.();
        if (f && f._mix) f._mix.next = null;
    }
});

// L'éditeur de mix a modifié les points d'une piste : si c'est la piste en
// cours, on réapplique aussitôt le point NEXT et l'intro en direct.
document.addEventListener("mixupdated", ev => {
    const file = ev.detail?.file;
    const cur = t.getCurrent();
    if (file && file === t.getCurrentFile?.() && cur && isFinite(cur.duration)) {
        if (file._mix && file._mix.next != null) setNextCuePct(Math.min(0.999, file._mix.next / cur.duration));
        currentIntroSec = file._mix && file._mix.intro != null ? file._mix.intro : currentIntroSec;
        applyMixMarkers(file._mix, cur.duration);
    }
    UI.renderQueue();
});

queue.addEventListener("dragover", (e => {
    e.preventDefault();
    const t = queue.querySelector(".dragging");
    if (!t) return;
    const n = [...queue.querySelectorAll(".queue-item:not(.dragging)")].find((t => e.clientY < t.getBoundingClientRect().top + t.offsetHeight / 2));
    n ? queue.insertBefore(t, n) : queue.append(t)
}));
queue.addEventListener("drop", (t => {
    t.preventDefault();
    const ids = [...queue.querySelectorAll(".queue-item")].map(li => li.dataset.id);
    e.set(ids.map(id => e.all().find(item => item._id === id)));
    UI.renderQueue();
}));
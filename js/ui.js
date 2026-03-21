import { Queue as e } from "./queue.js";
import { Player as t, fadeOut as a } from "./player.js";
import { Waveform } from "./waveform.js";

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
    fmt = e => `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(Math.floor(e % 60)).padStart(2, "0")}`;

let currentWaveform = null;
let nextCuePct = null;   // 0-1 ratio of track, null = inactive
window.nextCuePct = null; // mirrored for cross-module access (player.js)
function setNextCuePct(v) { nextCuePct = v; window.nextCuePct = v; }
let isDraggingCue = false;
const CUE_HIT_PX = 12;  // pixels tolerance to grab the marker

export const UI = {
    renderQueue() {
        queue.innerHTML = "", e.all().forEach(((n, r) => {
            const isFolder = !!n._isFolder;
            const isUrl = !!n._isUrl;
            const o = document.createElement("li");
            o.className = "queue-item" + (isFolder ? " queue-folder" : "") + (isUrl ? " queue-url-track" : ""), o.dataset.id = n._id, o.draggable = !0, o.innerHTML = `
        <span class="file-name">${isFolder ? "📁 " : isUrl ? "🌐 " : ""}${n.name}</span>
        <span class="duration">${isFolder ? n._files.length + " fich." : (n._dur && isFinite(n._dur) ? fmt(n._dur) : (isUrl ? "flux" : "--:--"))}</span>
        <button class="delete-btn">🗑</button>
      `;
            const i = document.createElement("button");
            i.className = "play-item-btn", i.title = "Jouer immédiatement", i.textContent = "▶", i.onclick = n => {
                n.stopPropagation();
                const o = e.all(),
                    i = o.splice(r, 1)[0];
                e.set([i, ...o]);
                const u = t.getCurrent();
                u && !u.paused && a(u), t.playNext(), UI.renderQueue()
            };
            const u = o.querySelector(".delete-btn");
            u.textContent = "❌", u.title = "Supprimer de la playlist", u.style.color = "red", u.onclick = t => {
                t.stopPropagation(), e.remove(r), UI.renderQueue()
            }, o.insertBefore(i, u), o.addEventListener("dragstart", (() => o.classList.add("dragging"))), o.addEventListener("dragend", (() => o.classList.remove("dragging"))), queue.append(o)
        }));
        hint.style.display = e.all().length ? "none" : "flex";
        const np = e.peek();
        upNext.textContent = np ? (np._isFolder ? "📁 " + np.name + " (aléatoire)" : np.name) : "–";
    },
    async updateCurrent(e, n) {
        nowT.textContent = e.name, meta.dataset.total = n;
        const r = (new Date).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit"
        });
        hist.insertAdjacentHTML("afterbegin", `<li>${r} – ${e.name}</li>`);

        // Flux live : masquer la progress bar
        if (!isFinite(n)) {
            progress.style.display = 'none';
            currentWaveform = null;
            setNextCuePct(null);
            return;
        }

        // Generate Waveform
        progress.style.display = '';
        currentWaveform = null;
        setNextCuePct(0.93); // Fallback: ~93% while waveform loads
        // Draw placeholder
        drawWaveform(0);

        if (e && (e instanceof File || e instanceof Blob)) {
            try {
                currentWaveform = await Waveform.generate(e, 800);
                // Detect fade-out start to set a smart NEXT cue point
                setNextCuePct(detectFadeOutCue(currentWaveform));
            } catch (err) {
                console.warn("Waveform gen failed", err);
            }
        }
    },
    clearCurrent() {
        nowT.textContent = "–", meta.textContent = "", currentWaveform = null, setNextCuePct(null), drawWaveform(0), progress.style.display = ''
    },
    tick() {
        const e = t.getCurrent();
        if (!e || e.paused) {
            // bar.style.width = "0%";
            if (!window.autoNext) UI.clearCurrent();
        } else if (e.duration) {
            if (isFinite(e.duration)) {
                // NEXT cue trigger: fallback for foreground (primary is timeupdate in player.js).
                if (window.nextCuePct !== null && window.autoNext) {
                    const pct = e.currentTime / e.duration;
                    if (pct >= window.nextCuePct) {
                        const prevPlayer = e;
                        setNextCuePct(null);
                        t.playNext(false);
                        a(prevPlayer);
                    }
                }
                const remaining = e.duration - e.currentTime;
                meta.textContent = `Durée : ${fmt(meta.dataset.total || e.duration)} | Restant : ${fmt(remaining)}`;
                drawWaveform(e.currentTime / e.duration);
            } else {
                // Flux live (durée infinie)
                meta.textContent = `🔴 EN DIRECT | Écoulé : ${fmt(e.currentTime)}`;
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

/**
 * Detects where the fade-out begins at the end of a track,
 * following standard radio automation segue logic:
 *  - Only looks in the last 35% of the track
 *  - Scans backwards from the end to find the first sample
 *    where the level rises above a "loud" threshold (= start of fade-out)
 *  - Requires the drop to be sustained for at least SUSTAIN samples
 *  - Fallback: total_duration - 4 seconds (≈ 93% for a 3:30 track)
 *
 * @param {Float32Array} waveform  Normalised 0-1 amplitude samples
 * @returns {number}               Cue position as a 0-1 ratio
 */
function detectFadeOutCue(waveform) {
    const n = waveform.length;

    // Compute the average level of the "body" (first 60% of the track)
    // to get a reference loudness, ignoring intro/outro silence.
    const bodyEnd = Math.floor(n * 0.60);
    let bodySum = 0;
    for (let i = Math.floor(n * 0.10); i < bodyEnd; i++) bodySum += waveform[i];
    const bodyAvg = bodySum / (bodyEnd - Math.floor(n * 0.10));

    // Fade starts when the level drops below this fraction of the body average.
    const FADE_THRESHOLD = bodyAvg * 0.40; // 40 % of normal loudness
    // How many consecutive quiet samples confirm the fade (≈ 0.5 s at 800 samples/track)
    const SUSTAIN = Math.max(8, Math.floor(n * 0.010));
    // Only search in the last 35% of the track
    const searchStart = Math.floor(n * 0.65);

    // Scan backwards: find the latest sample above threshold
    // (= the last "loud" moment before the fade-out)
    // Use -1 as sentinel so we can detect "nothing found in search window".
    let lastLoud = -1;
    for (let i = n - 1; i >= searchStart; i--) {
        if (waveform[i] >= FADE_THRESHOLD) { lastLoud = i; break; }
    }

    // If the entire last 35% is already quiet (no loud sample found),
    // the fade started before our search window – use the safe fallback
    // rather than scanning forward from 65% and returning way too early.
    if (lastLoud === -1) return 0.93;

    // Now scan forward from lastLoud to find where SUSTAIN consecutive
    // samples stay below threshold (= confirmed start of fade-out).
    // Floor at 0.80 so the cue never lands before 80% of the track.
    for (let i = lastLoud; i <= n - SUSTAIN; i++) {
        let quiet = true;
        for (let j = 0; j < SUSTAIN; j++) {
            if (waveform[i + j] >= FADE_THRESHOLD) { quiet = false; break; }
        }
        if (quiet) return Math.max(0.80, i / n); // Never trigger before 80%
    }

    // Fallback: place cue 4 s before the end (estimated from 93%)
    return 0.93;
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
        // Still draw the cue marker even without waveform data
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

    // ── NEXT cue point marker ─────────────────────────────────
    drawCueMarker(ctx, w, h);
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
    }
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
/**
 * mix-editor.js — Éditeur de mix (segue editor) façon mairlist / DAW.
 *
 * Les pistes sont posées sur UNE timeline partagée, empilées (A en haut,
 * B au milieu, C en bas). Le début de la piste B correspond au point
 * « Start Next » de la piste A ; idem pour C vis-à-vis de B.
 *  - glisser une piste horizontalement déplace son point de départ
 *    (= le « Start Next » de la piste précédente) ;
 *  - le marqueur INTRO (jaune) de chaque piste se déplace librement ;
 *  - le marqueur « Start Next » (bleu) se déplace aussi directement.
 *
 * Points mémorisés en secondes sur l'objet fichier joué :
 *   file._mix = { intro: <sec|null>, next: <sec|null> }
 *  - intro : fin de l'intro (talk-over)
 *  - next  : instant où la piste suivante démarre (Start Next)
 */

import { Queue } from "./queue.js";
import { Player, Preview } from "./player.js";
import { Waveform, detectFadeOutCue } from "./waveform.js";

const LANE_H = 132;   // hauteur d'une piste
const RULER_H = 24;   // hauteur de la règle de temps
const HIT_PX = 7;     // tolérance de saisie d'un marqueur

const COL_CUEIN = "#22c55e";   // vert — début de piste
const COL_INTRO = "#eab308";   // jaune — fin d'intro
const COL_NEXT = "#60a5fa";    // bleu — Start Next
const COL_FADE = "#f59e0b";    // orange — fondu de sortie (optionnel)
const FADE_MIN = 0.2;          // en-dessous : fondu considéré désactivé (s)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtT = s => {
    if (!isFinite(s)) s = 0;
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};

const hasPreviewCard = () => {
    const id = localStorage.getItem("previewOutputDeviceId");
    return !!id && id !== "default";
};

// ── Résolution des pistes à afficher ──────────────────────────────────────

const resolveFile = item => {
    if (!item) return null;
    if (item._isFolder) return item._picked || null;
    if (item._isUrl) return null;
    return item;
};
const displayName = item => {
    if (!item) return "–";
    if (item._isFolder) return `${item.name} → ${item._picked ? item._picked.name : "?"}`;
    if (item._isUrl) return item.name;
    return item.name;
};

function buildRows(index) {
    const all = Queue.all();
    const make = item => item ? { item, file: resolveFile(item), name: displayName(item) } : null;
    let rows = [];
    if (index === 0) {
        const cur = Player.getCurrentFile?.();
        if (cur && !cur._isUrl) {
            // En cours (antenne) → 1ère de la file → suivante
            rows.push({ item: null, file: cur, name: cur.name });
            rows.push(make(all[0]));
            rows.push(make(all[1]));
        } else {
            rows.push(make(all[0]));
            rows.push(make(all[1]));
            rows.push(make(all[2]));
        }
    } else {
        rows.push(make(all[index - 1]));
        rows.push(make(all[index]));
        rows.push(make(all[index + 1]));
    }
    return rows.filter(Boolean);
}

// Durée du fichier (mémorisée sur file._dur).
function getDuration(file) {
    return new Promise(res => {
        if (file._dur && isFinite(file._dur)) return res(file._dur);
        const au = new Audio();
        au.preload = "metadata";
        au.onloadedmetadata = () => { file._dur = au.duration; res(au.duration); };
        au.onerror = () => res(0);
        au.src = URL.createObjectURL(file);
    });
}

// Auto ne calcule QUE le point Start Next (fondu de sortie). L'intro est
// laissée à l'utilisateur : sa détection automatique est trop peu fiable.
function autoRow(row) {
    if (!row.wave || !row.dur) return;
    row.next = detectFadeOutCue(row.wave) * row.dur;
}

// ── Session courante ───────────────────────────────────────────────────────
// S = { rows, canvas, ctx, pps, spanSec, starts, drag }

let S = null;
let overlay = null;

// Position absolue (s) du début de chaque piste sur la timeline partagée.
function computeStarts(rows) {
    const starts = [0];
    for (let k = 1; k < rows.length; k++) starts[k] = starts[k - 1] + rows[k - 1].next;
    return starts;
}

// Conversions temps ↔ pixels (tiennent compte du zoom et du défilement).
const secToX = sec => (sec - S.offsetSec) * S.pps;
const xToSec = px => S.offsetSec + px / S.pps;

// Cadre la vue sur une piste : tout le fichier + quelques secondes de marge.
function setInitialView(focusRow) {
    if (!focusRow || !focusRow.dur) return;
    const starts = computeStarts(S.rows);
    const k = S.rows.indexOf(focusRow);
    const pad = clamp(focusRow.dur * 0.1, 3, 8);
    const windowSec = focusRow.dur + pad * 2;
    S.zoom = clamp((S.spanSec * 1.02) / windowSec, 1, 60);
    S.offsetSec = Math.max(0, starts[k] - pad); // clampé ensuite dans drawTimeline
}

// Construit l'arrangement (temps absolus) pour la pré-écoute.
function buildTracks() {
    const starts = computeStarts(S.rows);
    return S.rows.map((r, k) => ({
        file: r.file, start: starts[k], dur: r.dur, next: r.next,
        fadeOut: r.fadeOut || 0, isLast: k === S.rows.length - 1
    }));
}

function startPreview(fromSec) {
    S.playing = true;
    Preview.playArrangement({
        tracks: buildTracks(),
        fromSec: Math.max(0, fromSec),
        onTick: ph => { if (S) { S.playhead = ph; drawTimeline(); } },
        // Fin naturelle : on garde la tête là où elle s'arrête (repère de reprise).
        onEnd: () => { if (S) { S.playing = false; drawTimeline(); } }
    });
}

// Bascule lecture / arrêt (barre espace). On garde la tête de lecture comme
// repère de l'endroit où la lecture reprendra.
function togglePreview() {
    if (Preview.isPlaying()) stopPreviewUI();
    else startPreview(S.playhead != null ? S.playhead : 0);
}

function stopPreviewUI() {
    Preview.stop();
    if (S) { S.playing = false; drawTimeline(); }
}

// ── Rendu ────────────────────────────────────────────────────────────────

function vline(ctx, x, y, h, col, w = 2) {
    ctx.strokeStyle = col; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.stroke();
}
function tag(ctx, text, x, y, col, align = "left") {
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = align; ctx.textBaseline = "top";
    const w = ctx.measureText(text).width;
    const tx = align === "right" ? x - w : x;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(tx - 2, y, w + 4, 13);
    ctx.fillStyle = col;
    ctx.fillText(text, x, y + 1);
}

function drawTimeline() {
    if (!S) return;
    const c = S.canvas;
    const W = c.width = c.offsetWidth || 960;
    const N = S.rows.length;
    const H = c.height = N * LANE_H + RULER_H;
    const ctx = c.getContext("2d");

    // Transformée de vue : zoom (≥1, 1 = tout visible) + défilement horizontal.
    S.basePps = W / (S.spanSec * 1.02);
    S.zoom = S.zoom || 1;
    const pps = S.pps = S.basePps * S.zoom;
    const maxOff = Math.max(0, S.spanSec - W / pps);
    S.offsetSec = clamp(S.offsetSec || 0, 0, maxOff);
    const secToX = sec => (sec - S.offsetSec) * pps;
    const starts = S.starts = computeStarts(S.rows);

    ctx.clearRect(0, 0, W, H);

    S.rows.forEach((row, k) => {
        const y = k * LANE_H;
        const x0 = secToX(starts[k]);
        const x1 = secToX(starts[k] + row.dur);
        const introX = secToX(starts[k] + row.intro);
        const nextX = secToX(starts[k] + row.next);
        const center = y + LANE_H / 2;

        // Fond de piste (gris) + corps audio (noir)
        ctx.fillStyle = "#26262b"; ctx.fillRect(0, y, W, LANE_H);
        ctx.fillStyle = "#0c0c0e"; ctx.fillRect(x0, y, x1 - x0, LANE_H);

        // Forme d'onde
        if (row.wave) {
            const bw = (x1 - x0) / row.wave.length;
            ctx.fillStyle = "#1f8a4c";
            for (let i = 0; i < row.wave.length; i++) {
                const bh = Math.max(1, row.wave[i] * LANE_H * 0.82);
                ctx.fillRect(x0 + i * bw, center - bh / 2, Math.max(0.6, bw), bh);
            }
        }

        // Zone après Start Next (légère teinte)
        ctx.fillStyle = "rgba(96,165,250,0.10)";
        ctx.fillRect(nextX, y, x1 - nextX, LANE_H);

        // Fondu de sortie optionnel : rampe orange de NEXT (haut) à fin de fondu (bas)
        const fade = row.fadeOut || 0;
        const fadeEndX = secToX(starts[k] + row.next + fade);
        if (fade > 0) {
            ctx.fillStyle = "rgba(245,158,11,0.18)";
            ctx.beginPath();
            ctx.moveTo(nextX, y); ctx.lineTo(fadeEndX, y); ctx.lineTo(fadeEndX, y + LANE_H); ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = COL_FADE; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(nextX, y + 2); ctx.lineTo(fadeEndX, y + LANE_H - 2); ctx.stroke();
        }

        // Marqueurs
        vline(ctx, x0, y, LANE_H, COL_CUEIN);
        vline(ctx, introX, y, LANE_H, COL_INTRO);
        vline(ctx, nextX, y, LANE_H, COL_NEXT);

        // Poignée de fondu (carré orange, en haut) — la glisser vers la droite crée/règle le fondu
        ctx.fillStyle = COL_FADE;
        ctx.fillRect(fadeEndX - 4, y + 1, 8, 8);

        // Étiquettes
        tag(ctx, row.name, x0 + 4, y + 4, "#e5e5e5");
        tag(ctx, "Cue In", x0 + 4, y + LANE_H - 15, COL_CUEIN);
        tag(ctx, "Intro " + fmtT(row.intro), introX + 4, y + 20, COL_INTRO);
        tag(ctx, "Start Next " + fmtT(row.next), nextX + 4, y + 36, COL_NEXT);
        tag(ctx, fade > 0 ? "Fade " + fmtT(fade) : "Fade off", fadeEndX + 7, y + 1, COL_FADE);

        // Séparateur de pistes
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y + LANE_H + 0.5); ctx.lineTo(W, y + LANE_H + 0.5); ctx.stroke();
    });

    drawRuler(ctx, W, N * LANE_H, secToX);

    // Tête de lecture de la pré-écoute
    if (S.playhead != null) {
        const px = secToX(S.playhead);
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, N * LANE_H); ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.closePath(); ctx.fill();
    }

    updateScrollbar(W);
}

// Reflète l'état zoom/défilement dans la barre de défilement.
function updateScrollbar(W) {
    if (!S || !S.scrollbar) return;
    const trackW = S.scrollbar.clientWidth || W;
    const visibleSpan = W / S.pps;                 // secondes visibles
    const frac = Math.min(1, visibleSpan / S.spanSec);
    if (frac >= 0.999) { S.scrollbar.classList.add("hidden"); return; }
    S.scrollbar.classList.remove("hidden");
    const thumbW = Math.max(28, frac * trackW);
    const left = (S.offsetSec / S.spanSec) * trackW;
    S.thumb.style.width = thumbW + "px";
    S.thumb.style.left = clamp(left, 0, trackW - thumbW) + "px";
}

function attachScrollbar() {
    const bar = S.scrollbar, thumb = S.thumb;
    let drag = null;
    thumb.addEventListener("pointerdown", e => {
        e.stopPropagation();
        drag = { startX: e.clientX, startOff: S.offsetSec };
        thumb.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    thumb.addEventListener("pointermove", e => {
        if (!drag) return;
        const trackW = bar.clientWidth || 1;
        const deltaSec = ((e.clientX - drag.startX) / trackW) * S.spanSec;
        S.offsetSec = drag.startOff + deltaSec; // clampé dans drawTimeline
        drawTimeline();
    });
    const end = () => { drag = null; };
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);
    // Clic dans la piste de la barre : centre la vue sur ce point.
    bar.addEventListener("pointerdown", e => {
        if (e.target === thumb) return;
        const r = bar.getBoundingClientRect();
        const frac = (e.clientX - r.left) / r.width;
        const visibleSpan = (S.canvas.offsetWidth || 1) / S.pps;
        S.offsetSec = frac * S.spanSec - visibleSpan / 2;
        drawTimeline();
    });
}

function drawRuler(ctx, W, y, secToX) {
    ctx.fillStyle = "#1a1a1f"; ctx.fillRect(0, y, W, RULER_H);
    ctx.strokeStyle = "#3d3d45"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
    // Pas adaptatif au zoom : on vise ~80 px entre deux graduations.
    const pxPerSec = S.pps;
    const targetPx = 80;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    let step = steps.find(s => s * pxPerSec >= targetPx) || 600;
    const firstSec = Math.floor(S.offsetSec / step) * step;
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (let s = firstSec; secToX(s) < W; s += step) {
        const x = secToX(s);
        if (x < -1) continue;
        ctx.strokeStyle = "#3d3d45";
        ctx.beginPath(); ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + 6); ctx.stroke();
        const m = Math.floor(s / 60), sec = Math.round(s % 60);
        ctx.fillText(`${m}:${String(sec).padStart(2, "0")}`, x + 3, y + RULER_H / 2 + 2);
    }
}

// ── Interaction ─────────────────────────────────────────────────────────────

function hitTest(px, py) {
    if (!S.starts) return null;
    const k = Math.floor(py / LANE_H);
    if (k < 0 || k >= S.rows.length) return null;
    const row = S.rows[k];
    const topY = py - k * LANE_H;
    const introX = secToX(S.starts[k] + row.intro);
    const nextX = secToX(S.starts[k] + row.next);
    const fadeEndX = secToX(S.starts[k] + row.next + (row.fadeOut || 0));
    const x0 = secToX(S.starts[k]);
    const x1 = secToX(S.starts[k] + row.dur);
    if (Math.abs(px - introX) <= HIT_PX) return { mode: "intro", k };
    // Poignée de fondu : coin supérieur, prioritaire sur le marqueur NEXT.
    if (topY <= 16 && Math.abs(px - fadeEndX) <= HIT_PX + 2) return { mode: "fade", k };
    if (Math.abs(px - nextX) <= HIT_PX) return { mode: "next", k };
    // Sur la forme d'onde : k≥1 déplaçable ; k=0 (ancre) → "body" non déplaçable.
    if (px >= x0 && px <= x1) return { mode: k >= 1 ? "track" : "body", k };
    return null; // zone vide (gris) ou règle de temps
}

function attachTimeline() {
    const c = S.canvas;
    const local = e => {
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        return { x, y, sec: xToSec(x) };
    };

    // Molette : zoom centré sur le curseur ; Maj+molette ou molette horizontale : défilement.
    c.addEventListener("wheel", e => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const cx = e.clientX - r.left;
        const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (e.shiftKey || horiz) {
            S.offsetSec = (S.offsetSec || 0) + (horiz ? e.deltaX : e.deltaY) / S.pps;
        } else {
            const secAt = (S.offsetSec || 0) + cx / S.pps;
            S.zoom = clamp((S.zoom || 1) * (e.deltaY < 0 ? 1.35 : 1 / 1.35), 1, 80);
            S.offsetSec = secAt - cx / (S.basePps * S.zoom);
        }
        drawTimeline(); // recalcule pps et clampe le défilement
    }, { passive: false });

    const isMarker = ht => ht && (ht.mode === "intro" || ht.mode === "next" || ht.mode === "fade");

    c.addEventListener("mousemove", e => {
        if (S.drag) return;
        const p = local(e);
        const ht = hitTest(p.x, p.y);
        c.style.cursor = isMarker(ht) ? "ew-resize"
            : (ht && ht.mode === "track") ? "grab"     // déplaçable même en lecture
                : (ht && ht.mode === "body") ? "default"  // ancre / sur un fichier
                    : "crosshair";                         // zone vide : tête de lecture
    });

    c.addEventListener("pointerdown", e => {
        const p = local(e);
        const ht = hitTest(p.x, p.y);

        // Marqueurs (intro / next / fondu) : éditables même pendant la lecture.
        if (isMarker(ht)) {
            const orig = ht.mode === "intro" ? S.rows[ht.k].intro
                : ht.mode === "next" ? S.rows[ht.k].next
                    : S.rows[ht.k].fadeOut || 0;
            S.drag = { ht, startSec: p.sec, orig };
            c.setPointerCapture(e.pointerId);
            c.style.cursor = "ew-resize";
            e.preventDefault();
            return;
        }

        // Glisser une piste (k≥1) — autorisé même pendant la pré-écoute.
        if (ht && ht.mode === "track") {
            S.drag = { ht, startSec: p.sec, orig: S.rows[ht.k - 1].next };
            c.setPointerCapture(e.pointerId);
            c.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }

        // Sur le corps de la piste-ancre (k=0) : ne rien faire (pas un déplacement
        // de tête, car ce n'est pas une zone vide).
        if (ht && ht.mode === "body") return;

        // Zone vide (ou règle de temps) : (re)pose la tête de lecture.
        const sec = clamp(p.sec, 0, S.spanSec);
        S.playhead = sec;
        if (S.playing) Preview.seek(sec);
        drawTimeline();
    });

    c.addEventListener("pointermove", e => {
        if (!S.drag) return;
        const p = local(e);
        const { ht, startSec, orig } = S.drag;
        const row = S.rows[ht.k];
        if (ht.mode === "intro") {
            row.intro = clamp(p.sec - S.starts[ht.k], 0, row.dur);
        } else if (ht.mode === "next") {
            row.next = clamp(p.sec - S.starts[ht.k], 0, row.dur);
        } else if (ht.mode === "fade") {
            const raw = p.sec - (S.starts[ht.k] + row.next);
            row.fadeOut = raw < FADE_MIN ? 0 : clamp(raw, 0, row.dur - row.next);
        } else { // track : déplace prev.next selon le delta
            const prev = S.rows[ht.k - 1];
            prev.next = clamp(orig + (p.sec - startSec), 0, prev.dur);
        }
        drawTimeline();
    });

    const end = () => { if (S.drag) { S.drag = null; c.style.cursor = "default"; } };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
}

// ── Modale ─────────────────────────────────────────────────────────────────

function closeEditor() {
    Preview.stop();
    if (overlay) { overlay.remove(); overlay = null; }
    S = null;
    window.removeEventListener("resize", drawTimeline);
    document.removeEventListener("keydown", onKey);
}
function onKey(e) {
    if (e.key === "Escape") { closeEditor(); return; }
    if (e.code === "Space") { e.preventDefault(); togglePreview(); }
}

export async function openMixEditor(index) {
    closeEditor();
    const all = buildRows(index);
    const rows = all.filter(r => r.file);          // pistes mixables
    const skipped = all.filter(r => !r.file);      // flux/URL ignorés

    overlay = document.createElement("div");
    overlay.id = "mix-editor-overlay";
    overlay.innerHTML = `
        <div class="mix-editor" role="dialog" aria-label="Éditeur de mix">
            <header class="me-head">
                <span class="me-title">🎚 Éditeur de mix</span>
                <span class="me-nav">
                    <button class="me-btn me-prevmix" title="Mix précédent (chanson précédente)">◀ Préc.</button>
                    <button class="me-btn me-nextmix" title="Mix suivant (chanson suivante)">Suiv. ▶</button>
                </span>
                <button class="me-close" title="Fermer">✕</button>
            </header>
            <div class="me-body">
                <div class="me-hint">Marqueurs : <b style="color:#22c55e">Cue In</b> · <b style="color:#eab308">Intro</b> · <b style="color:#60a5fa">Start Next</b> · <b style="color:#f59e0b">Fade out</b> (poignée orange en haut, glisser vers la droite). <br>🖱 Molette = zoom · Maj+molette = défilement · Barre espace = lecture/arrêt · clic dans le vide = placer la tête de lecture.</div>
                <div class="me-stage"></div>
            </div>
            <footer class="me-foot"></footer>
        </div>`;
    document.body.appendChild(overlay);
    const stage = overlay.querySelector(".me-stage");
    const foot = overlay.querySelector(".me-foot");

    if (!rows.length) {
        stage.innerHTML = `<div class="me-msg">Aucune piste éditable ici (flux / dossier vide). L'édition de mix nécessite un fichier audio.</div>`;
        foot.innerHTML = `<span class="me-spacer"></span><button class="me-btn me-cancel">Fermer</button>`;
        foot.querySelector(".me-cancel").onclick = closeEditor;
        document.addEventListener("keydown", onKey);
        return;
    }
    if (!hasPreviewCard()) {
        const warn = document.createElement("div");
        warn.className = "me-warn";
        warn.textContent = "⚠ Aucune carte de pré-écoute choisie : la pré-écoute sortira sur la sortie par défaut (risque de passage à l'antenne). Sélectionne « 🎧 Pré-écoute » en haut.";
        stage.appendChild(warn);
    }
    if (skipped.length) {
        const note = document.createElement("div");
        note.className = "me-hint";
        note.textContent = "Ignoré (flux, non mixable) : " + skipped.map(r => r.name).join(", ");
        stage.appendChild(note);
    }

    stage.insertAdjacentHTML("beforeend", `<div class="me-loading"><span class="me-spinner"></span>Analyse des formes d'onde…</div>`);

    // Charge durées + ondes
    await Promise.all(rows.map(async r => {
        r.dur = await getDuration(r.file);
        r.wave = await Waveform.getCached(r.file, 1000);
        const m = r.file._mix;
        // Pas de détection automatique de l'intro (trop peu fiable) : défaut = 0.
        r.intro = m && m.intro != null ? m.intro : 0;
        r.next = m && m.next != null ? m.next : (r.wave ? detectFadeOutCue(r.wave) * r.dur : r.dur);
        r.fadeOut = m && m.fadeOut != null ? m.fadeOut : 0;   // 0 = pas de fondu (défaut)
    }));
    if (!overlay) return; // fermé entre-temps
    stage.querySelector(".me-loading")?.remove();

    const canvas = document.createElement("canvas");
    canvas.id = "me-timeline";
    stage.appendChild(canvas);

    const scrollbar = document.createElement("div");
    scrollbar.className = "me-scrollbar hidden";
    scrollbar.innerHTML = `<div class="me-thumb"></div>`;
    stage.appendChild(scrollbar);

    S = {
        rows,
        canvas,
        scrollbar,
        thumb: scrollbar.querySelector(".me-thumb"),
        spanSec: Math.max(1, rows.reduce((a, r) => a + (r.dur || 0), 0)),
        drag: null,
        zoom: 1,
        offsetSec: 0,
        playhead: null,
        playing: false
    };

    // Vue initiale : zoomée sur le fichier cliqué (+ quelques secondes autour).
    const clicked = Queue.all()[index];
    const focusRow = rows.find(r => r.item === clicked) || rows[0];
    setInitialView(focusRow);

    // Pied : Auto + pré-écoute par paire (3 s avant le NEXT) + Stop + Annuler / Valider
    foot.innerHTML = `<button class="me-btn me-auto">✨ Auto (tout)</button>`;
    for (let k = 0; k < rows.length - 1; k++) {
        const b = document.createElement("button");
        b.className = "me-btn me-prev";
        b.textContent = `▶ ${k + 1}→${k + 2}`;
        b.title = `Pré-écoute de l'enchaînement (démarre 3 s avant le point NEXT)`;
        b.onclick = () => {
            const starts = computeStarts(S.rows);
            startPreview(starts[k] + S.rows[k].next - 3);
        };
        foot.appendChild(b);
    }
    const stopBtn = document.createElement("button");
    stopBtn.className = "me-btn me-stop";
    stopBtn.textContent = "⏹";
    stopBtn.title = "Arrêter la pré-écoute";
    stopBtn.onclick = stopPreviewUI;
    foot.appendChild(stopBtn);

    foot.insertAdjacentHTML("beforeend",
        `<span class="me-spacer"></span><button class="me-btn me-cancel">Annuler</button><button class="me-btn me-ok">Valider</button>`);

    // Enregistre les points de mix courants sur les objets fichier.
    const commitMix = () => rows.forEach(row => {
        row.file._mix = { intro: row.intro, next: row.next, fadeOut: row.fadeOut || 0 };
        document.dispatchEvent(new CustomEvent("mixupdated", { detail: { file: row.file } }));
    });

    foot.querySelector(".me-auto").onclick = () => { rows.forEach(autoRow); drawTimeline(); };
    foot.querySelector(".me-cancel").onclick = closeEditor;
    foot.querySelector(".me-ok").onclick = () => { commitMix(); closeEditor(); };

    // Navigation entre mix : on enregistre l'édition courante puis on rouvre.
    const total = Queue.all().length;
    const prevBtn = overlay.querySelector(".me-prevmix");
    const nextBtn = overlay.querySelector(".me-nextmix");
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= total - 1;
    prevBtn.onclick = () => { if (index > 0) { commitMix(); openMixEditor(index - 1); } };
    nextBtn.onclick = () => { if (index < total - 1) { commitMix(); openMixEditor(index + 1); } };

    overlay.querySelector(".me-close").onclick = closeEditor;
    overlay.addEventListener("pointerdown", e => { if (e.target === overlay) closeEditor(); });
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", drawTimeline);

    requestAnimationFrame(() => { drawTimeline(); attachTimeline(); attachScrollbar(); });
}

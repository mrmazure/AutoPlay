import { initAudioOutput } from "./audio-output.js";
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
import { Queue as e } from "./queue.js"; import { Player as t, fadeOut as a, setMasterVolume as n } from "./player.js"; import { UI as r } from "./ui.js"; const left = document.getElementById("left-panel"), hint = document.getElementById("drop-hint"), queue = document.getElementById("queue"), addBtn = document.getElementById("add-btn"), shBtn = document.getElementById("shuffle-btn"), volInp = document.getElementById("volume"), play = document.getElementById("play-btn"), next = document.getElementById("next-btn"), pause = document.getElementById("pause-btn"), stop = document.getElementById("stop-btn"), autoBtn = document.getElementById("stop-end-btn"), audioRE = /\.(mp3|wav|ogg|m4a|flac)$/i; let autoNext = !0; window.autoNext = autoNext; autoBtn.classList.toggle("active", autoNext); autoBtn.addEventListener("click", (() => { autoNext = !autoNext, window.autoNext = autoNext, autoBtn.classList.toggle("active", autoNext) })); const filesFrom = e => [...e].map((e => e.getAsFile?.() ?? e)).filter((e => e && (e.type.startsWith("audio/") || audioRE.test(e.name)))).map((e => (e._id = crypto.randomUUID(), e))), loadDur = e => new Promise((t => { if (e._dur) return t(); const n = new Audio; n.src = URL.createObjectURL(e), n.onloadedmetadata = () => { e._dur = n.duration, t() } })); async function add(t) { t.length && (e.add(t), await Promise.all(t.map(loadDur)), r.renderQueue()) } function openPicker() { const e = document.createElement("input"); e.type = "file", e.multiple = !0, e.accept = "audio/*", e.hidden = !0, document.body.append(e), e.onchange = () => { add(filesFrom(e.files)); e.remove() }, e.click() } const wantsFiles = e => [...e.types].includes("Files"); let dragCounter = 0; function onDragEnter(e) { wantsFiles(e.dataTransfer) && (dragCounter++, left.classList.add("dragover"), e.preventDefault()) } function onDragLeave(e) { wantsFiles(e.dataTransfer) && (dragCounter--, 0 === dragCounter && left.classList.remove("dragover")) } function onDragOver(e) { wantsFiles(e.dataTransfer) && (e.preventDefault(), e.dataTransfer.dropEffect = "copy") } function drop(e) { wantsFiles(e.dataTransfer) && (e.preventDefault(), e.stopPropagation(), dragCounter = 0, left.classList.remove("dragover"), add(filesFrom(e.dataTransfer.items || e.dataTransfer.files))) } function onPlay() { const e = t.getCurrent(); if (!(e && e.currentSrc)) return t.playNext(), void r.renderQueue(); if (e.paused) { if (e.ended) { t.playNext(); r.renderQueue(); } else { e.play().catch(console.warn) } } else { a(e), t.playNext(), r.renderQueue() } } left.addEventListener("dragenter", onDragEnter, !0), left.addEventListener("dragover", onDragOver, !0), left.addEventListener("dragleave", onDragLeave, !0), left.addEventListener("drop", drop, !0), play.addEventListener("click", onPlay), next.addEventListener("click", (() => { const e = t.getCurrent(); e && !e.paused && a(e), t.playNext(), r.renderQueue() })), pause.addEventListener("click", (() => { const e = t.getCurrent(); e && (e.paused ? e.play().catch(console.warn) : e.pause()) })), stop.addEventListener("click", (() => { const e = t.getCurrent(); e && a(e).then((() => document.dispatchEvent(new CustomEvent("trackclear")))) })), volInp.addEventListener("input", (e => n(+e.target.value))), shBtn.addEventListener("click", (() => { e.shuffle(), r.renderQueue() })), addBtn.addEventListener("click", (e => { e.stopPropagation(), openPicker() })), left.addEventListener("click", (e => { e.target !== left && e.target !== hint || openPicker() })), document.addEventListener("trackchange", (e => { r.updateCurrent(e.detail.file, e.detail.duration), r.renderQueue() })), document.addEventListener("trackclear", (() => r.clearCurrent())), r.renderQueue(), r.tick(); initAudioOutput();

// --- Dossier & Mode Boucle ---
const addFolderBtn = document.getElementById('add-folder-btn');
const loopPlaylistBtn = document.getElementById('loop-playlist-btn');
const loopBtn = document.getElementById('loop-btn');

function openFolderPicker() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.webkitdirectory = true;
    inp.multiple = true;
    inp.hidden = true;
    document.body.append(inp);
    inp.onchange = () => {
        const audioFiles = [...inp.files].filter(f =>
            (f.type.startsWith('audio/') || audioRE.test(f.name)) &&
            (f.webkitRelativePath.match(/\//g) || []).length === 1
        );
        if (audioFiles.length) {
            const folderName = audioFiles[0].webkitRelativePath?.split('/')[0] || 'Dossier';
            e.add([{ _id: crypto.randomUUID(), name: folderName, _isFolder: true, _files: audioFiles, _dur: null, type: 'folder' }]);
            r.renderQueue();
        }
        inp.remove();
    };
    inp.click();
}

function setLoopMode(active) {
    e.setLoop(active);
    loopBtn.classList.toggle('active', active);
    loopPlaylistBtn.classList.toggle('active', active);
}

addFolderBtn.addEventListener('click', evt => { evt.stopPropagation(); openFolderPicker(); });
loopPlaylistBtn.addEventListener('click', evt => { evt.stopPropagation(); setLoopMode(!e.isLoop()); });
loopBtn.addEventListener('click', () => setLoopMode(!e.isLoop()));

// --- Flux streaming ---
const addStreamBtn = document.getElementById('add-stream-btn');

addStreamBtn.addEventListener('click', evt => {
    evt.stopPropagation();
    const url = prompt('URL du flux streaming (http:// ou https://) :');
    if (!url || !/^https?:\/\//i.test(url.trim())) return;
    // Pas de nom demandé : l'adresse du flux sert de nom dans la playlist.
    e.add([{ _id: crypto.randomUUID(), name: url.trim(), _url: url.trim(), _dur: null, type: 'audio/mpeg', _isUrl: true }]);
    r.renderQueue();
});
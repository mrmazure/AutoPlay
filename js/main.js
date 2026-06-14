import { initAudioOutput } from "./audio-output.js";
import { savePlaylist, pickAndLoadPlaylist } from "./playlist-io.js";
import { FSA } from "./fs-access.js";
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
import { Queue as e } from "./queue.js"; import { Player as t, fadeOut as a, setMasterVolume as n } from "./player.js"; import { UI as r } from "./ui.js"; const left = document.getElementById("left-panel"), hint = document.getElementById("drop-hint"), queue = document.getElementById("queue"), addBtn = document.getElementById("add-btn"), shBtn = document.getElementById("shuffle-btn"), volInp = document.getElementById("volume"), play = document.getElementById("play-btn"), next = document.getElementById("next-btn"), pause = document.getElementById("pause-btn"), stop = document.getElementById("stop-btn"), autoBtn = document.getElementById("stop-end-btn"), audioRE = /\.(mp3|wav|ogg|m4a|flac)$/i; let autoNext = !0; window.autoNext = autoNext; autoBtn.classList.toggle("active", autoNext); autoBtn.addEventListener("click", (() => { autoNext = !autoNext, window.autoNext = autoNext, autoBtn.classList.toggle("active", autoNext) })); const filesFrom = e => [...e].map((e => e.getAsFile?.() ?? e)).filter((e => e && (e.type.startsWith("audio/") || audioRE.test(e.name)))).map((e => (e._id = crypto.randomUUID(), e))), loadDur = e => new Promise((t => { if (e._dur) return t(); const n = new Audio; n.src = URL.createObjectURL(e), n.onloadedmetadata = () => { e._dur = n.duration, t() } })); async function add(t) { if (!t.length) return; const remaining = e.fillFilePlaceholders(t); if (remaining.length) e.add(remaining); await Promise.all(t.map(loadDur)); r.renderQueue(); } async function addFromHandles(handles) { const files = []; for (const h of handles) { if (!h) continue; if (h.kind === "directory") { const dirFiles = await FSA.readDirAudioFiles(h); if (!dirFiles.length) continue; const fsKey = await FSA.storeHandle(h); const folderItem = { _id: crypto.randomUUID(), name: h.name, _isFolder: !0, _files: dirFiles, _dur: null, type: "folder", _fsKey: fsKey, _dirHandle: h }; e.fillFolderPlaceholder(folderItem) || e.add([folderItem]); } else if (h.kind === "file") { try { const f = await h.getFile(); if (!(f.type.startsWith("audio/") || audioRE.test(f.name))) continue; f._id = crypto.randomUUID(); f._fsKey = await FSA.storeHandle(h); f._handle = h; files.push(f); } catch (_) { } } } if (files.length) await add(files); r.renderQueue(); } function openPicker() { if (FSA.supported()) { FSA.pickFiles().then(addFromHandles).catch(() => { }); return } const e = document.createElement("input"); e.type = "file", e.multiple = !0, e.accept = "audio/*", e.hidden = !0, document.body.append(e), e.onchange = () => { add(filesFrom(e.files)); e.remove() }, e.click() } const wantsFiles = e => [...e.types].includes("Files"); let dragCounter = 0; function onDragEnter(e) { wantsFiles(e.dataTransfer) && (dragCounter++, left.classList.add("dragover"), e.preventDefault()) } function onDragLeave(e) { wantsFiles(e.dataTransfer) && (dragCounter--, 0 === dragCounter && left.classList.remove("dragover")) } function onDragOver(e) { wantsFiles(e.dataTransfer) && (e.preventDefault(), e.dataTransfer.dropEffect = "copy") } function drop(e) { if (!wantsFiles(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); dragCounter = 0; left.classList.remove("dragover"); if (FSA.supported() && e.dataTransfer.items) { const ps = [...e.dataTransfer.items].filter(i => i.kind === "file" && i.getAsFileSystemHandle).map(i => i.getAsFileSystemHandle()); if (ps.length) { Promise.all(ps).then(hs => addFromHandles(hs.filter(Boolean))).catch(() => { }); return } } add(filesFrom(e.dataTransfer.items || e.dataTransfer.files)) } function onPlay() { const e = t.getCurrent(); if (!(e && e.currentSrc)) return t.playNext(), void r.renderQueue(); if (e.paused) { if (e.ended) { t.playNext(); r.renderQueue(); } else { e.play().catch(console.warn) } } else { a(e), t.playNext(), r.renderQueue() } } left.addEventListener("dragenter", onDragEnter, !0), left.addEventListener("dragover", onDragOver, !0), left.addEventListener("dragleave", onDragLeave, !0), left.addEventListener("drop", drop, !0), play.addEventListener("click", onPlay), next.addEventListener("click", (() => { const e = t.getCurrent(); e && !e.paused && a(e), t.playNext(), r.renderQueue() })), pause.addEventListener("click", (() => { const e = t.getCurrent(); e && (e.paused ? e.play().catch(console.warn) : e.pause()) })), stop.addEventListener("click", (() => { const e = t.getCurrent(); e && a(e).then((() => document.dispatchEvent(new CustomEvent("trackclear")))) })), volInp.addEventListener("input", (e => n(+e.target.value))), shBtn.addEventListener("click", (() => { e.shuffle(), r.renderQueue() })), addBtn.addEventListener("click", (e => { e.stopPropagation(), openPicker() })), left.addEventListener("click", (e => { e.target !== left && e.target !== hint || openPicker() })), document.addEventListener("trackchange", (e => { r.updateCurrent(e.detail.file, e.detail.duration), r.renderQueue() })), document.addEventListener("trackclear", (() => r.clearCurrent())), r.renderQueue(), r.tick(); initAudioOutput();

// --- Dossier & Mode Boucle ---
const addFolderBtn = document.getElementById('add-folder-btn');
const loopPlaylistBtn = document.getElementById('loop-playlist-btn');
const loopBtn = document.getElementById('loop-btn');

function openFolderPicker() {
    if (FSA.supported()) {
        FSA.pickDirectory().then(dir => addFromHandles([dir])).catch(() => { });
        return;
    }
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
            const folderItem = { _id: crypto.randomUUID(), name: folderName, _isFolder: true, _files: audioFiles, _dur: null, type: 'folder' };
            if (!e.fillFolderPlaceholder(folderItem)) e.add([folderItem]);
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

// --- Sauvegarde / chargement de la playlist (JSON) ---
const savePlaylistBtn = document.getElementById('save-playlist-btn');
const loadPlaylistBtn = document.getElementById('load-playlist-btn');

savePlaylistBtn.addEventListener('click', () => savePlaylist());
loadPlaylistBtn.addEventListener('click', () => pickAndLoadPlaylist(res => {
    setLoopMode(e.isLoop());
    r.renderQueue();
    let msg = "";
    if (!FSA.supported() && res.missing) {
        // Cas néophyte : navigateur sans rechargement automatique.
        msg = "✅ Playlist chargée — l'ordre et les réglages sont conservés.\n\n"
            + "⚠ Votre navigateur ne peut pas rouvrir vos fichiers tout seul.\n"
            + "Pour qu'ils se rechargent automatiquement la prochaine fois, utilise Google Chrome ou Microsoft Edge.\n\n"
            + "Pour l'instant : glissez à nouveau vos fichiers (ou votre dossier) dans la liste — ils reprendront leur place.";
    } else {
        const parts = [];
        if (res.needPermission) parts.push(`🔌 ${res.needPermission} élément(s) à reconnecter : clique le bouton 🔌 sur chacun pour autoriser l'accès (un dossier = une seule autorisation).`);
        if (res.missing) parts.push(`📂 ${res.missing} fichier(s) introuvable(s) sur cet ordinateur (playlist créée ailleurs) : glisse-les à nouveau dans la liste.`);
        if (parts.length) msg = "✅ Playlist chargée.\n\n" + parts.join("\n\n");
    }
    if (msg) alert(msg);
}));
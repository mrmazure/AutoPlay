/**
 * playlist-io.js — Sauvegarde / chargement de la playlist en JSON.
 *
 * Les flux/URL sont restaurés tels quels. Les fichiers/dossiers locaux sont
 * référencés par une clé de handle (fsKey) stockée dans IndexedDB via la
 * File System Access API : au chargement, on retrouve le handle et on
 * reconnecte le fichier réel après autorisation (cf. fs-access.js).
 *   - handle présent + autorisation déjà accordée → reconnecté automatiquement ;
 *   - handle présent mais autorisation à confirmer → élément « à reconnecter »
 *     (bouton 🔌) ;
 *   - pas de handle (vieux JSON / autre navigateur) → « à recharger »
 *     (re-dépôt manuel, l'ordre + les points de mix reviennent).
 */

import { Queue } from "./queue.js";
import { FSA } from "./fs-access.js";

const FORMAT = "RadioTools AutoPlay Playlist";

// ── Sauvegarde ──────────────────────────────────────────────────────────────

function serialize() {
    return {
        format: FORMAT,
        version: 2,
        savedAt: new Date().toISOString(),
        loop: Queue.isLoop(),
        items: Queue.all().map(it => {
            if (it._isUrl) {
                return { type: "url", name: it.name, url: it._url, mix: it._mix || null };
            }
            if (it._isFolder) {
                const mixByName = {};
                (it._files || []).forEach(f => { if (f._mix) mixByName[f.name] = f._mix; });
                return { type: "folder", name: it.name, count: (it._files || []).length, mixByName, fsKey: it._fsKey || null };
            }
            if (it._placeholder) {
                return it._kind === "folder"
                    ? { type: "folder", name: it.name, count: it._count || 0, mixByName: it._mixByName || {}, fsKey: it._fsKey || null }
                    : { type: "file", name: it.name, dur: it._dur || null, mix: it._mix || null, fsKey: it._fsKey || null };
            }
            return { type: "file", name: it.name, dur: it._dur || null, mix: it._mix || null, fsKey: it._fsKey || null };
        })
    };
}

export function savePlaylist() {
    const data = serialize();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `playlist-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Chargement ───────────────────────────────────────────────────────────────

// Reconstruit un élément jouable à partir d'un handle déjà autorisé.
async function resolveFromHandle(handle, meta) {
    if (meta.kind === "folder") {
        const files = await FSA.readDirAudioFiles(handle);
        const mixByName = meta.mixByName || {};
        files.forEach(f => { if (mixByName[f.name]) f._mix = mixByName[f.name]; });
        return { _id: crypto.randomUUID(), name: meta.name, _isFolder: true, _files: files, _dur: null, type: "folder", _fsKey: meta.fsKey, _dirHandle: handle };
    }
    const f = await handle.getFile();
    f._id = crypto.randomUUID();
    f._fsKey = meta.fsKey;
    f._handle = handle;
    if (meta.dur) f._dur = meta.dur;
    if (meta.mix) f._mix = meta.mix;
    return f;
}

function urlItem(e) {
    return { _id: crypto.randomUUID(), name: e.name, _url: e.url, _isUrl: true, _dur: null, type: "audio/mpeg", _mix: e.mix || undefined };
}
function pendingItem(e, handle) {
    // Élément en attente d'autorisation (handle disponible) ou à recharger.
    const base = { _id: crypto.randomUUID(), _placeholder: true, name: e.name };
    if (e.type === "folder") Object.assign(base, { _kind: "folder", _count: e.count || 0, _mixByName: e.mixByName || {}, _fsKey: e.fsKey || null });
    else Object.assign(base, { _kind: "file", _dur: e.dur || null, _mix: e.mix || null, _fsKey: e.fsKey || null });
    if (handle) { base._handle = handle; base._needsPermission = true; }
    return base;
}

export async function loadPlaylistText(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.items)) throw new Error("Format de playlist invalide");

    const items = [];
    for (const e of data.items) {
        if (e.type === "url") { items.push(urlItem(e)); continue; }

        // Fichier / dossier : tenter de retrouver le handle
        let handle = null;
        if (e.fsKey && FSA.supported()) handle = await FSA.getHandle(e.fsKey);

        if (handle && await FSA.hasPermission(handle)) {
            // Autorisation déjà accordée → reconnexion immédiate
            try {
                items.push(await resolveFromHandle(handle, { kind: e.type, name: e.name, dur: e.dur, mix: e.mix, mixByName: e.mixByName, fsKey: e.fsKey }));
                continue;
            } catch (_) { /* échec lecture → on retombe en attente */ }
        }
        items.push(pendingItem(e, handle)); // handle présent → 🔌 ; sinon → à recharger
    }

    Queue.set(items);
    Queue.setLoop(!!data.loop);

    return {
        loop: !!data.loop,
        total: items.length,
        needPermission: items.filter(it => it._needsPermission).length,
        missing: items.filter(it => it._placeholder && !it._needsPermission).length
    };
}

// Reconnecte un élément « 🔌 » (handle présent) : demande l'autorisation puis
// remplace l'emplacement par l'élément jouable réel. À appeler depuis un clic.
export async function reconnectItem(idx) {
    const it = Queue.all()[idx];
    if (!it || !it._needsPermission || !it._handle) return false;
    if (!(await FSA.requestPermission(it._handle))) return false;
    try {
        const resolved = await resolveFromHandle(it._handle, {
            kind: it._kind === "folder" ? "folder" : "file",
            name: it.name, dur: it._dur, mix: it._mix, mixByName: it._mixByName, fsKey: it._fsKey
        });
        Queue.replaceAt(idx, resolved);
        return true;
    } catch (_) {
        return false;
    }
}

// Ouvre un sélecteur .json et charge la playlist.
export async function pickAndLoadPlaylist(onDone) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.hidden = true;
    document.body.appendChild(inp);
    inp.onchange = async () => {
        const file = inp.files[0];
        inp.remove();
        if (!file) return;
        try {
            const text = await file.text();
            const res = await loadPlaylistText(text);
            onDone?.(res);
        } catch (err) {
            alert("Impossible de charger la playlist : " + err.message);
        }
    };
    inp.click();
}

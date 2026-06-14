/**
 * fs-access.js — File System Access API + persistance des handles (IndexedDB).
 *
 * Permet de retrouver les fichiers/dossiers réels d'une session à l'autre :
 * on garde des « handles » (poignées) dans IndexedDB. Au chargement d'une
 * playlist, on récupère le handle par sa clé, on (re)demande l'autorisation de
 * lecture, puis on lit le fichier. Chromium uniquement (Chrome/Edge).
 */

const DB_NAME = "autoplay-fs";
const STORE = "handles";
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac)$/i;

let dbPromise = null;
function db() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}
async function idbSet(key, val) {
    const d = await db();
    return new Promise((res, rej) => {
        const tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    });
}
async function idbGet(key) {
    const d = await db();
    return new Promise((res, rej) => {
        const tx = d.transaction(STORE, "readonly");
        const rq = tx.objectStore(STORE).get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => rej(rq.error);
    });
}

export const FSA = {
    supported: () => typeof window !== "undefined" && "showOpenFilePicker" in window,

    // Stocke un handle dans IndexedDB, renvoie sa clé (UUID).
    async storeHandle(handle) {
        const key = crypto.randomUUID();
        try { await idbSet(key, handle); } catch (_) { return null; }
        return key;
    },
    getHandle: (key) => idbGet(key).catch(() => null),

    // Autorisation de lecture : vérifie, et demande si `request` (besoin d'un geste).
    async hasPermission(handle) {
        if (!handle) return false;
        try { return (await handle.queryPermission({ mode: "read" })) === "granted"; }
        catch (_) { return false; }
    },
    async requestPermission(handle) {
        if (!handle) return false;
        try { return (await handle.requestPermission({ mode: "read" })) === "granted"; }
        catch (_) { return false; }
    },

    async pickFiles() {
        return await window.showOpenFilePicker({
            multiple: true,
            types: [{
                description: "Audio",
                accept: {
                    "audio/mpeg": [".mp3"],
                    "audio/wav": [".wav", ".wave"],
                    "audio/ogg": [".ogg"],
                    "audio/mp4": [".m4a"],
                    "audio/flac": [".flac"],
                    "audio/x-flac": [".flac"]
                }
            }]
        });
    },
    pickDirectory() { return window.showDirectoryPicker(); },

    // Lit les fichiers audio (1er niveau) d'un dossier → tableau de File.
    async readDirAudioFiles(dirHandle) {
        const files = [];
        for await (const [name, h] of dirHandle.entries()) {
            if (h.kind === "file" && AUDIO_RE.test(name)) {
                try { files.push(await h.getFile()); } catch (_) {}
            }
        }
        return files;
    }
};

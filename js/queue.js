export const Queue = (() => {
    let items = [];
    let loopMode = false;

    // Pré-tire un fichier aléatoire dans un dossier (sans le consommer).
    const pickFrom = (folder) => {
        const files = folder._files;
        if (!files || !files.length) return null;
        return files[Math.floor(Math.random() * files.length)];
    };

    return {
        add(list) { items.push(...list); },
        next() {
            if (!items.length) return null;
            const item = items[0];
            // Emplacement non rempli (fichier manquant) : on le saute.
            if (item._placeholder) { items.shift(); return this.next(); }
            if (item._isFolder) {
                if (!item._files.length) { items.shift(); return this.next(); }
                // Le fichier a été pré-tiré à l'avance (cf. ensurePicks) pour que
                // l'éditeur de mix puisse l'éditer ; repli si jamais absent.
                const file = item._picked || pickFrom(item);
                items.shift();
                if (loopMode) {
                    // Re-tirage : le prochain passage du dossier jouera un autre titre.
                    item._picked = pickFrom(item);
                    items.push(item);
                } else {
                    item._picked = null;
                }
                return file;
            }
            const picked = items.shift();
            if (loopMode) items.push(picked);
            return picked;
        },
        peek: () => items[0] || null,
        all: () => items,
        remove(idx) { items.splice(idx, 1); },
        replaceAt(idx, item) { if (idx >= 0 && idx < items.length) items[idx] = item; },
        // Duplique l'item à l'index idx (copie insérée juste après).
        duplicate(idx) {
            const it = items[idx];
            if (!it) return;
            let dup;
            if (it._isFolder) {
                // Partage la liste de fichiers ; nouveau tirage indépendant.
                dup = { _id: crypto.randomUUID(), name: it.name, _isFolder: true, _files: it._files, _dur: null, type: "folder", _picked: null };
            } else if (it._isUrl) {
                dup = { _id: crypto.randomUUID(), name: it.name, _url: it._url, _isUrl: true, type: it.type, _dur: it._dur || null };
                if (it._mix) dup._mix = { ...it._mix };
            } else if (it._placeholder) {
                dup = { ...it, _id: crypto.randomUUID() };
                if (it._mix) dup._mix = { ...it._mix };
                if (it._mixByName) dup._mixByName = { ...it._mixByName };
            } else {
                // Fichier/Blob : slice() partage les données (pas de copie mémoire).
                dup = it.slice(0, it.size, it.type);
                dup.name = it.name;
                dup._id = crypto.randomUUID();
                dup._dur = it._dur;
                if (it._mix) dup._mix = { ...it._mix };
                if (it._wave) dup._wave = it._wave;
            }
            items.splice(idx + 1, 0, dup);
        },
        set(list) { items = list.filter(Boolean); },
        // Garantit que chaque dossier en file a un fichier pré-tiré (_picked).
        ensurePicks() {
            items.forEach(it => {
                if (it._isFolder && it._files?.length && !it._picked) it._picked = pickFrom(it);
            });
        },
        // Re-tire le fichier d'un dossier (utilisé pour rafraîchir manuellement).
        repick(folder) {
            if (folder && folder._isFolder) folder._picked = pickFrom(folder);
        },
        // Remplit les emplacements « fichier » par les fichiers re-déposés (même nom),
        // en conservant leur position et leurs points de mix. Renvoie les fichiers
        // restants (sans emplacement correspondant), à ajouter normalement.
        fillFilePlaceholders(files) {
            const remaining = [];
            files.forEach(f => {
                const idx = items.findIndex(it => it._placeholder && it._kind === "file" && it.name === f.name);
                if (idx >= 0) {
                    const ph = items[idx];
                    if (ph._mix) f._mix = ph._mix;
                    if (ph._dur && !f._dur) f._dur = ph._dur;
                    items[idx] = f;
                } else {
                    remaining.push(f);
                }
            });
            return remaining;
        },
        // Remplit un emplacement « dossier » (même nom) par le dossier re-déposé,
        // en réappliquant les points de mix mémorisés aux fichiers correspondants.
        fillFolderPlaceholder(folderItem) {
            const idx = items.findIndex(it => it._placeholder && it._kind === "folder" && it.name === folderItem.name);
            if (idx < 0) return false;
            const mixByName = items[idx]._mixByName || {};
            (folderItem._files || []).forEach(f => { if (mixByName[f.name]) f._mix = mixByName[f.name]; });
            items[idx] = folderItem;
            return true;
        },
        shuffle() {
            for (let i = items.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [items[i], items[j]] = [items[j], items[i]];
            }
        },
        setLoop(v) { loopMode = v; },
        isLoop() { return loopMode; }
    };
})();

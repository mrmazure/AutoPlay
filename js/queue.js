export const Queue = (() => {
    let items = [];
    let loopMode = false;
    return {
        add(list) { items.push(...list); },
        next() {
            if (!items.length) return null;
            const item = items[0];
            if (item._isFolder) {
                const files = item._files;
                if (!files.length) { items.shift(); return this.next(); }
                const file = files[Math.floor(Math.random() * files.length)];
                items.shift();
                if (loopMode) items.push(item);
                return file;
            }
            const picked = items.shift();
            if (loopMode) items.push(picked);
            return picked;
        },
        peek: () => items[0] || null,
        all: () => items,
        remove(idx) { items.splice(idx, 1); },
        set(list) { items = list.filter(Boolean); },
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

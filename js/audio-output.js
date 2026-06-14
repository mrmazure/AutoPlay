/**
 * RadioBox – AutoPlay | audio-output.js
 * Sélection des cartes son de sortie.
 *  - rôle « main »    : sortie de l'automate (antenne)
 *  - rôle « preview » : sortie de pré-écoute (PFL), distincte de l'antenne
 * Inspiré de la méthode CartWall (FONCTIONNE/app.js).
 * Fonctionne sur Chrome (via AudioContext.setSinkId) et Firefox (via selectAudioOutput).
 */

import { applyAudioOutput, applyPreviewOutput } from './player.js';

/* ── Définition des deux rôles ─────────────────────────────── */

const ROLES = {
    main: {
        btnId:        'audioOutputBtn',
        storeKey:     'audioOutputDeviceId',
        labelKey:     'audioOutputLabel',
        emoji:        '🔊',
        emptyLabel:   'Par défaut',
        title:        "Choisir la carte son de sortie de l'automate",
        apply:        applyAudioOutput,
    },
    preview: {
        btnId:        'previewOutputBtn',
        storeKey:     'previewOutputDeviceId',
        labelKey:     'previewOutputLabel',
        emoji:        '🎧',
        emptyLabel:   'Par défaut',
        title:        'Choisir la carte son de pré-écoute (PFL)',
        apply:        applyPreviewOutput,
    },
};

// État courant par rôle
const state = {};
for (const role of Object.keys(ROLES)) {
    const cfg = ROLES[role];
    state[role] = {
        deviceId: localStorage.getItem(cfg.storeKey) || 'default',
        label:    localStorage.getItem(cfg.labelKey) || '',
    };
}

/* ── Enumerate outputs ─────────────────────────────────────── */

async function enumerateOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audiooutput');
}

/* ── Apply a device ────────────────────────────────────────── */

async function applyDevice(role, deviceId, label) {
    const cfg = ROLES[role];
    state[role].deviceId = deviceId;
    state[role].label    = label || '';
    localStorage.setItem(cfg.storeKey, deviceId);
    localStorage.setItem(cfg.labelKey, state[role].label);
    await cfg.apply(deviceId);
    updateBtnLabel(role);
}

/* ── Update button label ───────────────────────────────────── */

function updateBtnLabel(role) {
    const cfg = ROLES[role];
    const btn = document.getElementById(cfg.btnId);
    if (!btn) return;
    const short = state[role].label
        ? state[role].label.replace(/\s*\(.*\)\s*$/, '').trim()
        : '';
    btn.textContent = short ? `${cfg.emoji} ${short}` : `${cfg.emoji} ${cfg.emptyLabel}`;
    btn.title = state[role].label || cfg.title;
}

/* ── Populate panel ────────────────────────────────────────── */

async function populateAudioOutputPanel(role, panel, anchorBtn) {
    panel.innerHTML = '<div class="aop-msg">Détection des cartes son…</div>';

    const outputs = await enumerateOutputs();
    panel.innerHTML = '';

    // Classify
    const defaultDev = outputs.find(d => d.deviceId === 'default');
    const commDev    = outputs.find(d => d.deviceId === 'communications');
    const others       = outputs.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
    const hasUnlabelled = others.length === 0 || others.some(d => !d.label);

    // Build ordered list
    const list = [
        { deviceId: 'default', label: defaultDev?.label || 'Sortie par défaut du système' },
    ];
    let unnamed = 0;
    others.forEach(d => {
        unnamed++;
        list.push({ deviceId: d.deviceId, label: d.label || `Sortie audio ${unnamed}` });
    });
    if (commDev) list.push({ deviceId: 'communications', label: commDev.label || 'Sortie de communication' });

    list.forEach(dev => {
        const isActive = dev.deviceId === state[role].deviceId;
        const item = document.createElement('div');
        item.className = 'aop-item' + (isActive ? ' aop-active' : '');
        item.title = dev.label;
        item.innerHTML = `<span class="aop-check">${isActive ? '✓' : ''}</span><span class="aop-label">${dev.label}</span>`;
        item.addEventListener('click', async () => {
            await applyDevice(role, dev.deviceId, dev.label);
            panel.remove();
        });
        panel.appendChild(item);
    });

    const sep = document.createElement('div');
    sep.className = 'aop-sep';
    panel.appendChild(sep);

    if (navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function') {
        // Firefox / navigateur avec selectAudioOutput natif
        const btnBrowse = document.createElement('div');
        btnBrowse.className = 'aop-item aop-unlock';
        btnBrowse.innerHTML = '<span class="aop-check">🔊</span><span class="aop-label">Parcourir les cartes son de sortie…</span>';
        btnBrowse.title = 'Ouvre le sélecteur natif du navigateur';
        btnBrowse.addEventListener('click', async e => {
            e.stopPropagation();
            try {
                const device = await navigator.mediaDevices.selectAudioOutput();
                await applyDevice(role, device.deviceId, device.label);
                panel.remove();
                openAudioOutputPanel(role, anchorBtn);
            } catch (_) { /* annulé */ }
        });
        panel.appendChild(btnBrowse);
    } else if (hasUnlabelled) {
        // Chrome : technique getUserMedia pour révéler les noms des périphériques
        // Affiché uniquement si les vrais labels ne sont pas encore disponibles.
        // Le stream est coupé immédiatement — le micro n'est pas utilisé pour la lecture
        const btnUnlock = document.createElement('div');
        btnUnlock.className = 'aop-item aop-unlock';
        btnUnlock.innerHTML = '<span class="aop-check">🔓</span><span class="aop-label">Autoriser pour voir les autres cartes son</span>';
        btnUnlock.title = 'Requiert une autorisation momentanée — le micro ne sera pas utilisé';
        btnUnlock.addEventListener('click', async e => {
            e.stopPropagation();
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
                panel.remove();
                openAudioOutputPanel(role, anchorBtn); // ré-ouvre avec les vrais noms
            } catch (_) {
                const errNote = document.createElement('div');
                errNote.className = 'aop-msg';
                errNote.textContent = "⚠ Permission refusée — impossible d'afficher les vrais noms.";
                btnUnlock.replaceWith(errNote);
            }
        });
        panel.appendChild(btnUnlock);
    }
}

/* ── Open / close panel ────────────────────────────────────── */

async function openAudioOutputPanel(role, anchorBtn) {
    const panelId = `audioOutputPanel-${role}`;
    const existing = document.getElementById(panelId);
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'audio-output-panel';
    document.body.appendChild(panel);

    // Positionnement sous le bouton, aligné à droite
    const rect = anchorBtn.getBoundingClientRect();
    panel.style.top   = (rect.bottom + 6) + 'px';
    panel.style.right = (window.innerWidth - rect.right) + 'px';

    await populateAudioOutputPanel(role, panel, anchorBtn);

    // Fermeture au clic extérieur
    setTimeout(() => {
        document.addEventListener('click', function outsideClick(e) {
            if (!panel.isConnected) { document.removeEventListener('click', outsideClick); return; }
            if (!panel.contains(e.target) && e.target !== anchorBtn) {
                panel.remove();
                document.removeEventListener('click', outsideClick);
            }
        });
    }, 0);
}

/* ── Init ──────────────────────────────────────────────────── */

function initRole(role) {
    const cfg = ROLES[role];
    const btn = document.getElementById(cfg.btnId);
    if (!btn) return;

    updateBtnLabel(role);

    btn.addEventListener('click', e => {
        e.stopPropagation();
        openAudioOutputPanel(role, btn);
    });

    // Pré-applique le device sauvegardé (mémorisé si le contexte audio n'est pas encore créé)
    if (state[role].deviceId && state[role].deviceId !== 'default') {
        cfg.apply(state[role].deviceId).catch(() => {});
    }
}

export function initAudioOutput() {
    initRole('main');
    initRole('preview');
}

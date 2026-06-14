// Contexte de décodage partagé (évite de créer un AudioContext par appel).
let decodeCtx = null;
const getDecodeCtx = () => (decodeCtx ||= new (window.AudioContext || window.webkitAudioContext)());

export const Waveform = {
    async generate(audioBlob, samples = 1000) {
        if (!audioBlob) return null;
        try {
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioContext = getDecodeCtx();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            const rawData = audioBuffer.getChannelData(0); // Use first channel
            const blockSize = Math.floor(rawData.length / samples);
            const data = new Float32Array(samples);

            for (let i = 0; i < samples; i++) {
                let sum = 0;
                for (let j = 0; j < blockSize; j++) {
                    sum += Math.abs(rawData[blockSize * i + j]);
                }
                data[i] = sum / blockSize;
            }

            // Normalize
            const max = Math.max(...data);
            const normalized = max > 0 ? data.map(v => v / max) : data;

            return normalized;
        } catch (e) {
            console.error("Waveform generation failed", e);
            return null;
        }
    },

    // Génère puis met en cache la forme d'onde sur l'objet fichier (file._wave).
    async getCached(file, samples = 800) {
        if (!file || file._isUrl) return null;
        if (file._wave) return file._wave;
        const wave = await this.generate(file, samples);
        if (wave) file._wave = wave;
        return wave;
    }
};

/**
 * Détecte le début du fondu de sortie en fin de piste (logique segue radio).
 * Renvoie une position en ratio 0-1 de la piste.
 *  - Gère les fins « nettes » (coupure franche) : place le repère à la vraie fin.
 *  - Sinon cherche un vrai fondu dans les 35 derniers %.
 *  - Repli : ~0.93 (≈ 4 s avant la fin d'une piste de 3:30).
 */
export function detectFadeOutCue(waveform) {
    const n = waveform.length;

    const bodyStart = Math.floor(n * 0.10);
    const bodyEnd = Math.floor(n * 0.60);
    let bodySum = 0;
    for (let i = bodyStart; i < bodyEnd; i++) bodySum += waveform[i];
    const bodyAvg = bodySum / (bodyEnd - bodyStart);

    const FADE_THRESHOLD = bodyAvg * 0.40; // 40 % de la sonie normale
    const SUSTAIN = Math.max(8, Math.floor(n * 0.010));

    const SILENCE = bodyAvg * 0.10;
    let audioEnd = n - 1;
    while (audioEnd > bodyEnd && waveform[audioEnd] < SILENCE) audioEnd--;

    // 1. Fin nette : encore à plein niveau juste avant la fin → laisser jouer.
    const tailWin = Math.max(SUSTAIN, Math.floor(n * 0.02));
    let tailLoud = 0;
    for (let i = Math.max(bodyEnd, audioEnd - tailWin + 1); i <= audioEnd; i++) {
        if (waveform[i] >= FADE_THRESHOLD) tailLoud++;
    }
    if (tailLoud >= tailWin * 0.6) {
        return Math.min(0.999, Math.max(0.80, (audioEnd + 1) / n));
    }

    // 2. Détection du fondu : uniquement dans les 35 derniers %.
    const searchStart = Math.floor(n * 0.65);
    let lastLoud = -1;
    for (let i = audioEnd; i >= searchStart; i--) {
        if (waveform[i] >= FADE_THRESHOLD) { lastLoud = i; break; }
    }
    if (lastLoud === -1) return 0.93;

    for (let i = lastLoud; i <= n - SUSTAIN; i++) {
        let quiet = true;
        for (let j = 0; j < SUSTAIN; j++) {
            if (waveform[i + j] >= FADE_THRESHOLD) { quiet = false; break; }
        }
        if (quiet) return Math.max(0.80, i / n);
    }

    return 0.93;
}

/**
 * Détecte la fin de l'intro (entrée du chant / du corps du morceau).
 * Renvoie une position en ratio 0-1 de la piste — l'appelant la convertit en
 * secondes. Heuristique : on ignore le silence de tête, puis on cherche la
 * première zone soutenue au-dessus d'un seuil dans les 45 premiers %.
 */
export function detectIntroCue(waveform) {
    const n = waveform.length;
    const bodyStart = Math.floor(n * 0.10);
    const bodyEnd = Math.floor(n * 0.60);
    let sum = 0;
    for (let i = bodyStart; i < bodyEnd; i++) sum += waveform[i];
    const bodyAvg = sum / (bodyEnd - bodyStart);

    const THRESH = bodyAvg * 0.55;
    const SILENCE = bodyAvg * 0.10;
    const SUSTAIN = Math.max(6, Math.floor(n * 0.010));

    let start = 0;
    while (start < bodyEnd && waveform[start] < SILENCE) start++;

    const limit = Math.floor(n * 0.45);
    for (let i = start; i < limit - SUSTAIN; i++) {
        let loud = true;
        for (let j = 0; j < SUSTAIN; j++) {
            if (waveform[i + j] < THRESH) { loud = false; break; }
        }
        if (loud) return Math.min(0.45, Math.max(0, i / n));
    }
    return Math.min(0.10, (start + SUSTAIN) / n);
}

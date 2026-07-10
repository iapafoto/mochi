// AudioWorklet : micro → PCM 16 bits mono @ 16 kHz, posté par paquets ~100 ms.
//
// Tourne dans l'AudioWorkletGlobalScope (pas d'import possible). `sampleRate`
// (débit réel du contexte, souvent 48 kHz) y est une globale. On rééchantillonne
// vers 16 kHz par interpolation linéaire (assez pour de la voix), on convertit en
// Int16 little-endian, et on regroupe en blocs pour limiter le trafic de messages.
//
// Chargé par mic.ts via `audioWorklet.addModule(new URL(...))`. Fichier .js
// volontaire (pas de .ts) : il est servi tel quel par Vite, sans transform.

const TARGET_RATE = 16000;
const FLUSH_SAMPLES = 640; // ~40 ms @ 16 kHz — paquets courts = moins de latence d'entrée

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this._pos = 0; // position de lecture fractionnaire, reportée d'un bloc à l'autre
    this._step = sampleRate / TARGET_RATE; // pas de rééchantillonnage (>= 1 en pratique)
    this._acc = new Int16Array(FLUSH_SAMPLES);
    this._n = 0; // remplissage courant de _acc
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true; // pas d'entrée ce tour

    const N = ch.length;
    let pos = this._pos;
    while (pos < N) {
      const i = pos | 0;
      const frac = pos - i;
      const a = ch[i];
      const b = i + 1 < N ? ch[i + 1] : ch[N - 1];
      let s = a + (b - a) * frac; // interpolation linéaire
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._acc[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._n >= this._acc.length) {
        const out = this._acc.slice(0, this._n); // copie → buffer transférable
        this.port.postMessage(out, [out.buffer]);
        this._n = 0;
      }
      pos += this._step;
    }
    this._pos = pos - N; // conserve la phase fractionnaire pour le bloc suivant
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);

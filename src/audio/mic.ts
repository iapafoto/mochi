// Capture micro → PCM 16 kHz mono (Int16), poussé par paquets ~100 ms en base64.
//
// getUserMedia (avec annulation d'écho) → AudioContext 16 kHz → AudioWorklet
// (pcm-recorder). AUCUNE dépendance à Gemini : ce module ne sait qu'émettre des
// chunks. C'est LiveConversation qui les envoie à la session.
//
// `echoCancellation` retire une partie de la voix de Mochi captée par le micro ;
// en complément, LiveConversation coupe l'envoi pendant que Mochi parle
// (anti-larsen : voix + moteurs dans le micro, cf. PLAN M5).

const WORKLET_URL = new URL('./pcm-recorder.worklet.js', import.meta.url);

export interface MicCallbacks {
  /** Un paquet PCM 16 bits @ 16 kHz, encodé base64, prêt à envoyer. */
  onChunk(base64Pcm16: string): void;
  onError(message: string): void;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _active = false;
  private _sending = true;

  constructor(private readonly cb: MicCallbacks) {}

  get active(): boolean {
    return this._active;
  }

  /** Coupe/rétablit l'envoi des paquets (le micro tourne, on jette juste). */
  setSending(on: boolean): void {
    this._sending = on;
  }

  async start(): Promise<boolean> {
    if (this._active) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.cb.onError(`micro refusé : ${(err as Error).message}`);
      return false;
    }

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // On demande 16 kHz ; si le navigateur impose un autre débit, le worklet
    // rééchantillonne quand même (il lit le `sampleRate` réel).
    this.ctx = new Ctor({ sampleRate: 16000, latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      this.cb.onError(`worklet audio indisponible : ${(err as Error).message}`);
      await this.stop();
      return false;
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder');
    this.node.port.onmessage = (e) => {
      if (this._sending) this.cb.onChunk(int16ToBase64(e.data as Int16Array));
    };
    this.source.connect(this.node);
    // Le node doit être « tiré » par le graphe : on le relie à la sortie. Il
    // n'écrit rien dans ses buffers de sortie → silence (aucun larsen).
    this.node.connect(this.ctx.destination);
    this._active = true;
    return true;
  }

  async stop(): Promise<void> {
    this._active = false;
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** Int16Array → base64 (par tranches pour ne pas exploser la pile d'arguments). */
function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

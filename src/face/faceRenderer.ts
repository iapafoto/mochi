import fragSource from './face.frag?raw';
import type { FaceState, Channel } from './faceState';

const VERT = `#version 300 es
// Triangle plein écran (couvre le viewport sans buffer d'attributs).
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Uniforms scalaires = un par canal FaceState, nommés uXxx.
const CHANNEL_UNIFORMS: Record<Channel, string> = {
  eyelidL: 'uEyelidL',
  eyelidR: 'uEyelidR',
  gazeX: 'uGazeX',
  gazeY: 'uGazeY',
  pupil: 'uPupil',
  browRaiseL: 'uBrowL',
  browRaiseR: 'uBrowR',
  browFurrow: 'uFurrow',
  mouthOpen: 'uMouthOpen',
  mouthCurve: 'uMouthCurve',
  headTilt: 'uHeadTilt',
};

export class FaceRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly loc: Record<string, WebGLUniformLocation | null> = {};
  private readonly uRes: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;
  private readonly uAmbient: WebGLUniformLocation | null;
  private ambient: [number, number, number] = [0, 0, 0];
  private lastT = performance.now() / 1000;
  private running = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly face: FaceState,
  ) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 non disponible dans ce navigateur.');
    this.gl = gl;

    this.program = this.buildProgram(VERT, fragSource);
    gl.useProgram(this.program);

    for (const uni of Object.values(CHANNEL_UNIFORMS)) {
      this.loc[uni] = gl.getUniformLocation(this.program, uni);
    }
    this.uRes = gl.getUniformLocation(this.program, 'uRes');
    this.uTime = gl.getUniformLocation(this.program, 'uTime');
    this.uAmbient = gl.getUniformLocation(this.program, 'uAmbient');

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now() / 1000;
    requestAnimationFrame(this.frame);
  }

  /** Teinte d'ambiance (RGB 0..1) pilotée par l'humeur. */
  setAmbient(rgb: [number, number, number]): void {
    this.ambient = rgb;
  }

  private frame = (): void => {
    if (!this.running) return;
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - this.lastT); // borne les gros écarts (onglet inactif)
    this.lastT = now;

    this.face.step(dt);
    this.render(now);
    requestAnimationFrame(this.frame);
  };

  private render(time: number): void {
    const gl = this.gl;
    const cur = this.face.current;
    for (const key of Object.keys(CHANNEL_UNIFORMS) as Channel[]) {
      gl.uniform1f(this.loc[CHANNEL_UNIFORMS[key]] ?? null, cur[key]);
    }
    gl.uniform2f(this.uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uTime, time);
    gl.uniform3f(this.uAmbient, this.ambient[0], this.ambient[1], this.ambient[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  private buildProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vert = this.compile(gl.VERTEX_SHADER, vertSrc);
    const frag = this.compile(gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram a échoué.');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Link programme : ' + gl.getProgramInfoLog(program));
    }
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return program;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader a échoué.');
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Compilation shader : ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }
}

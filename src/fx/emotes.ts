// Couche d'emotes — petites particules expressives (cœurs, étoiles, goutte…)
// dessinées sur un canvas 2D transparent AU-DESSUS du visage WebGL. Découplé du
// shader : on ajoute/retire des emotes sans toucher au rendu du visage.
//
// La boucle d'animation ne tourne QUE quand il y a des particules (repos = 0 CPU).

export type EmoteKind =
  | 'hearts'
  | 'sparkles'
  | 'notes'
  | 'sweat'
  | 'question'
  | 'exclaim'
  | 'rain';

export const EMOTE_KINDS: EmoteKind[] = [
  'hearts',
  'sparkles',
  'notes',
  'sweat',
  'question',
  'exclaim',
  'rain',
];

interface Particle {
  kind: EmoteKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ay: number; // accélération verticale (flottaison / gravité)
  life: number;
  ttl: number;
  size: number;
  rot: number;
  vrot: number;
  sway: number; // amplitude d'oscillation horizontale (px/s)
  phase: number;
  color: string;
}

const COUNT: Record<EmoteKind, number> = {
  hearts: 6,
  sparkles: 10,
  notes: 5,
  sweat: 1,
  question: 1,
  exclaim: 1,
  rain: 9,
};

export class EmoteLayer {
  private readonly ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private raf = 0;
  private lastT = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponible pour les emotes.');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Fait apparaître une bouffée d'emotes du type donné. */
  spawn(kind: EmoteKind, count = COUNT[kind] ?? 5): void {
    for (let i = 0; i < count; i++) this.particles.push(this.make(kind));
    this.ensureLoop();
  }

  private make(kind: EmoteKind): Particle {
    const cx = this.w * 0.5;
    const cy = this.h * 0.48; // centre du visage
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const base: Particle = {
      kind,
      x: cx,
      y: cy,
      vx: 0,
      vy: 0,
      ay: 0,
      life: 0,
      ttl: 1.4,
      size: 30,
      rot: 0,
      vrot: 0,
      sway: 0,
      phase: Math.random() * Math.PI * 2,
      color: '#ff6fb0',
    };

    switch (kind) {
      case 'hearts':
        return {
          ...base,
          x: cx + rnd(-70, 70),
          y: cy + rnd(-10, 40),
          vy: rnd(-120, -75),
          ay: 45, // décélère la montée
          ttl: rnd(1.4, 1.9),
          size: rnd(24, 42),
          rot: rnd(-0.3, 0.3),
          sway: rnd(12, 26),
          color: Math.random() < 0.5 ? '#ff6fb0' : '#ff9ad2',
        };
      case 'sparkles':
        return {
          ...base,
          x: cx + rnd(-140, 140),
          y: cy + rnd(-110, 60),
          vy: rnd(-45, -10),
          ttl: rnd(0.8, 1.3),
          size: rnd(12, 26),
          vrot: rnd(-3, 3),
          sway: rnd(4, 12),
          color: Math.random() < 0.5 ? '#ffe08a' : '#fff3c4',
        };
      case 'notes':
        return {
          ...base,
          x: cx + rnd(-40, 90),
          y: cy + rnd(-20, 20),
          vx: rnd(10, 45),
          vy: rnd(-90, -55),
          ay: 20,
          ttl: rnd(1.5, 2.1),
          size: rnd(24, 36),
          rot: rnd(-0.2, 0.2),
          sway: rnd(10, 22),
          color: '#c3adff',
        };
      case 'sweat':
        return {
          ...base,
          x: cx + rnd(150, 200),
          y: cy - rnd(120, 150),
          vy: rnd(60, 100),
          ay: 260,
          ttl: 0.9,
          size: rnd(26, 34),
          color: '#8fd4ff',
        };
      case 'question':
      case 'exclaim':
        return {
          ...base,
          x: cx + rnd(-30, 30),
          y: cy - this.h * 0.16,
          vy: rnd(-30, -14),
          ay: 30,
          ttl: 1.25,
          size: rnd(44, 56),
          rot: rnd(-0.12, 0.12),
          color: kind === 'exclaim' ? '#ffd36f' : '#8fd4ff',
        };
      case 'rain':
        return {
          ...base,
          x: cx + rnd(-120, 120),
          y: cy - this.h * 0.2 + rnd(-20, 20),
          vy: rnd(120, 200),
          ay: 120,
          ttl: rnd(0.9, 1.3),
          size: rnd(14, 22),
          color: '#7fb8ef',
        };
    }
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
  }

  private ensureLoop(): void {
    if (this.raf) return;
    this.lastT = performance.now() / 1000;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - this.lastT);
    this.lastT = now;

    for (const p of this.particles) {
      p.life += dt;
      p.vy += p.ay * dt;
      const swayX = Math.sin((p.life + p.phase) * 3.2) * p.sway;
      p.x += (p.vx + swayX) * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.ttl);

    this.draw();

    if (this.particles.length > 0) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.raf = 0; // repos : on arrête la boucle
    }
  };

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    for (const p of this.particles) {
      const t = p.life / p.ttl;
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85; // fade in rapide, out doux
      const pop = t < 0.2 ? 0.6 + 0.4 * (t / 0.2) : 1; // petit « pop » d'apparition
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.kind === 'question' || p.kind === 'exclaim') {
        ctx.font = `700 ${p.size * pop}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.kind === 'exclaim' ? '!' : '?', 0, 0);
      } else {
        const s = p.size * pop;
        ctx.scale(s, s);
        drawShape(ctx, p.kind);
      }
      ctx.restore();
    }
  }
}

/** Formes unitaires (~[-0.6, 0.6]) ; l'échelle px est faite par l'appelant. */
function drawShape(ctx: CanvasRenderingContext2D, kind: EmoteKind): void {
  switch (kind) {
    case 'hearts': {
      ctx.beginPath();
      ctx.moveTo(0, -0.1);
      ctx.bezierCurveTo(0, -0.35, -0.5, -0.35, -0.5, -0.05);
      ctx.bezierCurveTo(-0.5, 0.2, -0.2, 0.35, 0, 0.5);
      ctx.bezierCurveTo(0.2, 0.35, 0.5, 0.2, 0.5, -0.05);
      ctx.bezierCurveTo(0.5, -0.35, 0, -0.35, 0, -0.1);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'sparkles': {
      // Étoile fine à 4 branches.
      ctx.beginPath();
      const outer = 0.55;
      const inner = 0.12;
      for (let i = 0; i < 8; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const ang = (Math.PI / 4) * i - Math.PI / 2;
        const x = Math.cos(ang) * r;
        const y = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'notes': {
      // Tête de note + hampe.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(-0.12, 0.32, 0.26, 0.19, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(0.1, -0.5, 0.09, 0.85); // hampe
      ctx.restore();
      return;
    }
    case 'sweat':
    case 'rain': {
      // Goutte (pointe en haut).
      ctx.beginPath();
      ctx.moveTo(0, -0.5);
      ctx.bezierCurveTo(0.4, -0.05, 0.34, 0.5, 0, 0.5);
      ctx.bezierCurveTo(-0.34, 0.5, -0.4, -0.05, 0, -0.5);
      ctx.closePath();
      ctx.fill();
      return;
    }
  }
}

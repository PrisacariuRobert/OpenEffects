export type EaseFn = (p: number) => number;

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

function bounceOut(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

const families: Record<string, { in: EaseFn; out: EaseFn; inOut: EaseFn }> = {
  Sine: {
    in: (x) => 1 - Math.cos((x * Math.PI) / 2),
    out: (x) => Math.sin((x * Math.PI) / 2),
    inOut: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  },
  Quad: {
    in: (x) => x * x,
    out: (x) => 1 - (1 - x) * (1 - x),
    inOut: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  },
  Cubic: {
    in: (x) => x * x * x,
    out: (x) => 1 - Math.pow(1 - x, 3),
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  },
  Quart: {
    in: (x) => x ** 4,
    out: (x) => 1 - Math.pow(1 - x, 4),
    inOut: (x) => (x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2),
  },
  Quint: {
    in: (x) => x ** 5,
    out: (x) => 1 - Math.pow(1 - x, 5),
    inOut: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
  },
  Expo: {
    in: (x) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
    out: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    inOut: (x) =>
      x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2,
  },
  Circ: {
    in: (x) => 1 - Math.sqrt(1 - x * x),
    out: (x) => Math.sqrt(1 - Math.pow(x - 1, 2)),
    inOut: (x) =>
      x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2,
  },
  Back: {
    in: (x) => c3 * x * x * x - c1 * x * x,
    out: (x) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2),
    inOut: (x) =>
      x < 0.5
        ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
        : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
  },
  Elastic: {
    in: (x) => (x === 0 ? 0 : x === 1 ? 1 : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4)),
    out: (x) => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
    inOut: (x) =>
      x === 0
        ? 0
        : x === 1
          ? 1
          : x < 0.5
            ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
            : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
  },
  Bounce: {
    in: (x) => 1 - bounceOut(1 - x),
    out: bounceOut,
    inOut: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
  },
};

export const NAMED_EASES: Record<string, EaseFn> = {
  linear: (x) => x,
  hold: () => 0,
  easeIn: families.Cubic.in,
  easeOut: families.Cubic.out,
  easeInOut: families.Cubic.inOut,
};
for (const [name, f] of Object.entries(families)) {
  NAMED_EASES[`easeIn${name}`] = f.in;
  NAMED_EASES[`easeOut${name}`] = f.out;
  NAMED_EASES[`easeInOut${name}`] = f.inOut;
}

export const EASE_NAMES = Object.keys(NAMED_EASES) as [string, ...string[]];

/** CSS-style cubic-bezier(x1, y1, x2, y2) solved with Newton iterations + bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export type Ease = string | [number, number, number, number];

export const DEFAULT_EASE = "easeInOut";

export function resolveEase(ease: Ease | undefined): EaseFn {
  if (ease === undefined) return NAMED_EASES[DEFAULT_EASE];
  if (Array.isArray(ease)) return cubicBezier(ease[0], ease[1], ease[2], ease[3]);
  return NAMED_EASES[ease] ?? NAMED_EASES[DEFAULT_EASE];
}

/*
 * SVG path data ⇄ Lottie bezier shapes.
 *
 * A Lottie shape is one subpath: vertices `v`, and for each vertex the in/out tangents
 * `i`/`o` RELATIVE to the vertex, plus `c` (closed). Every SVG command (including arcs,
 * quadratics and smooth curves, absolute or relative) is converted to cubic segments.
 */

export type Pt = [number, number];
export interface LottieBezier {
  c: boolean;
  v: Pt[];
  i: Pt[];
  o: Pt[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Tokenizes path data into commands with numeric arguments. */
function tokenize(d: string): { cmd: string; args: number[] }[] {
  const out: { cmd: string; args: number[] }[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let cur: { cmd: string; args: number[] } | null = null;
  for (const m of d.matchAll(re)) {
    if (m[1]) {
      cur = { cmd: m[1], args: [] };
      out.push(cur);
    } else if (cur) cur.args.push(parseFloat(m[2]));
  }
  return out;
}

/** Arc (SVG endpoint parameterization) → cubic segments [c1, c2, end]. */
function arcToCubics(p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Pt): [Pt, Pt, Pt][] {
  if (rx === 0 || ry === 0) return [[p0, p, p]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p[0]) / 2;
  const dy = (p0[1] - p[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / segs;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): Pt => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const deriv = (t: number): Pt => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: [Pt, Pt, Pt][] = [];
  for (let s = 0; s < segs; s++) {
    const a = t1 + s * step;
    const b = a + step;
    const pa = point(a);
    const pb = s === segs - 1 ? p : point(b);
    const da = deriv(a);
    const db = deriv(b);
    out.push([
      [pa[0] + k * da[0], pa[1] + k * da[1]],
      [pb[0] - k * db[0], pb[1] - k * db[1]],
      pb,
    ]);
  }
  return out;
}

/** SVG path data → Lottie shapes (one per subpath). */
export function svgToLottie(d: string): LottieBezier[] {
  const shapes: LottieBezier[] = [];
  let cur: LottieBezier | null = null;
  let pos: Pt = [0, 0];
  let start: Pt = [0, 0];
  let lastCtrl: Pt | null = null; // reflection point for S/T
  let lastQuad: Pt | null = null;

  const begin = (p: Pt) => {
    cur = { c: false, v: [p], i: [[0, 0]], o: [[0, 0]] };
    shapes.push(cur);
    start = p;
  };
  const cubic = (c1: Pt, c2: Pt, p: Pt) => {
    if (!cur) begin(pos);
    const s = cur!;
    const last = s.v.length - 1;
    s.o[last] = [c1[0] - s.v[last][0], c1[1] - s.v[last][1]];
    s.v.push(p);
    s.i.push([c2[0] - p[0], c2[1] - p[1]]);
    s.o.push([0, 0]);
    pos = p;
  };
  const line = (p: Pt) => cubic(pos, p, p);

  for (const { cmd, args } of tokenize(d)) {
    const rel = cmd === cmd.toLowerCase() && cmd !== "z" ? true : false;
    const C = cmd.toUpperCase();
    const abs = (x: number, y: number): Pt => (rel ? [pos[0] + x, pos[1] + y] : [x, y]);
    let i = 0;
    const take = (n: number) => {
      const a = args.slice(i, i + n);
      i += n;
      return a;
    };
    const more = (n: number) => i + n <= args.length;
    switch (C) {
      case "M": {
        const [x, y] = take(2);
        pos = abs(x, y);
        begin(pos);
        while (more(2)) {
          const [lx, ly] = take(2);
          line(abs(lx, ly));
        }
        lastCtrl = lastQuad = null;
        break;
      }
      case "L":
        while (more(2)) {
          const [x, y] = take(2);
          line(abs(x, y));
        }
        lastCtrl = lastQuad = null;
        break;
      case "H":
        while (more(1)) {
          const [x] = take(1);
          line([rel ? pos[0] + x : x, pos[1]]);
        }
        lastCtrl = lastQuad = null;
        break;
      case "V":
        while (more(1)) {
          const [y] = take(1);
          line([pos[0], rel ? pos[1] + y : y]);
        }
        lastCtrl = lastQuad = null;
        break;
      case "C":
        while (more(6)) {
          const [a, b, c, e, x, y] = take(6);
          const c1 = abs(a, b);
          const c2 = abs(c, e);
          const p = abs(x, y);
          cubic(c1, c2, p);
          lastCtrl = c2;
        }
        lastQuad = null;
        break;
      case "S":
        while (more(4)) {
          const [c, e, x, y] = take(4);
          const c1: Pt = lastCtrl ? [2 * pos[0] - lastCtrl[0], 2 * pos[1] - lastCtrl[1]] : pos;
          const c2 = abs(c, e);
          const p = abs(x, y);
          cubic(c1, c2, p);
          lastCtrl = c2;
        }
        lastQuad = null;
        break;
      case "Q":
        while (more(4)) {
          const [a, b, x, y] = take(4);
          const q = abs(a, b);
          const p = abs(x, y);
          const p0 = pos;
          cubic([p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
          lastQuad = q;
        }
        lastCtrl = null;
        break;
      case "T":
        while (more(2)) {
          const [x, y] = take(2);
          const p0 = pos;
          const q: Pt = lastQuad ? [2 * p0[0] - lastQuad[0], 2 * p0[1] - lastQuad[1]] : p0;
          const p = abs(x, y);
          cubic([p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
          lastQuad = q;
        }
        lastCtrl = null;
        break;
      case "A":
        while (more(7)) {
          const [rx, ry, rot, large, sweep, x, y] = take(7);
          const p = abs(x, y);
          for (const [c1, c2, e] of arcToCubics(pos, rx, ry, rot, !!large, !!sweep, p)) cubic(c1, c2, e);
        }
        lastCtrl = lastQuad = null;
        break;
      case "Z":
        if (cur) {
          const s = cur as LottieBezier;
          s.c = true;
          // A closing segment that lands on the start point is implied by c: drop the duplicate vertex.
          const last = s.v.length - 1;
          if (last > 0 && Math.abs(s.v[last][0] - s.v[0][0]) < 1e-6 && Math.abs(s.v[last][1] - s.v[0][1]) < 1e-6) {
            s.i[0] = s.i[last];
            s.v.pop();
            s.i.pop();
            s.o.pop();
          }
        }
        pos = start;
        cur = null;
        lastCtrl = lastQuad = null;
        break;
    }
  }
  return shapes
    .filter((s) => s.v.length > 1 || s.c)
    .map((s) => ({ c: s.c, v: s.v.map(rp), i: s.i.map(rp), o: s.o.map(rp) }));
}
const rp = (p: Pt): Pt => [round(p[0]), round(p[1])];

/** Lottie shapes → SVG path data (absolute cubic commands; straight segments as L). */
export function lottieToSvg(shapes: LottieBezier[], offset: Pt = [0, 0], cubic = false): string {
  const f = (n: number) => String(round(n));
  const pt = (p: Pt) => `${f(p[0] + offset[0])} ${f(p[1] + offset[1])}`;
  const parts: string[] = [];
  for (const s of shapes) {
    if (!s.v?.length) continue;
    parts.push(`M${pt(s.v[0])}`);
    const n = s.v.length;
    const seg = (a: number, b: number) => {
      const o = s.o[a] ?? [0, 0];
      const i = s.i[b] ?? [0, 0];
      // `cubic` keeps every segment a C command, so keyframes of a morph share one structure.
      const straight = !cubic && !o[0] && !o[1] && !i[0] && !i[1];
      if (straight) parts.push(`L${pt(s.v[b])}`);
      else parts.push(`C${pt([s.v[a][0] + o[0], s.v[a][1] + o[1]])} ${pt([s.v[b][0] + i[0], s.v[b][1] + i[1]])} ${pt(s.v[b])}`);
    };
    for (let k = 1; k < n; k++) seg(k - 1, k);
    if (s.c) {
      const o = s.o[n - 1] ?? [0, 0];
      const i = s.i[0] ?? [0, 0];
      if (n > 1 && (cubic || o[0] || o[1] || i[0] || i[1])) seg(n - 1, 0); // a straight closing edge is implied by Z
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

/** Rect / ellipse / polystar outlines as SVG path data (for shapes that must become paths). */
export function rectPath(cx: number, cy: number, w: number, h: number, r = 0): string {
  const x = cx - w / 2;
  const y = cy - h / 2;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
  return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}
export function ellipsePath(cx: number, cy: number, w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;
}
export function starPath(cx: number, cy: number, points: number, outer: number, inner: number | null, rotationDeg: number): string {
  const n = Math.max(3, Math.round(points));
  const pts: Pt[] = [];
  const total = inner === null ? n : n * 2;
  for (let k = 0; k < total; k++) {
    const r = inner === null || k % 2 === 0 ? outer : inner;
    const a = ((rotationDeg - 90) * Math.PI) / 180 + (k * 2 * Math.PI) / total;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return `M${pts.map((p) => `${round(p[0])} ${round(p[1])}`).join(" L")} Z`;
}

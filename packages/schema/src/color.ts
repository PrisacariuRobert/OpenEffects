export type RGBA = [number, number, number, number];

const NAMED: Record<string, RGBA> = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  cyan: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  orange: [255, 165, 0, 1],
  purple: [128, 0, 128, 1],
  pink: [255, 192, 203, 1],
};

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s in NAMED) return [...NAMED[s]] as RGBA;
  const hex = HEX.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = FUNC.exec(s);
  if (fn) {
    let a = 1;
    if (fn[4] !== undefined) a = fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), a];
  }
  return null;
}

export function isColor(s: string): boolean {
  return parseColor(s) !== null;
}

export function formatColor([r, g, b, a]: RGBA): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.min(1, Math.max(0, a)).toFixed(4)})`;
}

export function lerpColor(a: string, b: string, p: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return p < 1 ? a : b;
  return formatColor([0, 1, 2, 3].map((i) => ca[i] + (cb[i] - ca[i]) * p) as RGBA);
}

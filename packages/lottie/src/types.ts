/* Minimal Lottie (bodymovin) JSON types: only what OpenEffects reads and writes. */

export interface LKeyframe {
  t: number;
  s?: number[];
  e?: number[]; // legacy end value
  o?: { x: number | number[]; y: number | number[] };
  i?: { x: number | number[]; y: number | number[] };
  h?: number;
  to?: number[];
  ti?: number[];
}
export type LValue = number | number[];
export interface LProp {
  a: 0 | 1;
  k: LValue | LKeyframe[];
  x?: string; // expression
  ix?: number;
}
export interface LSplitPosition {
  s: true;
  x: LProp;
  y: LProp;
  z?: LProp;
}
export interface LTransform {
  a?: LProp;
  p?: LProp | LSplitPosition;
  s?: LProp;
  r?: LProp;
  rz?: LProp;
  o?: LProp;
  sk?: LProp;
  sa?: LProp;
}

// Shapes are loosely typed: players accept many optional fields.
export type LShape = { ty: string; nm?: string; hd?: boolean; [k: string]: unknown };

export interface LLayer {
  ddd?: number;
  ind?: number;
  ty: number;
  nm?: string;
  ln?: string;
  cl?: string;
  sr?: number;
  ks: LTransform;
  ao?: number;
  ip: number;
  op: number;
  st?: number;
  bm?: number;
  hd?: boolean;
  parent?: number;
  td?: number;
  tt?: number;
  tp?: number;
  ef?: { ty: number; nm?: string; mn?: string; en?: number; ef: { ty: number; nm?: string; v: LProp }[] }[];
  shapes?: LShape[];
  refId?: string;
  w?: number;
  h?: number;
  tm?: LProp;
  sc?: string;
  sw?: number;
  sh?: number;
  t?: {
    d: { k: { s: LTextDocument; t: number }[] };
    a?: unknown[];
    p?: unknown;
    m?: unknown;
  };
  masksProperties?: unknown[];
  hasMask?: boolean;
}

export interface LTextDocument {
  s: number;
  f: string;
  t: string;
  j: number;
  tr: number;
  lh: number;
  ls?: number;
  fc?: number[];
  sc?: number[];
  sw?: number;
  of?: boolean;
  ca?: number;
  sz?: number[];
  ps?: number[];
}

export interface LAsset {
  id: string;
  nm?: string;
  // image
  w?: number;
  h?: number;
  u?: string;
  p?: string;
  e?: number;
  // precomp
  layers?: LLayer[];
  fr?: number;
}

export interface LFont {
  fName: string;
  fFamily: string;
  fStyle: string;
  fWeight?: string;
  ascent?: number;
  fPath?: string;
  fOrigin?: string;
}

export interface LottieAnimation {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm?: string;
  ddd?: number;
  assets?: LAsset[];
  layers: LLayer[];
  markers?: { tm: number; cm: string; dr: number }[];
  fonts?: { list: LFont[] };
  chars?: unknown[];
  meta?: Record<string, unknown>;
}

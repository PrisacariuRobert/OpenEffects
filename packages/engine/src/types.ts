import type { Layer } from "@openeffects/schema";

export type LayerOf<T extends Layer["type"]> = Extract<Layer, { type: T }>;
export type TextLayer = LayerOf<"text">;
export type PathLayer = LayerOf<"path">;

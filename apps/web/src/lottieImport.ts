import { addAsPrecomp } from "@openeffects/lottie";
import type { Editor } from "./editor.ts";

/**
 * Imports a Lottie .json file into the open composition as a precomp layer. The server
 * converts it (and stores its images); the merge goes through the editor, so it's one
 * undoable step. Resolves to the new layer id and the conversion notes.
 */
export async function importLottie(file: File, editor: Editor, compId: string, time: number): Promise<{ layerId: string; warnings: string[] }> {
  const res = await fetch(`/api/import/lottie?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await file.text(),
  });
  const data = (await res.json()) as { project?: Parameters<typeof addAsPrecomp>[1]; warnings?: string[]; error?: string };
  if (!res.ok || !data.project) throw new Error(data.error ?? "That file couldn't be imported");
  let layerId = "";
  editor.update((p) => {
    const r = addAsPrecomp(p, data.project!, { compId, name: file.name.replace(/\.[^.]+$/, ""), time });
    layerId = r.layerId;
    return r.project;
  });
  return { layerId, warnings: data.warnings ?? [] };
}

/** Opens a file picker for .json Lottie files. */
export function pickLottieFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

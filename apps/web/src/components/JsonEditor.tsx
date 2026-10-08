import { useEffect, useState } from "react";
import { getComp, type Project } from "@openeffects/schema";
import type { Editor } from "../editor.ts";

/** Raw JSON for the selected layer (or the composition settings): the escape hatch. */
export function JsonEditor({ editor, project, compId, selected }: { editor: Editor; project: Project; compId: string; selected: string | null }) {
  const comp = getComp(project, compId);
  const layer = selected ? comp.layers.find((l) => l.id === selected) : undefined;
  const { layers: _layers, ...compSettings } = comp;
  const original = JSON.stringify(layer ?? compSettings, null, 2);
  const [text, setText] = useState(original);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(original);
    setError(null);
  }, [original]);

  const apply = () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setError(null);
    editor.update((p) => {
      const next: Project = structuredClone(p);
      const c = getComp(next, compId);
      if (layer) c.layers = c.layers.map((l) => (l.id === layer.id ? (value as typeof l) : l));
      else Object.assign(c, value, { layers: c.layers });
      return next;
    });
  };

  return (
    <div className="json-editor">
      <textarea
        className="code"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            apply();
          }
        }}
      />
      {(error || editor.error) && <div className="errors">{error ?? editor.error}</div>}
      <div className="row">
        <button className="primary" onClick={apply} disabled={text === original}>
          Apply (⌘S)
        </button>
        <button className="ghost" onClick={() => setText(original)} disabled={text === original}>
          Revert
        </button>
      </div>
    </div>
  );
}

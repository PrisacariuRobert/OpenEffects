import { useEffect, useState } from "react";
import { getComp, type Project } from "@openeffects/schema";
import { api } from "../api.ts";

interface Props {
  project: Project;
  compId: string;
  selected: string | null;
}

/** JSON editor for the selected layer (or the composition settings). Saves through the server. */
export function Inspector({ project, compId, selected }: Props) {
  const comp = getComp(project, compId);
  const layer = selected ? comp.layers.find((l) => l.id === selected) : undefined;
  const { layers: _layers, ...compSettings } = comp;
  const source = layer ?? compSettings;
  const original = JSON.stringify(source, null, 2);
  const [text, setText] = useState(original);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(original);
    setErrors([]);
  }, [original]);

  const apply = async () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      setErrors([`Invalid JSON: ${(e as Error).message}`]);
      return;
    }
    const next: Project = structuredClone(project);
    const c = getComp(next, compId);
    if (layer) {
      c.layers = c.layers.map((l) => (l.id === layer.id ? (value as typeof l) : l));
    } else {
      Object.assign(c, value, { layers: c.layers });
    }
    try {
      await api("/api/project", next, "PUT");
      setErrors([]);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch (e) {
      setErrors((e as Error & { errors?: string[] }).errors ?? [(e as Error).message]);
    }
  };

  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong>{layer ? `Layer · ${layer.name ?? layer.id}` : `Composition · ${comp.name ?? comp.id}`}</strong>
        <span className="muted small">{layer ? layer.type : "select a layer in the timeline"}</span>
      </div>
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
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="primary" onClick={apply} disabled={text === original}>
          {saved ? "Saved ✓" : "Apply (⌘S)"}
        </button>
        <button className="ghost" onClick={() => setText(original)} disabled={text === original}>
          Revert
        </button>
      </div>
    </div>
  );
}

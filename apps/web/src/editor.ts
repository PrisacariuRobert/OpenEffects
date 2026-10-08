import { useCallback, useEffect, useRef, useState } from "react";
import { validateProject, type Project } from "@openeffects/schema";
import { api } from "./api.ts";

export interface Editor {
  /** What the user sees: the local draft while edits are in flight, else the server's project. */
  project: Project | null;
  /**
   * Apply an edit. `transient` edits (during a drag) only update the preview; the final,
   * non-transient call records one undo step and saves.
   */
  update(fn: (p: Project) => Project, opts?: { transient?: boolean }): void;
  /** Drop an unfinished transient gesture (e.g. Escape during a drag). */
  cancel(): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  error: string | null;
}

const MAX_HISTORY = 200;

export function useEditor(serverProject: Project | null): Editor {
  const [draft, setDraft] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  const undoStack = useRef<Project[]>([]);
  const redoStack = useRef<Project[]>([]);
  const gestureBase = useRef<Project | null>(null);
  const lastSent = useRef<string | null>(null);
  const shown = useRef<Project | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Project | null>(null);

  const effective = draft ?? serverProject;
  shown.current = effective;

  // Server changes: our own echo clears the draft; anything else (the agent, a text editor)
  // becomes an undo step so Ctrl+Z can take it back too.
  const prevServer = useRef<Project | null>(serverProject);
  useEffect(() => {
    const prev = prevServer.current;
    prevServer.current = serverProject;
    if (!serverProject) return;
    const json = JSON.stringify(serverProject);
    if (json === lastSent.current) {
      setDraft((d) => (d && JSON.stringify(d) === json ? null : d));
      return;
    }
    if (prev && !gestureBase.current) {
      undoStack.current = [...undoStack.current, prev].slice(-MAX_HISTORY);
      redoStack.current = [];
    }
    if (!gestureBase.current && !pending.current) setDraft(null);
    force((n) => n + 1);
  }, [serverProject]);

  const save = useCallback((p: Project) => {
    pending.current = p;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const toSave = pending.current;
      pending.current = null;
      if (!toSave) return;
      lastSent.current = JSON.stringify(toSave);
      try {
        await api("/api/project", toSave, "PUT");
        setError(null);
      } catch (e) {
        const errs = (e as Error & { errors?: string[] }).errors;
        setError(errs?.[0] ?? (e as Error).message);
      }
    }, 120);
  }, []);

  const update = useCallback(
    (fn: (p: Project) => Project, opts: { transient?: boolean } = {}) => {
      const base = shown.current;
      if (!base) return;
      let next: Project;
      try {
        next = fn(base);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (next === base) return;
      if (opts.transient) {
        if (!gestureBase.current) gestureBase.current = base;
        setDraft(next);
        return;
      }
      const v = validateProject(next);
      if (!v.ok) {
        setError(v.errors[0]);
        if (gestureBase.current) setDraft(gestureBase.current);
        gestureBase.current = null;
        return;
      }
      const before = gestureBase.current ?? base;
      gestureBase.current = null;
      undoStack.current = [...undoStack.current, before].slice(-MAX_HISTORY);
      redoStack.current = [];
      setError(null);
      setDraft(next);
      save(next);
    },
    [save],
  );

  const cancel = useCallback(() => {
    if (gestureBase.current) setDraft(gestureBase.current);
    gestureBase.current = null;
  }, []);

  const jump = useCallback(
    (from: { current: Project[] }, to: { current: Project[] }) => {
      const cur = shown.current;
      const target = from.current[from.current.length - 1];
      if (!cur || !target) return;
      from.current = from.current.slice(0, -1);
      to.current = [...to.current, cur].slice(-MAX_HISTORY);
      setDraft(target);
      save(target);
    },
    [save],
  );

  return {
    project: effective,
    update,
    cancel,
    undo: () => jump(undoStack, redoStack),
    redo: () => jump(redoStack, undoStack),
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    error,
  };
}

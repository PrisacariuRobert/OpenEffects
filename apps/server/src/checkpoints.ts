import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Checkpoint } from "@openeffects/schema";

export type { Checkpoint };

const exec = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "OpenEffects",
  GIT_AUTHOR_EMAIL: "openeffects@localhost",
  GIT_COMMITTER_NAME: "OpenEffects",
  GIT_COMMITTER_EMAIL: "openeffects@localhost",
};

/**
 * Snapshots of the project folder stored as hidden git refs (like T3 Code's per-turn
 * checkpoints). Uses a private index file, so the user's staging area, branch and
 * history are never touched.
 */
export class Checkpoints {
  private ns: string;
  private ready: Promise<boolean>;

  constructor(private dir: string) {
    this.ns = `refs/openeffects/${createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 10)}`;
    this.ready = this.init();
  }

  private async git(args: string[], env: Record<string, string> = {}): Promise<string> {
    const { stdout } = await exec("git", args, { cwd: this.dir, env: { ...process.env, ...IDENTITY, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  private async init(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--git-dir"]);
      return true;
    } catch {
      try {
        await this.git(["init", "-q"]);
        return true;
      } catch {
        return false;
      }
    }
  }

  async enabled(): Promise<boolean> {
    return this.ready;
  }

  private tempIndex(): string {
    return path.join(os.tmpdir(), `openeffects-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  async create(label: string): Promise<Checkpoint | null> {
    if (!(await this.ready)) return null;
    const index = this.tempIndex();
    try {
      await this.git(["add", "-A", "--", "."], { GIT_INDEX_FILE: index });
      const tree = await this.git(["write-tree"], { GIT_INDEX_FILE: index });
      const id = `${Date.now()}`;
      const commit = await this.git(["commit-tree", tree, "-m", label.replace(/\s+/g, " ").slice(0, 200) || "checkpoint"]);
      await this.git(["update-ref", `${this.ns}/${id}`, commit]);
      return { id, label, createdAt: Number(id) };
    } catch {
      return null;
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  async list(): Promise<Checkpoint[]> {
    if (!(await this.ready)) return [];
    try {
      const out = await this.git(["for-each-ref", "--format=%(refname:lstrip=3)\t%(contents:subject)", this.ns]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, label] = line.split("\t");
          return { id, label, createdAt: Number(id) };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  /** Restores tracked project files to a checkpoint. A safety checkpoint is taken first. */
  /** A file's contents at a checkpoint (e.g. project.oe.json before an agent turn), or null. */
  async read(id: string, file: string): Promise<string | null> {
    if (!/^\d+$/.test(id) || !(await this.ready)) return null;
    try {
      return await this.git(["show", `${this.ns}/${id}:./${file}`]);
    } catch {
      return null;
    }
  }

  async restore(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error("Invalid checkpoint id");
    await this.create(`Before restoring checkpoint ${id}`);
    const index = this.tempIndex();
    try {
      await this.git(["read-tree", `${this.ns}/${id}`], { GIT_INDEX_FILE: index });
      await this.git(["checkout-index", "-a", "-f"], { GIT_INDEX_FILE: index });
    } finally {
      fs.rmSync(index, { force: true });
    }
  }
}

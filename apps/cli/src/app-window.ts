import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Chromium-family browsers that can open a chromeless app window (--app=url). */
function candidates(): string[] {
  if (process.env.OE_BROWSER) return [process.env.OE_BROWSER];
  if (process.platform === "darwin") {
    return ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Arc"].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const rel = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    return roots.flatMap((r) => rel.map((p) => path.join(r, p)));
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
}

function findBrowser(): string | undefined {
  for (const c of candidates()) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
    } else if (spawnSync("which", [c], { stdio: "ignore" }).status === 0) return c;
  }
  return undefined;
}

export type AppWindow = { kind: "app"; browser: string; closed: Promise<void> } | { kind: "browser" };

/**
 * Open the editor like a desktop app: its own window with no tabs or address bar, using the
 * Chrome, Edge or Brave the user already has (no 150 MB Electron download). Falls back to the
 * default browser.
 */
export function openAppWindow(url: string): AppWindow {
  const browser = findBrowser();
  if (browser) {
    // A separate profile keeps the window in its own process, so we know when it closes.
    const profile = path.join(os.homedir(), ".openeffects", "app-profile");
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "--no-first-run", "--no-default-browser-check"], { stdio: "ignore" });
    const started = Date.now();
    const closed = new Promise<void>((resolve) => {
      child.on("error", () => openDefault(url));
      child.on("exit", () => {
        // Exiting right away means an already-open OpenEffects window took the URL; keep serving.
        if (Date.now() - started > 3000) resolve();
      });
    });
    return { kind: "app", browser: path.basename(browser), closed };
  }
  openDefault(url);
  return { kind: "browser" };
}

function openDefault(url: string): void {
  const opener = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  spawn(opener[0], opener.slice(1), { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

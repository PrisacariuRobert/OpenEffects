import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sample, validateProject, type Project } from "@openeffects/schema";
import { captionLayers, groupWords, parseSubtitles, parseWhisperJson, transcribe } from "../src/index.ts";

const SRT = `1
00:00:00,500 --> 00:00:02,000
Ship faster.

2
00:00:02,400 --> 00:00:04,900
Sleep better, every single night.
`;

const VTT = `WEBVTT

00:01.000 --> 00:02.500
<v Ana>Hello there</v>
`;

describe("captions", () => {
  it("parses SRT and WebVTT into timed words", () => {
    const words = parseSubtitles(SRT);
    expect(words.map((w) => w.text)).toEqual(["Ship", "faster.", "Sleep", "better,", "every", "single", "night."]);
    expect(words[0].start).toBe(0.5);
    expect(words[1].end).toBeCloseTo(2, 3);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
    const v = parseSubtitles(VTT);
    expect(v.map((w) => w.text)).toEqual(["Hello", "there"]);
    expect(v[0].start).toBe(1);
  });

  it("groups words into lines at sentence ends, pauses and length", () => {
    const groups = groupWords(parseSubtitles(SRT), 20);
    expect(groups[0].map((w) => w.text).join(" ")).toBe("Ship faster.");
    expect(groups.every((g) => g.map((w) => w.text).join(" ").length <= 20 || g.length === 1)).toBe(true);
  });

  it("splits long lines evenly and never shows two lines at once", () => {
    const words = parseSubtitles("1\n00:00:06,900 --> 00:00:08,600\nThen you finish it by hand.\n\n2\n00:00:08,600 --> 00:00:09,500\nShip it.\n");
    const lines = groupWords(words, 22).map((g) => g.map((w) => w.text).join(" "));
    expect(lines).toEqual(["Then you finish", "it by hand.", "Ship it."]);
    const layers = captionLayers(words, { width: 1080, height: 1920, duration: 10 }, { maxChars: 22 });
    const bgs = layers.filter((l) => l.id.endsWith("-bg"));
    for (let i = 1; i < bgs.length; i++) expect(bgs[i - 1].out!).toBeLessThanOrEqual(bgs[i].in!);
  });

  it("builds word layers that appear when each word is spoken", () => {
    const comp = { width: 1920, height: 1080, duration: 6 };
    const words = parseSubtitles(SRT);
    for (const style of ["pop", "karaoke", "minimal"] as const) {
      const layers = captionLayers(words, comp, { style });
      const project: Project = { version: 1, compositions: [{ id: "main", fps: 30, background: "#000", layers, ...comp }] };
      expect(validateProject(project).ok).toBe(true);
    }
    const pop = captionLayers(words, comp, { style: "pop" });
    const faster = pop.find((l) => l.type === "text" && l.text === "faster.")!;
    const op = faster.transform!.opacity;
    expect(sample(op, words[1].start - 0.01, 100)).toBe(0);
    expect(sample(op, words[1].start + 0.2, 0)).toBe(100);
    // Words of one line sit left to right.
    const ship = pop.find((l) => l.type === "text" && l.text === "Ship")!;
    expect((ship.transform!.position as number[])[0]).toBeLessThan((faster.transform!.position as number[])[0]);
    const karaoke = captionLayers(words, comp, { style: "karaoke", highlight: "#ff0000" });
    const sleep = karaoke.find((l) => l.type === "text" && l.text === "Sleep")!;
    expect(sample(sleep.type === "text" ? (sleep.fill as never) : undefined, words[2].start + 0.01, "")).toBe("#ff0000");
  });

  it("reads whisper.cpp word timings", () => {
    const words = parseWhisperJson({ transcription: [{ text: " Hello", offsets: { from: 0, to: 420 } }, { text: " world", offsets: { from: 420, to: 900 } }] });
    expect(words).toEqual([
      { text: "Hello", start: 0, end: 0.42 },
      { text: "world", start: 0.42, end: 0.9 },
    ]);
  });

  it("transcribes with a local whisper.cpp binary", async () => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    } catch {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-asr-test-"));
    const audio = path.join(dir, "a.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=1", audio]);
    const model = path.join(dir, "model.bin");
    fs.writeFileSync(model, "fake");
    // A stand-in for whisper-cli: writes the JSON whisper.cpp would write for "-oj -of <base>".
    const fake = path.join(dir, "whisper-cli");
    fs.writeFileSync(fake, `#!/bin/sh\nwhile [ "$1" != "" ]; do if [ "$1" = "-of" ]; then shift; out="$1"; fi; shift; done\necho '{"transcription":[{"text":" Hi","offsets":{"from":100,"to":400}}]}' > "$out.json"\n`);
    fs.chmodSync(fake, 0o755);
    process.env.OE_WHISPER = fake;
    try {
      expect(await transcribe(audio, { model })).toEqual([{ text: "Hi", start: 0.1, end: 0.4 }]);
      await expect(transcribe(audio, { model: path.join(dir, "missing.bin") })).rejects.toThrow(/No speech model/);
    } finally {
      delete process.env.OE_WHISPER;
    }
  });
});

import type { Project } from "./schema.ts";

export const SCHEMA_URL = "https://raw.githubusercontent.com/PrisacariuRobert/OpenEffects/main/schema/project.schema.json";

export function blankProject(name = "Untitled"): Project {
  return {
    $schema: SCHEMA_URL,
    version: 1,
    name,
    compositions: [
      {
        id: "main",
        name: "Main",
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 5,
        background: "#0b0d17",
        layers: [
          {
            id: "hello",
            type: "text",
            text: "Describe your animation to the agent",
            font: { size: 64, weight: 600 },
            fill: "#c9d1ff",
            transform: { opacity: { keyframes: [{ t: 0, v: 0, ease: "easeOutCubic" }, { t: 0.8, v: 100 }] } },
          },
        ],
      },
    ],
  };
}

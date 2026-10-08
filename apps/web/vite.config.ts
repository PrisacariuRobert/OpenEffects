import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The OpenEffects server embeds Vite in middleware mode (`oe dev`). Running `vite` directly
// also works when a server is already running on :4310.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/ws": { target: "ws://127.0.0.1:4310", ws: true },
    },
  },
});

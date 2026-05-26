import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `ws` is bundled into the main process (it's not an app dependency, so
        // externalizeDepsPlugin leaves it for Rollup). Its optional native
        // accelerators are loaded via try/catch at runtime — mark them external
        // so bundling doesn't fail; ws falls back to its pure-JS path without them.
        external: ["bufferutil", "utf-8-validate"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});

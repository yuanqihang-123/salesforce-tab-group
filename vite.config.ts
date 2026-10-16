import { defineConfig } from "vite";
export default defineConfig({
  build: {
    target: "chrome120",
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: "src/background/index.ts",
        popup: "popup/index.html",
        options: "options/index.html",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
});

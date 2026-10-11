import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: `${repositoryRoot}public`,
  resolve: { alias: { "@": `${repositoryRoot}src` } },
  esbuild: { jsx: "automatic" },
  css: { postcss: repositoryRoot },
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    fs: { allow: [repositoryRoot] },
  },
});

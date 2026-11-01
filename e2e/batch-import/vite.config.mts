import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: fixtureRoot,
  cacheDir: `${repositoryRoot}test-results/batch-import-vite-cache`,
  publicDir: false,
  resolve: {
    alias: [
      { find: "convex/react", replacement: `${fixtureRoot}convex-stub.ts` },
      { find: "next/link", replacement: `${fixtureRoot}next-stub.tsx` },
      { find: "next/navigation", replacement: `${fixtureRoot}next-stub.tsx` },
      { find: "@", replacement: `${repositoryRoot}src` },
    ],
  },
  esbuild: { jsx: "automatic" },
  css: { postcss: repositoryRoot },
  server: { host: "127.0.0.1", port: 4181, strictPort: true, fs: { allow: [repositoryRoot] } },
});

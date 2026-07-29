import path from "node:path";
import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@/convex": path.resolve(__dirname, "convex"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    projects: [
      defineProject({
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
          // Leave headroom for transactional setup when all project files run
          // concurrently on a constrained CI worker.
          testTimeout: 10_000,
        },
      }),
      defineProject({
        resolve: {
          alias: {
            "@/convex": path.resolve(__dirname, "convex"),
            "@": path.resolve(__dirname, "src"),
          },
        },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      }),
    ],
  },
});

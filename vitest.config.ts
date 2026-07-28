import path from "node:path";
import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@/convex": path.resolve(__dirname, "convex"),
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
            "@": path.resolve(__dirname, "src"),
            "@/convex": path.resolve(__dirname, "convex"),
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

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.PERIPLO_API_URL ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin in development too, as in the image, where the API serves the console.
    proxy: { "/api": apiTarget, "/health": apiTarget },
  },
  test: {
    // Coverage is a root option: Vitest ignores it inside a project. Only the app
    // source counts, so tests, fixtures and the dev mock API stay out.
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts"],
    },
    projects: [
      {
        extends: true,
        test: { name: "unit", environment: "node", include: ["tests/**/*.test.ts", "src/**/*.test.ts"] },
      },
      {
        extends: true,
        // A docblock cannot name a path, so component tests get their DOM environment here.
        test: {
          name: "dom",
          environment: "./tests/jsdom-with-node-fetch.ts",
          setupFiles: ["./tests/testing-library.ts"],
          testTimeout: 15_000,
          include: ["src/**/*.test.tsx"],
        },
      },
    ],
  },
});

import { defineConfig } from "vitest/config";

// Tests run on UTC's clock everywhere, as on CI: a test that assumes the machine's own zone fails here too.
// Set before Vitest starts its workers, which inherit it.
process.env.TZ = "UTC";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Only the library source counts: tests, fixtures and the playground stay out.
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts"],
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "test/standards/*.test.ts"],
    // No `passWithNoTests`: with it, an `include` that stops matching (a path rework, a
    // moved file) reports GREEN instead of red — the run could not tell "no tests" from
    // "all tests pass". The suite has had tests since the command-router phase.
    watch: false,
    pool: "forks",
    forks: { singleFork: false },
    coverage: {
      // Explicit include so files that no test imports still show up as 0 %
      // — without this the v8 provider silently omits them and the headline
      // number overstates real coverage (fleet lesson from the govee-smart
      // v2.16.1 audit; before the v1.8.1 test wave this hid main.ts and
      // hue-server.ts at 0 %).
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});

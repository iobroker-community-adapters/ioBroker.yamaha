import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Frontend component tests (jsdom + testing-library). The Module-Federation
// production build (vite.config.ts) is separate — this config only drives the
// unit tests for the pure React components (the diagnostics card).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

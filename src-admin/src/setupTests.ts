// Extends vitest's `expect` with the jest-dom matchers (toBeInTheDocument, …).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// With `globals: false` vitest never registers the global afterEach that
// testing-library hooks its auto-cleanup onto, so unmount each render
// explicitly — otherwise duplicate data-testids pile up across tests.
afterEach(() => {
  cleanup();
});

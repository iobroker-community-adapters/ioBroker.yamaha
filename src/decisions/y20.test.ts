import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Y-20: error reports go to krobi's own Sentry project on de.sentry.io, not to the community Sentry.

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "io-package.json"), "utf-8")) as {
  common: { plugins?: { sentry?: { dsn?: unknown } } };
};

describe("Y-20 error reports go to krobi's own Sentry project", () => {
  test("the Sentry plugin is declared with krobi's project", () => {
    expect(manifest.common.plugins?.sentry?.dsn).toBe(
      "https://66f27ceff38c1ce1e6cdcc3095ba06d3@o4511524771266560.ingest.de.sentry.io/4511524773560400",
    );
  });

  test("never the community Sentry", () => {
    const declared = manifest.common.plugins?.sentry?.dsn;
    const dsn = typeof declared === "string" ? declared : "";
    expect(new URL(dsn).hostname).toMatch(/\.ingest\.de\.sentry\.io$/);
    expect(dsn).not.toMatch(/iobroker\.net/i);
  });
});

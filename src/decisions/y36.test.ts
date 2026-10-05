import { describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureXml, captureYnca, captureYxc } from "../lib/diagnostics/device-capture";
import { YamahaYxcClient } from "../lib/yxc/http-client";

// Y-36 (krobi 2026-10-05 22:47 "y36 yes"): the diagnostics report has an Expert tab of its own, as in govee — pick a
// device, download the report. The report only reads the device and changes nothing.

const ROOT = join(__dirname, "..", "..");
const jsonConfig = JSON.parse(readFileSync(join(ROOT, "admin", "jsonConfig.json"), "utf-8")) as {
  items: Record<string, { type?: string; items?: Record<string, { type?: string; name?: string; url?: string }> }>;
};

describe("Y-36 the diagnostics report has its own Expert tab and only reads the device", () => {
  test("the Expert tab holds the diagnostics card, and the card is built", () => {
    const expert = jsonConfig.items._expert;
    expect(expert?.type).toBe("panel");
    const cards = Object.values(expert?.items ?? {});
    expect(cards.map(card => [card.type, card.name])).toEqual([
      ["custom", "ConfigCustomYamahaSet/Components/DiagnosticsConfig"],
    ]);
    expect(existsSync(join(ROOT, "admin", cards[0]?.url ?? "-"))).toBe(true);
  });

  test("MusicCast: the report asks only get endpoints, and the client refuses anything else before the device", async () => {
    const asked: string[] = [];
    await captureYxc({
      read: (path: string) => {
        asked.push(path);
        return Promise.resolve({ response_code: 0 });
      },
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter(path => !/\/get[A-Z]\w*(?:\?|$)/.test(path))).toEqual([]);

    const transport = vi.fn(() => Promise.resolve({ response_code: 0 }));
    const client = new YamahaYxcClient("192.0.2.1", transport);
    const outcome = await client.read("main/setPower?power=on").then(
      () => "sent",
      (error: Error) => error.message,
    );
    expect(outcome).toContain("not a read");
    expect(transport).not.toHaveBeenCalled();
  });

  test("YNCA: the report sends only questions (=?)", async () => {
    const asked: Array<{ subunit: string; func: string }> = [];
    await captureYnca({
      capture: gets => {
        asked.push(...gets);
        return Promise.resolve({ lines: [], complete: true });
      },
    });
    expect(asked.length).toBeGreaterThan(0);
    // The capture client takes only a subunit and a function — there is no value it could set.
    expect(asked.every(get => Object.keys(get).sort().join() === "func,subunit")).toBe(true);
  });

  test("XML: the report sends only GET requests", async () => {
    const asked: string[] = [];
    await captureXml({
      getXml: (element: string, inner: string) => {
        asked.push(`${element} ${inner}`);
        return Promise.resolve("");
      },
      getDescriptor: () => Promise.resolve(""),
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter(request => !/GetParam/.test(request) || /Put|Set/.test(request))).toEqual([]);
  });
});

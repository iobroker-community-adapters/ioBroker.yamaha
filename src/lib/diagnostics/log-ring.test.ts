import { describe, expect, it, vi } from "vitest";
import { LogRing, type HookableLog } from "./log-ring";

describe("LogRing", () => {
  it("hears every level and still logs as before", () => {
    const original = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log: HookableLog = { ...original };
    const ring = new LogRing(10, () => 0);
    ring.hook(log);
    log.debug("rx-v6a-2b3c: swept");
    log.warn("rx-v6a-2b3c: refused");
    expect(original.debug).toHaveBeenCalledWith("rx-v6a-2b3c: swept");
    expect(original.warn).toHaveBeenCalledWith("rx-v6a-2b3c: refused");
    expect(ring.about(["rx-v6a-2b3c"], []).map(line => line.level)).toEqual(["debug", "warn"]);
  });

  it("keeps only the newest lines", () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i++) {
      ring.add("info", `line ${i}`);
    }
    expect(ring.about([], []).map(line => line.msg)).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("gives a device its own lines and the adapter-wide ones, not another device's", () => {
    const ring = new LogRing();
    ring.add("info", "rx-v6a-2b3c: ready");
    ring.add("info", "wx-030-f504: ready");
    ring.add("info", "network search finished");
    ring.add("debug", "10.0.0.5 answered");
    expect(ring.about(["rx-v6a-2b3c", "10.0.0.5"], ["wx-030-f504", "10.0.0.6"]).map(line => line.msg)).toEqual([
      "rx-v6a-2b3c: ready",
      "network search finished",
      "10.0.0.5 answered",
    ]);
  });
});

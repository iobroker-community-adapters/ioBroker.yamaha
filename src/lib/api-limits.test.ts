import { describe, expect, it } from "vitest";
import { API_COUNTERPARTS, spacingMs } from "./api-limits";
import { COMMAND_SPACING_MS } from "./lifecycle/gate-registry";

describe("api-limits", () => {
  it("gives YNCA the 100 ms of Yamaha's specification, from its per-second limit", () => {
    expect(spacingMs("Yamaha receiver, YNCA commands", 1)).toBe(100);
    expect(COMMAND_SPACING_MS.ynca).toBe(100);
  });

  it("names the counterpart or the window it does not know", () => {
    expect(() => spacingMs("Yamaha receiver, YNCA commands", 5)).toThrow(/no 5-second limit/);
    expect(() => spacingMs("somewhere", 1)).toThrow(/'somewhere'/);
  });

  it("declares every counterpart with a source for each limit", () => {
    expect(API_COUNTERPARTS.length).toBeGreaterThan(0);
    for (const counterpart of API_COUNTERPARTS) {
      expect(counterpart.limits.length).toBeGreaterThan(0);
      for (const limit of counterpart.limits) {
        expect(limit.source.length).toBeGreaterThanOrEqual(8);
      }
    }
  });
});

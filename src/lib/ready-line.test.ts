import { describe, it, expect } from "vitest";
import { readyLine, TRANSPORT_LABELS } from "./ready-line";

describe("readyLine", () => {
  it("lists all three transports in fixed order with a check each", () => {
    expect(readyLine("living", ["ynca", "yxc", "xml"])).toBe("living: ready — YNCA ✓  MusicCast ✓  XML ✓");
  });

  it("keeps the fixed order regardless of the input order", () => {
    expect(readyLine("living", ["xml", "yxc", "ynca"])).toBe("living: ready — YNCA ✓  MusicCast ✓  XML ✓");
  });

  it("lists only the transports that connected", () => {
    expect(readyLine("speaker", ["yxc"])).toBe("speaker: ready — MusicCast ✓");
    expect(readyLine("classic", ["ynca"])).toBe("classic: ready — YNCA ✓");
  });

  it("maps the ids to the user-facing labels from the single source", () => {
    expect(TRANSPORT_LABELS.map(t => t.id)).toEqual(["ynca", "yxc", "xml"]);
    expect(TRANSPORT_LABELS.map(t => t.label)).toEqual(["YNCA", "MusicCast", "XML"]);
  });
});

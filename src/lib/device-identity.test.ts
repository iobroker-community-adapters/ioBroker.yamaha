import { identityFrom, macFromUdn, mergeIdentity, sameDevice } from "./device-identity";

describe("identityFrom", () => {
  it("keeps a hex serial and a 12-digit MAC, trimmed and upper-cased", () => {
    expect(identityFrom({ serial: " 0e897553 ", mac: "00a0ded4f504" })).toEqual({
      serial: "0E897553",
      mac: "00A0DED4F504",
    });
  });

  it("rejects the sanitised fixture values: all zeros and a model-shaped placeholder", () => {
    // The bundled RX-V6A fixture carries `system_id "00000000"` and `device_id "RXV6A0000"`
    // where the real numbers were scrubbed — two such devices are NOT one device.
    expect(identityFrom({ serial: "00000000", mac: "RXV6A0000" })).toBeUndefined();
  });

  it("rejects empty, non-string and short values", () => {
    expect(identityFrom({ serial: "", mac: 12 })).toBeUndefined();
    expect(identityFrom({ serial: "ABC" })).toBeUndefined();
    expect(identityFrom({})).toBeUndefined();
  });

  it("keeps the one valid half", () => {
    expect(identityFrom({ serial: "0B587073", mac: "nope" })).toEqual({ serial: "0B587073" });
    expect(identityFrom({ mac: "00A0DED15025" })).toEqual({ mac: "00A0DED15025" });
  });
});

describe("sameDevice", () => {
  it("is true on an equal serial or an equal MAC", () => {
    expect(sameDevice({ serial: "0B587073" }, { serial: "0B587073", mac: "00A0DED15025" })).toBe(true);
    expect(sameDevice({ mac: "00A0DED15025" }, { serial: "X", mac: "00A0DED15025" })).toBe(true);
  });

  it("is false when nothing equal is set on both sides", () => {
    expect(sameDevice({ serial: "A1B2C3" }, { mac: "00A0DED15025" })).toBe(false);
    expect(sameDevice(undefined, { serial: "A1B2C3" })).toBe(false);
    expect(sameDevice({ serial: "A1B2C3" }, undefined)).toBe(false);
    expect(sameDevice({}, {})).toBe(false);
  });
});

describe("mergeIdentity", () => {
  it("unions the fields, the learned one winning", () => {
    expect(mergeIdentity({ serial: "OLD001" }, { serial: "NEW001", mac: "00A0DED15025" })).toEqual({
      serial: "NEW001",
      mac: "00A0DED15025",
    });
    expect(mergeIdentity({ serial: "OLD001" }, undefined)).toEqual({ serial: "OLD001" });
    expect(mergeIdentity(undefined, { mac: "00A0DED15025" })).toEqual({ mac: "00A0DED15025" });
    expect(mergeIdentity(undefined, undefined)).toBeUndefined();
  });

  // A replacement receiver at the same address: a union kept the old one's MAC next to the new
  // one's serial (audit 2026-09-24, A10).
  it("replaces a contradicting identity instead of mixing it", () => {
    expect(mergeIdentity({ serial: "0A0A0A", mac: "00A0DED15025" }, { serial: "0B0B0B" })).toEqual({
      serial: "0B0B0B",
    });
    // Disjoint fields contradict nothing — they are unioned.
    expect(mergeIdentity({ serial: "0A0A0A" }, { mac: "00A0DED15025" })).toEqual({
      serial: "0A0A0A",
      mac: "00A0DED15025",
    });
  });
});

describe("macFromUdn", () => {
  it("takes the last uuid segment", () => {
    expect(macFromUdn("uuid:00000000-0000-1000-8000-00a0de0a1b2c")).toBe("00A0DE0A1B2C");
  });

  it("is undefined for a uuid without a MAC-shaped tail", () => {
    expect(macFromUdn("uuid:roku:ecp:abc")).toBeUndefined();
    expect(macFromUdn("uuid:00000000-0000-1000-8000-000000000000")).toBeUndefined();
  });
});

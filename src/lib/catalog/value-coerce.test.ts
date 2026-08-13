import { decode, encode, isWritableValue, specToCommon } from "./value-coerce";

describe("specToCommon", () => {
  test("an on/off value becomes a boolean switch", () => {
    const common = specToCommon({ kind: "onoff", on: "On", off: "Off" }, { write: true });
    expect(common.type).toBe("boolean");
    expect(common.role).toBe("switch");
    expect(common.write).toBe(true);
    expect(common.read).toBe(true);
  });

  test("a multi-value enum becomes a string with a states dropdown", () => {
    const states = { HDMI1: "HDMI1", HDMI2: "HDMI2", AV1: "AV1" };
    const common = specToCommon({ kind: "enum", states }, { write: true });
    expect(common.type).toBe("string");
    expect(common.role).toBe("state");
    expect(common.states).toEqual(states);
  });

  test("a numeric value keeps its unit and range and gets a level role when writable", () => {
    const common = specToCommon({ kind: "number", unit: "dB", min: -80, max: 16, step: 0.5 }, { write: true });
    expect(common.type).toBe("number");
    expect(common.role).toBe("level");
    expect(common.unit).toBe("dB");
    expect(common.min).toBe(-80);
    expect(common.max).toBe(16);
    expect(common.step).toBe(0.5);
  });

  test("a read-only numeric value gets a value role", () => {
    const common = specToCommon({ kind: "number", unit: "dB" }, { write: false });
    expect(common.role).toBe("value");
  });

  test("a numeric value without a range omits min/max/step/unit (no undefined fields)", () => {
    const common = specToCommon({ kind: "number" }, { write: false });
    expect(common).not.toHaveProperty("min");
    expect(common).not.toHaveProperty("max");
    expect(common).not.toHaveProperty("step");
    expect(common).not.toHaveProperty("unit");
  });

  test("free text becomes a plain string", () => {
    const common = specToCommon({ kind: "text" }, { write: false });
    expect(common.type).toBe("string");
    expect(common.role).toBe("text");
  });

  test("a coded value becomes a number with a labelled states dropdown", () => {
    const common = specToCommon(
      { kind: "code", codes: { Play: 0, Stop: 1, Pause: 2 }, labels: { 0: "Play", 1: "Stop", 2: "Pause" } },
      { write: true, role: "media.state" },
    );
    expect(common.type).toBe("number");
    expect(common.role).toBe("media.state");
    expect(common.states).toEqual({ 0: "Play", 1: "Stop", 2: "Pause" });
  });

  test("a button becomes a write-only boolean", () => {
    const common = specToCommon({ kind: "button" }, { role: "button.next" });
    expect(common.type).toBe("boolean");
    expect(common.role).toBe("button.next");
    expect(common.read).toBe(false);
    expect(common.write).toBe(true);
  });

  test("a coded value round-trips wire↔code and rejects an unknown wire token", () => {
    const spec = {
      kind: "code" as const,
      codes: { Play: 0, Stop: 1, Pause: 2 },
      labels: { 0: "Play", 1: "Stop", 2: "Pause" },
    };
    expect(decode(spec, "Play")).toBe(0);
    expect(decode(spec, "Pause")).toBe(2);
    expect(decode(spec, "Skip Fwd")).toBeUndefined();
    expect(encode(spec, 0)).toBe("Play");
    expect(encode(spec, 2)).toBe("Pause");
  });

  test("an explicit role override wins", () => {
    const common = specToCommon({ kind: "onoff", on: "On", off: "Standby" }, { write: true, role: "switch.power" });
    expect(common.role).toBe("switch.power");
  });
});

describe("decode", () => {
  test("on/off decodes the on-value to true and anything else to false", () => {
    const spec = { kind: "onoff", on: "On", off: "Off" } as const;
    expect(decode(spec, "On")).toBe(true);
    expect(decode(spec, "Off")).toBe(false);
  });

  test("a numeric value decodes a decimal string to a finite number", () => {
    expect(decode({ kind: "number" }, "-42.5")).toBe(-42.5);
  });

  test("a numeric value rejects a non-decimal string as undefined (no junk in a number field)", () => {
    expect(decode({ kind: "number" }, "N/A")).toBeUndefined();
  });

  test("enum and text decode to the raw string", () => {
    expect(decode({ kind: "enum", states: { HDMI1: "HDMI1" } }, "HDMI1")).toBe("HDMI1");
    expect(decode({ kind: "text" }, "My Scene")).toBe("My Scene");
  });

  test("on/off returns undefined for a wire value that is neither on nor off", () => {
    const spec = { kind: "onoff", on: "On", off: "Standby" } as const;
    expect(decode(spec, "On")).toBe(true);
    expect(decode(spec, "Standby")).toBe(false);
    expect(decode(spec, "Sleep")).toBeUndefined(); // not silently false
  });
});

describe("encode", () => {
  test("on/off encodes a boolean to its wire value", () => {
    const spec = { kind: "onoff", on: "On", off: "Standby" } as const;
    expect(encode(spec, true)).toBe("On");
    expect(encode(spec, false)).toBe("Standby");
  });

  test("a numeric value encodes to a plain decimal string", () => {
    expect(encode({ kind: "number" }, -42.5)).toBe("-42.5");
  });

  test("an enum encodes to its string value", () => {
    expect(encode({ kind: "enum", states: { HDMI1: "HDMI1" } }, "HDMI1")).toBe("HDMI1");
  });
});

describe("isWritableValue", () => {
  test("rejects null and undefined for any state", () => {
    expect(isWritableValue(null, false)).toBe(false);
    expect(isWritableValue(undefined, true)).toBe(false);
  });

  test("rejects a non-finite value for a numeric state", () => {
    expect(isWritableValue("abc", true)).toBe(false);
    expect(isWritableValue(Number.NaN, true)).toBe(false);
    expect(isWritableValue(-42.5, true)).toBe(true);
  });

  test("accepts any non-null value for a non-numeric state", () => {
    expect(isWritableValue("On", false)).toBe(true);
    expect(isWritableValue(true, false)).toBe(true);
  });
});

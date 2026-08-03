import { decode, encode, specToCommon } from "./value-coerce";

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

  test("free text becomes a plain string", () => {
    const common = specToCommon({ kind: "text" }, { write: false });
    expect(common.type).toBe("string");
    expect(common.role).toBe("text");
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

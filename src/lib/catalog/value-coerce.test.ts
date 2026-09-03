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
    // A coded state IS a number state, but a visualisation or a script may write the
    // number as text. Before, the strict lookup found nothing and the bare digit went
    // on the wire instead of the command word.
    expect(encode(spec, "0")).toBe("Play");
    expect(encode(spec, "2")).toBe("Pause");
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

describe("encode formats a decimals-carrying number for the YNCA wire", () => {
  // YNCA float functions require a FIXED decimal count ("VOL=-38.0"): without the
  // decimal point the receiver reads the digits as tenths (-38 became -3.8 dB — the
  // live-confirmed #612 volume bug). The reference formatter is ynca-python's
  // number_to_string_with_stepsize (1 decimal, 0.5 step for VOL).
  const vol = { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 } as const;

  test("a whole-number volume gains its mandatory decimal", () => {
    expect(encode(vol, -38)).toBe("-38.0");
    expect(encode(vol, -40)).toBe("-40.0");
  });

  test("a half-step volume keeps its decimal", () => {
    expect(encode(vol, -37.5)).toBe("-37.5");
  });

  test("an off-grid value snaps to the step grid", () => {
    expect(encode(vol, -37.7)).toBe("-37.5");
    expect(encode(vol, -37.8)).toBe("-38.0");
  });

  test("zero never carries a minus sign", () => {
    expect(encode(vol, 0)).toBe("0.0");
    expect(encode(vol, -0.2)).toBe("0.0");
  });

  test("two decimals for the FM frequency, no snapping without a step", () => {
    expect(encode({ kind: "number", unit: "MHz", decimals: 2 }, 98.1)).toBe("98.10");
    expect(encode({ kind: "number", unit: "MHz", decimals: 2 }, 100.9)).toBe("100.90");
  });

  test("zero decimals yields a rounded integer string", () => {
    expect(encode({ kind: "number", unit: "ms", decimals: 0 }, 12.6)).toBe("13");
    expect(encode({ kind: "number", unit: "ms", decimals: 0 }, -5)).toBe("-5");
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

describe("isWritableValue rejects what must not go on the wire", () => {
  it("refuses an empty or whitespace string for a numeric datapoint", () => {
    // Number("") is 0 and finite — an empty admin field would otherwise be sent
    // as a real 0 (volume to minimum, sleep timer off).
    expect(isWritableValue("", true)).toBe(false);
    expect(isWritableValue("   ", true)).toBe(false);
    expect(isWritableValue("0", true)).toBe(true);
    expect(isWritableValue(0, true)).toBe(true);
  });
});

describe("encode maps a written code back to its wire token", () => {
  it("sends the token, not the number", () => {
    const spec = { kind: "code", codes: { Straight: 0, "5ch Stereo": 1 } } as const;
    // The device speaks the token; the numeric code exists only so the datapoint
    // can carry a dropdown.
    expect(encode(spec as never, 1)).toBe("5ch Stereo");
    // A code that is not in the table still has to produce something sendable.
    expect(encode(spec as never, 9)).toBe("9");
  });
});

describe("decode never reads a button back into a state", () => {
  it("returns nothing for a button spec, whatever the device sent", () => {
    const spec = { kind: "button", command: "Play" } as const;
    // A button is a momentary action. Any value coming back would land in the
    // state and make the next press a no-op (the value did not change).
    expect(decode(spec as never, "On")).toBeUndefined();
    expect(decode(spec as never, "")).toBeUndefined();
  });
});

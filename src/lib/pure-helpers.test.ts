import { legacyDeviceRow, parseDevices, sanitizeId, staleObjects, stripNamespace } from "./pure-helpers";

describe("legacyDeviceRow", () => {
  test("carries over the old single ip when the table is empty", () => {
    expect(legacyDeviceRow({ ip: "1.2.3.4" })).toEqual({ name: "1.2.3.4", ip: "1.2.3.4" });
  });

  test("handles the capitalized legacy IP key", () => {
    expect(legacyDeviceRow({ IP: "1.2.3.4" })).toEqual({ name: "1.2.3.4", ip: "1.2.3.4" });
  });

  test("does nothing when the devices table is already populated", () => {
    expect(legacyDeviceRow({ ip: "1.2.3.4", devices: [{ name: "a", ip: "5.6.7.8" }] })).toBeUndefined();
  });

  test("does nothing without a legacy ip", () => {
    expect(legacyDeviceRow({ devices: [] })).toBeUndefined();
  });
});

describe("staleObjects", () => {
  test("keeps info and configured devices, deletes the rest deepest-first", () => {
    const existing = [
      "yamaha.0.info",
      "yamaha.0.info.connection",
      "yamaha.0.living",
      "yamaha.0.living.power",
      "yamaha.0.oldDevice",
      "yamaha.0.oldDevice.legacyState",
    ];
    expect(staleObjects(existing, new Set(["living"]), "yamaha.0")).toEqual([
      "yamaha.0.oldDevice.legacyState",
      "yamaha.0.oldDevice",
    ]);
  });

  test("keeps a configured device even before its subtree exists, and never touches info", () => {
    expect(staleObjects(["yamaha.0.info", "yamaha.0.living"], new Set(["living"]), "yamaha.0")).toEqual([]);
  });

  test("deletes nothing when no devices are configured (never wipe on an empty table)", () => {
    const existing = ["yamaha.0.info", "yamaha.0.living.power", "yamaha.0.old.state"];
    expect(staleObjects(existing, new Set(), "yamaha.0")).toEqual([]);
  });
});

describe("parseDevices", () => {
  test("maps a configured entry to a device record with empty protocols", () => {
    expect(parseDevices([{ name: "Living", ip: "1.2.3.4" }])).toEqual([
      { id: "Living", ip: "1.2.3.4", protocols: new Set() },
    ]);
  });

  test("drops entries with a missing or empty name or ip, and non-objects", () => {
    const result = parseDevices([
      { name: "ok", ip: "1.1.1.1" },
      { name: "", ip: "2.2.2.2" },
      { name: "no-ip" },
      { ip: "3.3.3.3" },
      "garbage",
      null,
    ]);
    expect(result.map(d => d.id)).toEqual(["ok"]);
  });

  test("returns an empty array for non-array input", () => {
    expect(parseDevices(undefined)).toEqual([]);
    expect(parseDevices(null)).toEqual([]);
    expect(parseDevices("nope")).toEqual([]);
  });

  test("sanitizes the device name into an id-safe id", () => {
    expect(parseDevices([{ name: "Wohn AV", ip: "1.2.3.4" }])[0]?.id).toBe("Wohn_AV");
  });
});

describe("sanitizeId", () => {
  test("replaces id-unsafe characters with underscores", () => {
    expect(sanitizeId("Wohnzimmer AV")).toBe("Wohnzimmer_AV");
    expect(sanitizeId("a.b/c")).toBe("a_b_c");
  });

  test("leaves an already-safe id unchanged", () => {
    expect(sanitizeId("Living-Room_1")).toBe("Living-Room_1");
  });
});

describe("stripNamespace", () => {
  test("removes the adapter namespace prefix from a full state id", () => {
    expect(stripNamespace("yamaha.0.living.power", "yamaha.0")).toBe("living.power");
  });

  test("handles a nested state path", () => {
    expect(stripNamespace("yamaha.0.living.zone2.power", "yamaha.0")).toBe("living.zone2.power");
  });
});

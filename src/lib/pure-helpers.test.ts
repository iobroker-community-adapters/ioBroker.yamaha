import { orphanedObjects, parseDevices, sanitizeId, stripNamespace } from "./pure-helpers";

describe("orphanedObjects", () => {
  test("returns ids not recreated this run, keeping info and created ids", () => {
    const existing = [
      "yamaha.0.info",
      "yamaha.0.info.connection",
      "yamaha.0.living",
      "yamaha.0.living.power",
      "yamaha.0.oldDevice",
      "yamaha.0.oldDevice.legacyState",
    ];
    const created = new Set(["yamaha.0.living", "yamaha.0.living.power"]);
    expect(orphanedObjects(existing, created, "yamaha.0")).toEqual([
      "yamaha.0.oldDevice",
      "yamaha.0.oldDevice.legacyState",
    ]);
  });

  test("deletes nothing when everything is created or in the info branch", () => {
    expect(orphanedObjects(["yamaha.0.info", "yamaha.0.a"], new Set(["yamaha.0.a"]), "yamaha.0")).toEqual([]);
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

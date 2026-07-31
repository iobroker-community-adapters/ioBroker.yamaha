import { parseDevices } from "./pure-helpers";

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
});

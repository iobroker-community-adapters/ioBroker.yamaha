import { DeviceRegistry } from "./device-registry";
import type { DeviceRecord } from "./types";

function device(id: string, ip: string): DeviceRecord {
  return { id, ip, protocols: new Set(["ynca"]) };
}

describe("DeviceRegistry", () => {
  test("stores a device and returns it by id", () => {
    const registry = new DeviceRegistry();
    registry.upsert(device("d1", "1.2.3.4"));
    expect(registry.get("d1")?.ip).toBe("1.2.3.4");
  });

  test("upsert replaces an existing device with the same id", () => {
    const registry = new DeviceRegistry();
    registry.upsert(device("d1", "1.2.3.4"));
    registry.upsert(device("d1", "9.9.9.9"));
    expect(registry.get("d1")?.ip).toBe("9.9.9.9");
  });

  test("returns undefined for an unknown id", () => {
    const registry = new DeviceRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });
});

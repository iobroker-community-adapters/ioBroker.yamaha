import { describe, expect, test } from "vitest";
import { deviceIdFor } from "../lib/device-id";
import { mergeDiscovered, parseDevices, rowDeviceId } from "../lib/pure-helpers";

// Y-09: the device id is the model plus the last four characters of the serial number. It is decided once, stored,
// and never derived again. Only when there is no serial does the model count on with -2, -3.

describe("Y-09 device id = model + last four of the serial, set once", () => {
  test("model and the serial's last four characters, lower case", () => {
    expect(deviceIdFor({ model: "WX-030", identity: { serial: "0B11AA2B3C" }, ip: "10.0.0.5" }, new Set())).toBe(
      "wx-030-2b3c",
    );
    expect(
      deviceIdFor({ model: "RX-V6A", identity: { serial: "Y123456789" }, name: "Living", ip: "10.0.0.6" }, new Set()),
    ).toBe("rx-v6a-6789");
  });

  test("a second device of the same model with the same last four characters gets the whole serial", () => {
    expect(
      deviceIdFor({ model: "WX-010", identity: { serial: "0B11AA22" }, ip: "10.0.0.7" }, new Set(["wx-010-aa22"])),
    ).toBe("wx-010-0b11aa22");
  });

  test("only without a serial: the model, then -2, -3", () => {
    expect(deviceIdFor({ model: "RX-V473", ip: "10.0.0.8" }, new Set())).toBe("rx-v473");
    expect(deviceIdFor({ model: "RX-V473", ip: "10.0.0.9" }, new Set(["rx-v473"]))).toBe("rx-v473-2");
    expect(deviceIdFor({ model: "RX-V473", ip: "10.0.0.10" }, new Set(["rx-v473", "rx-v473-2"]))).toBe("rx-v473-3");
  });

  test("a stored id is read back as it is — a new name or address never derives another one", () => {
    expect(rowDeviceId({ id: "wx-030-2b3c", name: "Kitchen", ip: "10.0.0.5" })).toBe("wx-030-2b3c");
    expect(rowDeviceId({ id: "wx-030-2b3c", name: "Bath", ip: "10.0.0.99" })).toBe("wx-030-2b3c");
    expect(parseDevices([{ id: "wx-030-2b3c", name: "Renamed", ip: "10.0.0.42" }]).map(d => d.id)).toEqual([
      "wx-030-2b3c",
    ]);
  });

  test("a remembered device found again keeps its id, even when it now reports another model or name", () => {
    const known = [{ id: "wx-030-2b3c", ip: "10.0.0.5", identity: { serial: "0B11AA2B3C" }, model: "WX-030" }];
    const merged = mergeDiscovered(known, [
      { ip: "10.0.0.5", name: "Bath speaker", model: "WX-031", identity: { serial: "0B11AA2B3C" } },
    ]);
    expect(merged.map(d => d.id)).toEqual(["wx-030-2b3c"]);
  });

  test("a new find gets its id from model and serial", () => {
    const merged = mergeDiscovered(
      [],
      [{ ip: "10.0.0.5", name: "Kitchen", model: "WX-030", identity: { serial: "0B11AA2B3C" } }],
    );
    expect(merged.map(d => d.id)).toEqual(["wx-030-2b3c"]);
  });
});

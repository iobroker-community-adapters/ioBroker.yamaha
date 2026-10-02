import { describe, expect, test } from "vitest";
import { mergeDiscovered, unionDevices } from "../lib/pure-helpers";

// Y-28: a device at a new address is not an offline device. It is recognised by what it is (serial/MAC), keeps its
// id and its tree, and is reached at the new address. A device that is not found is kept as it is. An address the
// user typed by hand is used as typed — the adapter does not follow the device away from it.

const KITCHEN = { id: "wx-030-2b3c", ip: "10.0.0.5", identity: { serial: "0B11AA2B3C" }, model: "WX-030" };

describe("Y-28 a new address is not offline; a typed address is the user's", () => {
  test("the same device at a new address keeps its id and is reached at the new address", () => {
    const merged = mergeDiscovered(
      [{ ...KITCHEN }],
      [{ ip: "10.0.0.77", name: "Kitchen", model: "WX-030", identity: { serial: "0B11AA2B3C" } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "wx-030-2b3c", ip: "10.0.0.77" });
  });

  test("recognised by its MAC as well, renamed and moved at once", () => {
    const merged = mergeDiscovered(
      [{ id: "rx-v6a-6789", ip: "10.0.0.6", identity: { mac: "00A0DE0A1B2C" } }],
      [{ ip: "10.0.0.66", name: "Wohnzimmer", model: "RX-V6A", identity: { mac: "00A0DE0A1B2C" } }],
    );
    expect(merged).toEqual([expect.objectContaining({ id: "rx-v6a-6789", ip: "10.0.0.66" })]);
  });

  test("a device the search does not find is offline, not gone: its record stays as it was", () => {
    const merged = mergeDiscovered([{ ...KITCHEN }], []);
    expect(merged).toEqual([KITCHEN]);
  });

  test("another device that took over the old address is not the remembered one", () => {
    const merged = mergeDiscovered(
      [{ ...KITCHEN }],
      [{ ip: "10.0.0.5", name: "Bath", model: "WX-021", identity: { serial: "0C22BB4D5E" } }],
    );
    expect(merged).toEqual([KITCHEN]);
  });

  test("an address typed by hand wins: the found record of the same device does not move it", () => {
    const running = unionDevices(
      [{ id: "wx-030-2b3c", ip: "10.0.0.5", source: "manual" }],
      [{ id: "wx-030-2b3c", ip: "10.0.0.77", identity: { serial: "0B11AA2B3C" } }],
    );
    expect(running).toEqual([{ id: "wx-030-2b3c", ip: "10.0.0.5", source: "manual" }]);
  });
});

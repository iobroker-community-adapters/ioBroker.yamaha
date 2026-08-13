import { coordinateObjectTree } from "./object-tree-coordinator";
import type { ObjectDef } from "./types";

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}
function channel(id: string, name: string): ObjectDef {
  return { id, type: "channel", common: { name } };
}

describe("coordinateObjectTree — one unified tree from the transports' catalogs", () => {
  test("a shared capability is emitted once, from its owner, under the canonical id", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "ynca", objects: [state("volume", "Volume dB", { unit: "dB" }), state("sound.bass", "Bass")] },
      { transport: "yxc", objects: [state("volume", "Volume raw"), state("dist.role", "Role", { type: "string" })] },
    ]);
    const ids = objects.map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(["volume", "sound.bass", "dist.role"]));
    // volume shared → YNCA owner (dB, not YXC's raw scale)
    expect(objects.filter(o => o.id === "volume").length).toBe(1);
    expect(objects.find(o => o.id === "volume")?.common.name).toBe("Volume dB");
    expect(ownerByCanonicalId.get("volume")).toBe("ynca");
    // sound.bass is YNCA's own id already — no drift needed since the catalog rename
    expect(objects.some(o => o.id === "bass")).toBe(false);
    // dist.role is YXC-exclusive
    expect(ownerByCanonicalId.get("dist.role")).toBe("yxc");
  });

  test("the most modern transport wins an equal shared capability (YXC over YNCA)", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "ynca", objects: [state("power", "Power YNCA", { type: "boolean" })] },
      { transport: "yxc", objects: [state("power", "Power YXC", { type: "boolean" })] },
    ]);
    expect(objects.find(o => o.id === "power")?.common.name).toBe("Power YXC");
    expect(ownerByCanonicalId.get("power")).toBe("yxc");
  });

  test("a zoned shared capability collapses per-zone across transports", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [state("zone2.volume", "Z2 dB")] },
      { transport: "yxc", objects: [state("zone2.volume", "Z2 raw")] },
    ]);
    expect(objects.filter(o => o.id === "zone2.volume").length).toBe(1);
    expect(objects.find(o => o.id === "zone2.volume")?.common.name).toBe("Z2 dB");
  });

  test("parents come before children (channels before their states)", () => {
    const { objects } = coordinateObjectTree([
      { transport: "yxc", objects: [state("dist.role", "Role"), channel("dist", "Multiroom")] },
    ]);
    const distIdx = objects.findIndex(o => o.id === "dist");
    const roleIdx = objects.findIndex(o => o.id === "dist.role");
    expect(distIdx).toBeGreaterThanOrEqual(0);
    expect(distIdx).toBeLessThan(roleIdx);
  });
});

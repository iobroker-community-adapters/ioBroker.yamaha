import { describe, expect, test } from "vitest";
import { catalogToObjects } from "../lib/catalog/build-objects";
import { zoneRole, type ObjectDef } from "../lib/catalog/types";
import { CommandGate } from "../lib/lifecycle/command-gate";
import { DISCOVERY_SCHEMA } from "../lib/lifecycle/discovery-schema";
import { ProbeMemory } from "../lib/lifecycle/probe-memory";
import { RENAMED_STATE_IDS } from "../lib/pure-helpers";
import { YNCA_CATALOG } from "../lib/ynca/catalog";
import { XML_AMP_CATALOG } from "../lib/xml/catalog";
import { XmlDeviceController } from "../lib/xml/device-controller";

// Y-35 (krobi 2026-10-05 22:47 "y35 yes", 23:15 "would be uniform, yes do it"): Zone B is named like every other
// zone — multiroom.zoneB.* with power, mute, volume and the zone name, the same names, roles and ids as zones 2 to 4.

const FORM = ["power", "mute", "volume", "zoneName"] as const;

/** A datapoint directly in a zone folder whose id is `name` — the id Zone B's zone name had before. */
const NAME_ID = /^multiroom\.zone[2-4B]\.name$/;

const en = (name: unknown): string | undefined => (name as { en?: string } | undefined)?.en;

/**
 * The tree the XML controller builds for a receiver that reports a Zone B name in its main zone's Config.
 *
 * @returns the definitions, by id relative to the device
 */
async function xmlTree(): Promise<Map<string, ObjectDef>> {
  const config =
    '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Config><Name><Zone>Living</Zone><Zone_B>Patio</Zone_B></Name>' +
    "</Config></Main_Zone></YAMAHA_AV>";
  const defs = new Map<string, ObjectDef>();
  const controller = new XmlDeviceController("living", {
    gate: new CommandGate({
      minSpacingMs: 0,
      timers: {
        schedule: (h, ms) => setTimeout(h, ms),
        cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>),
      },
    }),
    probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
    client: {
      getStatus: (zone: string) =>
        Promise.resolve(
          zone === "Main_Zone" ? { power: true, zoneBPower: true, zoneBMute: false, zoneBVolume: -30 } : {},
        ),
      getSystemConfig: () => Promise.resolve({}),
      getDescriptor: () => Promise.resolve(""),
      send: () => Promise.resolve(),
      getXml: (zone: string, inner: string) =>
        Promise.resolve(zone === "Main_Zone" && inner === "<Config>GetParam</Config>" ? config : ""),
    },
    scheduleKeepalive: () => () => undefined,
    upsertObject: (id, def) => {
      defs.set(id.replace(/^living\./, ""), def);
      return Promise.resolve();
    },
    setStateAck: () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    host: "192.0.2.10",
  });
  await controller.start();
  controller.close();
  return defs;
}

describe("Y-35 Zone B is named like every other zone", () => {
  test("YNCA: Zone B carries power, mute, volume and zoneName, read like zone 2's", () => {
    const built = catalogToObjects(YNCA_CATALOG.filter(entry => /^multiroom\.zone[2B]\./.test(entry.id)));
    const form = (zone: string, id: string): [string | undefined, unknown] => {
      const common = built.find(o => o.id === `multiroom.${zone}.${id}`)?.common;
      return [en(common?.name), common?.role];
    };
    for (const id of FORM) {
      expect([id, ...form("zoneB", id)]).toEqual([id, ...form("zone2", id)]);
    }
    expect(form("zoneB", "zoneName")).toEqual(["Zone name", "text"]);
    expect(form("zoneB", "power")).toEqual(["Power", "switch.power.zone"]);
  });

  test("XML: Zone B's power, mute and volume take the zone's names, and its power the zone role", () => {
    const entry = (state: string): (typeof XML_AMP_CATALOG)[number] | undefined =>
      XML_AMP_CATALOG.find(e => e.state === state);
    for (const id of ["power", "mute", "volume"]) {
      expect([id, entry(`multiroom.zoneB.${id}`)?.common.nameKey]).toEqual([id, entry(id)?.common.nameKey]);
    }
    const power = entry("multiroom.zoneB.power")?.common.role;
    expect(zoneRole(power, "multiroom.zoneB.power")).toBe("switch.power.zone");
    expect(zoneRole(power, "multiroom.zone2.power")).toBe("switch.power.zone");
  });

  test("XML: the controller builds Zone B's name under zoneName", async () => {
    const tree = await xmlTree();
    expect(en(tree.get("multiroom.zoneB.zoneName")?.common.name)).toBe("Zone name");
    expect([...tree.keys()]).toEqual(expect.arrayContaining(["multiroom.zoneB.power", "multiroom.zoneB.volume"]));
  });

  test("no zone carries a datapoint with the id name, on YNCA or XML, and the update removes the old one", async () => {
    const ids = [
      ...YNCA_CATALOG.map(entry => entry.id),
      ...XML_AMP_CATALOG.map(e => e.state),
      ...(await xmlTree()).keys(),
    ];
    expect(ids.filter(id => NAME_ID.test(id))).toEqual([]);
    // An existing installation loses the old id with the update.
    expect(RENAMED_STATE_IDS).toContain("multiroom.zoneB.name");
  });
});

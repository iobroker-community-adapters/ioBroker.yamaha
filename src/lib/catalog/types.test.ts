import { channelCommon, zoneRole } from "./types";
import { YNCA_CATALOG } from "../ynca/catalog";

describe("channelCommon", () => {
  test("names a listed folder from the table and explains it where the table does", () => {
    const zone = channelCommon("zoneB");
    expect((zone.name as Record<string, string>).en).toBe("Zone B");
    expect(zone.desc).toBeDefined();
  });

  // Review 2026-10-05, A35: a segment can be the device's word (a MusicCast alarm day) — an inherited property name
  // among them is no key of the tables.
  test("names an unlisted segment after itself, an inherited property name included", () => {
    expect(channelCommon("monday")).toEqual({ name: "Monday" });
    expect(channelCommon("constructor")).toEqual({ name: "Constructor" });
    expect(channelCommon("toString")).toEqual({ name: "ToString" });
  });
});

// A zone's power switch is `switch.power.zone`, the main zone's `switch.power` (audit 2026-09-29, C41) — and a zone is
// what the tree files as one, Zone B included (review 2026-10-05, A27).
describe("zoneRole", () => {
  test("a zone prefix makes the power switch a zone's", () => {
    expect(zoneRole("switch.power", "")).toBe("switch.power");
    expect(zoneRole("switch.power", "multiroom.zone2.")).toBe("switch.power.zone");
    expect(zoneRole("switch.power", "multiroom.zone4.")).toBe("switch.power.zone");
    expect(zoneRole("switch.power", "multiroom.zoneB.")).toBe("switch.power.zone");
  });

  test("judged by the state id, Zone B's switch is a zone's — as MusicCast builds it", () => {
    // YNCA and XML build Zone B as main-zone entries: by a non-empty prefix it stayed `switch.power` there.
    expect(zoneRole("switch.power", "multiroom.zoneB.power")).toBe("switch.power.zone");
    expect(zoneRole("switch.power", "multiroom.zone3.power")).toBe("switch.power.zone");
    expect(zoneRole("switch.power", "power")).toBe("switch.power");
    expect(zoneRole("switch.power", "multiroom.masterPower")).toBe("switch.power");
  });

  test("a prefix that is no zone folder makes no zone, and other roles stay", () => {
    expect(zoneRole("switch.power", "tuner.")).toBe("switch.power");
    expect(zoneRole("switch", "multiroom.zone2.")).toBe("switch");
    expect(zoneRole(undefined, "multiroom.zone2.")).toBeUndefined();
  });

  test("the YNCA zones keep their zone role through the prefix they pass", () => {
    const role = (id: string): string | undefined => YNCA_CATALOG.find(entry => entry.id === id)?.role;
    expect(role("power")).toBe("switch.power");
    expect(role("multiroom.zone2.power")).toBe("switch.power.zone");
    expect(role("multiroom.zone4.power")).toBe("switch.power.zone");
  });
});

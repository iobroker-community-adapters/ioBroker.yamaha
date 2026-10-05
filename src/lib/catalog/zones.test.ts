import { ANY_ZONE_PREFIX, splitZone, ZONE_B_PREFIX, ZONE_KEYS, ZONE_PREFIX, ZONES, zonePrefix } from "./zones";
import { YNCA_ZONES } from "../ynca/catalog";
import { XML_ZONES } from "../xml/zones";

// One zone table for every transport (audit 2026-09-29, A25): a copy that did not move with the zones
// once broke the MusicCast equalizer cache for zones 2–4.
describe("the one zone table", () => {
  test("every transport's zones are the table's, in its order", () => {
    expect(YNCA_ZONES.map(zone => [zone.key, zone.subunit, zone.prefix])).toEqual(
      ZONES.map(zone => [zone.key, zone.ynca, zone.prefix]),
    );
    expect(XML_ZONES.map(zone => [zone.key, zone.element, zone.prefix])).toEqual(
      ZONES.map(zone => [zone.key, zone.xml, zone.prefix]),
    );
  });

  test("the prefix and the split follow the table", () => {
    expect(zonePrefix("main")).toBe("");
    expect(zonePrefix("zone3")).toBe("multiroom.zone3.");
    expect(splitZone("multiroom.zone2.player.play")).toEqual({ zone: "zone2", name: "player.play" });
    expect(splitZone("multiroom.zoneB.volume")).toEqual({ zone: "main", name: "multiroom.zoneB.volume" });
    expect(splitZone("volume")).toEqual({ zone: "main", name: "volume" });
    expect(ZONE_PREFIX.exec("multiroom.zone4.sleep")?.[0]).toBe("multiroom.zone4.");
    expect(ZONE_PREFIX.test("zone2.sleep")).toBe(false);
    // The upgrade cleanup still recognises the flat form of the trees before v0.19.0.
    expect(ANY_ZONE_PREFIX.exec("zone2.sleep")?.[0]).toBe("zone2.");
    expect(ANY_ZONE_PREFIX.exec("multiroom.zone2.sleep")?.[0]).toBe("multiroom.zone2.");
  });

  test("Zone B is a zone folder for every rule that reads one, but no transport zone (A27)", () => {
    expect(ZONE_PREFIX.exec("multiroom.zoneB.volume")?.[0]).toBe(ZONE_B_PREFIX);
    expect(ZONE_PREFIX.exec("multiroom.zoneB.player.artist")?.[0]).toBe("multiroom.zoneB.");
    // YNCA and XML address it through the main zone, so the transport split keeps it there.
    expect(splitZone("multiroom.zoneB.power")).toEqual({ zone: "main", name: "multiroom.zoneB.power" });
    expect(ZONE_KEYS).not.toContain("zoneB");
    // Device-wide multiroom states are no zone folder.
    expect(ZONE_PREFIX.test("multiroom.masterPower")).toBe(false);
    expect(ZONE_PREFIX.test("multiroom.group.role")).toBe(false);
  });
});

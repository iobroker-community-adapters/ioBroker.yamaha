import { xmlHarness } from "../../../test/helpers/xml-controller";

// Review 2026-10-05, A27: Zone B stood outside the zone table — `multiroom.zoneB.power` read "Zone B power" with role
// `switch.power` over XML and "Power" with `switch.power.zone` over MusicCast (whose zone2 is Zone B there).

const en = (name: unknown): string | undefined => (name as { en?: string } | undefined)?.en;

describe("Zone B takes the zone form over XML (review 2026-10-05, A27)", () => {
  test("power, mute, volume and name read as a zone's; availability and interlock keep their names", async () => {
    const h = xmlHarness({
      Main_Zone: {
        power: true,
        zoneBPower: true,
        zoneBMute: false,
        zoneBVolume: -30,
        zoneBAvailable: "Ready",
        zoneBInterlock: false,
      },
    });
    h.client.xmlAnswers["Main_Zone|<Config>GetParam</Config>"] =
      '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Config><Name><Zone>Living</Zone><Zone_B>Patio</Zone_B></Name></Config></Main_Zone></YAMAHA_AV>';
    await h.controller.start();
    const common = (id: string): { name?: unknown; role?: string; desc?: unknown } | undefined =>
      h.defs.get(`living.multiroom.zoneB.${id}`)?.common;
    expect(common("power")).toMatchObject({ role: "switch.power.zone" });
    expect(en(common("power")?.name)).toBe("Power");
    expect(en(common("mute")?.name)).toBe("Mute");
    expect(en(common("volume")?.name)).toBe("Volume");
    expect(common("volume")?.desc).toBeDefined();
    expect(en(common("zoneName")?.name)).toBe("Zone name");
    expect(en(common("available")?.name)).toBe("Zone B availability");
    expect(en(common("interlock")?.name)).toBe("Zone B volume interlock");
    // The main zone's own power stays the main switch.
    expect(h.defs.get("living.power")?.common.role).toBe("switch.power");
  });
});

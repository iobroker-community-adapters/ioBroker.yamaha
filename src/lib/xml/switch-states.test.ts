import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canCarryWrite, coordinateObjectTree, keepsForm } from "../catalog/object-tree-coordinator";
import type { ObjectDef } from "../catalog/types";
import { settle, xmlHarness } from "../../../test/helpers/xml-controller";

// Review 2026-10-05, A19: a boolean switch took the descriptor's Put_1 words as its dropdown — `power` carried
// {"On","Standby"} on `type: boolean` (inventory rx-v3900). "Standby" sent nothing, the words were lent to the
// YNCA-owned boolean, and no other protocol's switch ever had the same form (keepsForm / canCarryWrite, Y-04).

const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", name), "utf8");
/** The 2008 generation's own description (RX-V3900, inventory fixture). */
const RX_V3900 = (
  JSON.parse(readFileSync(join(__dirname, "../../../test/fixtures/inventory/rxv3900.json"), "utf8")) as {
    xml: { descriptor: string };
  }
).xml.descriptor;

const SWITCHES = [
  "living.power",
  "living.mute",
  "living.sound.pureDirect",
  "living.sound.enhancer",
  "living.sound.extraBass",
  "living.sound.ypaoVolume",
  "living.sound.cinemaDsp3d",
];

describe("a switch is a boolean without the descriptor's words (review 2026-10-05, A19)", () => {
  test("RX-V675 (2009–2017): the declared switches carry no dropdown", async () => {
    const h = xmlHarness({
      Main_Zone: {
        power: true,
        mute: false,
        pureDirect: false,
        enhancer: true,
        extraBass: false,
        ypaoVolume: true,
        cinemaDsp3d: true,
      },
    });
    h.client.descriptor = fixture("desc-rx-v675.xml");
    await h.controller.start();
    for (const id of SWITCHES) {
      // Writable or not as the description declares (the RX-V675 declares no Extra_Bass write) — a boolean either way.
      expect(h.defs.get(id)?.common.type, id).toBe("boolean");
      expect(h.defs.get(id)?.common.states, id).toBeUndefined();
    }
  });

  test("RX-V3900 (2008): power and mute are plain switches too", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, mute: false, volume: -46, dialect: "legacy" } });
    h.client.descriptor = RX_V3900;
    await h.controller.start();
    expect(h.defs.get("living.power")?.common.states).toBeUndefined();
    expect(h.defs.get("living.mute")?.common.states).toBeUndefined();
  });

  test("a text datapoint keeps the words it is declared with (RX-A2060 zone 2 tone mode)", async () => {
    const h = xmlHarness({ Main_Zone: { power: true }, Zone_2: { power: true, toneMode: "Auto" } });
    h.client.descriptor = fixture("desc-rx-a2060.xml");
    await h.controller.start();
    expect(h.defs.get("living.multiroom.zone2.sound.toneMode")?.common.states).toEqual({
      Auto: "Auto",
      Bypass: "Bypass",
      Manual: "Manual",
    });
  });

  test('the word a switch was offered is no value it takes: "Standby" sends nothing and says so', async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.descriptor = fixture("desc-rx-v675.xml");
    await h.controller.start();
    h.client.calls.length = 0;
    expect(h.controller.handleWrite("power", "Standby")).toBe("unavailable");
    await settle();
    expect(h.client.sent()).toEqual([]);
    // A switch takes the switch words every protocol reads alike.
    await expect(Promise.resolve(h.controller.handleWrite("power", "off"))).resolves.toBe("sent");
    expect(h.client.sent()).toEqual(["Main_Zone:<Power_Control><Power>Standby</Power></Power_Control>"]);
  });

  test("the XML switch has the form of every other protocol's: nothing lent, the takeover and the fallback match", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.descriptor = fixture("desc-rx-v675.xml");
    await h.controller.start();
    const xml = { ...h.defs.get("living.power")!, id: "power" };
    const plain: ObjectDef = {
      id: "power",
      type: "state",
      common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
    };
    const tree = coordinateObjectTree([
      { transport: "ynca", objects: [plain] },
      { transport: "xml", objects: [xml] },
    ]);
    expect(tree.objects.find(object => object.id === "power")?.common.states).toBeUndefined();
    expect(keepsForm({ type: "state", common: xml.common }, plain)).toBe(true);
    expect(canCarryWrite({ transport: "yxc", def: plain }, { transport: "xml", def: xml })).toBe(true);
  });
});

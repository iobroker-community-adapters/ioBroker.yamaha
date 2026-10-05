import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MultiTransportHandle,
  type ConnectableTransport,
  type WriteOutcome,
} from "../lifecycle/multi-transport-handle";
import { TransportConnectionAdapter } from "../lifecycle/transport-connection-adapter";
import type { LearnedTree } from "../lifecycle/learned-tree";
import type { ObjectDef } from "../catalog/types";
import { XmlRefusalError } from "./protocol";
import { settle, xmlHarness, type XmlHarness } from "../../../test/helpers/xml-controller";

// Review 2026-10-05, A3: the scene, tuner, all-zones power, contents display, party volume, zone name and key writes
// discarded their outcome (`void this.applyCommand`), which the handle reads as "unclear" — so a refusal never tried
// the next protocol (Y-04). A56: the writes XML dropped itself (an unknown scene, an invalid preset or band) left no
// trace at all.

const A2060 = readFileSync(join(__dirname, "__fixtures__", "desc-rx-a2060.xml"), "utf8");
const SCENES = "<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>";
const sceneList =
  '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Scene><Scene_Sel_Item>' +
  "<Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie</Title></Item_1>" +
  "<Item_2><Param>Scene 2</Param><RW>W</RW><Title>Radio</Title></Item_2>" +
  "</Scene_Sel_Item></Scene></Main_Zone></YAMAHA_AV>";

/**
 * An RX-A2060 that answers every declared extra: scenes, the tuner, the all-zones power, the contents display, the
 * zone names — the device on which each write route of the controller exists.
 *
 * @returns the started harness
 */
async function fullDevice(): Promise<XmlHarness> {
  const h = xmlHarness({ Main_Zone: { power: true, volume: -40, input: "HDMI1" }, Zone_2: { power: true } });
  h.client.descriptor = A2060;
  h.client.xmlAnswers[`Main_Zone|${SCENES}`] = sceneList;
  h.client.xmlAnswers["Tuner|<Play_Info>GetParam</Play_Info>"] =
    '<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Info><Preset><Preset_Sel>1</Preset_Sel></Preset><Tuning><Band>FM</Band>' +
    "<Freq><Current><Val>9810</Val><Exp>2</Exp><Unit>MHz</Unit></Current></Freq></Tuning></Play_Info></Tuner></YAMAHA_AV>";
  h.client.xmlAnswers["System|<Power_Control><Power>GetParam</Power></Power_Control>"] =
    '<YAMAHA_AV rsp="GET" RC="0"><System><Power_Control><Power>On</Power></Power_Control></System></YAMAHA_AV>';
  h.client.xmlAnswers["Main_Zone|<Cursor_Control><Contents_Display>GetParam</Contents_Display></Cursor_Control>"] =
    '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Cursor_Control><Contents_Display>On</Contents_Display></Cursor_Control></Main_Zone></YAMAHA_AV>';
  h.client.xmlAnswers["Main_Zone|<Config>GetParam</Config>"] =
    '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Config><Name><Zone>Living</Zone></Name></Config></Main_Zone></YAMAHA_AV>';
  expect(await h.controller.start()).toBe(true);
  return h;
}

/** Each route's write, with a value it takes. */
const ROUTES: Array<[string, unknown]> = [
  ["scene.recall", 2],
  ["scene.recall", "Radio"],
  ["tuner.preset", 3],
  ["tuner.band", "AM"],
  ["tuner.frequency", 98500],
  ["multiroom.masterPower", false],
  ["sound.contentsDisplay", false],
  ["multiroom.partyVolumeUp", true],
  ["zoneName", "Den"],
  ["remote.cursor", "up"],
  ["multiroom.zone2.remote.menu", "option"],
  ["player.pause", true],
  ["volume", -35],
];

describe("every XML write says what became of it (review 2026-10-05, A3)", () => {
  test.each(ROUTES)("%s = %j: sent, refused, or not sendable", async (id, value) => {
    const h = await fullDevice();
    await expect(Promise.resolve(h.controller.handleWrite(id, value))).resolves.toBe("sent");
    h.client.sendError = new XmlRefusalError("<Main_Zone>", 3);
    await expect(Promise.resolve(h.controller.handleWrite(id, value))).resolves.toBe("refused");
    h.client.sendError = new Error("ECONNRESET");
    await expect(Promise.resolve(h.controller.handleWrite(id, value))).resolves.toBe("unavailable");
    await settle();
  });

  test("the menu and the main zone's remote answer with the browse engine's own outcome", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.xmlAnswers["NET_RADIO|<List_Info>GetParam</List_Info>"] =
      '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><List_Info><Menu_Status>Ready</Menu_Status><Menu_Layer>1</Menu_Layer>' +
      "<Menu_Name>NET RADIO</Menu_Name><Current_List><Line_1><Txt>Bookmarks</Txt><Attribute>Container</Attribute></Line_1>" +
      "</Current_List><Cursor_Position><Current_Line>1</Current_Line><Max_Line>1</Max_Line></Cursor_Position></List_Info></NET_RADIO></YAMAHA_AV>";
    await h.controller.start();
    expect(h.controller.handleWrite("player.browse.source", "netRadio")).toBe("sent");
    expect(h.controller.handleWrite("player.browse.source", "bluetooth")).toBe("unavailable");
    expect(h.controller.handleWrite("remote.cursor", "up")).toBe("sent");
    expect(h.controller.handleWrite("remote.cursor", "sideways")).toBe("unavailable");
    await settle();
  });
});

describe("a write XML cannot send is unavailable and leaves a trace (review 2026-10-05, A56)", () => {
  test.each([
    ["scene.recall", "Party", "it names no scene this zone declares"],
    ["scene.recall", 7, "it names no scene this zone declares"],
    ["tuner.preset", 0, "it names no preset slot"],
    ["tuner.band", "LW", "the tuner takes AM or FM"],
    ["multiroom.masterPower", "maybe", "it is no switch value"],
    ["sound.contentsDisplay", "maybe", "it is no switch value"],
    ["multiroom.zone2.remote.cursor", "sideways", "it is no key this receiver declares"],
    ["zoneName", "Living Room", "it is longer than the 9 characters the device accepts"],
    ["zoneName", 5, "it is no text"],
    ["sound.bass", 3, "this device did not report it"],
    ["power", "maybe", "it is no value this datapoint takes"],
  ])("%s = %j", async (id, value, reason) => {
    const h = await fullDevice();
    h.client.calls.length = 0;
    expect(h.controller.handleWrite(id, value)).toBe("unavailable");
    await settle();
    expect(h.client.sent()).toEqual([]);
    expect(h.debugs).toContain(`living: ${id} = ${JSON.stringify(value)} not sent — ${reason}`);
  });

  test("a menu write on a device without a proven menu says so", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    await h.controller.start();
    expect(h.controller.handleWrite("player.browse.source", "netRadio")).toBe("unavailable");
    expect(h.debugs).toContain('living: player.browse.source = "netRadio" not sent — this device proved no menu');
  });

  test("a write to the tuner of a device without one says so", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    await h.controller.start();
    expect(h.controller.handleWrite("tuner.preset", 2)).toBe("unavailable");
    expect(h.debugs).toContain("living: tuner.preset = 2 not sent — this device answered no tuner");
  });
});

// The fallback itself, end to end: on a YNCA+XML receiver the scene recall belongs to XML (owner override, #615);
// when XML's command is refused, the handle sends the same value through YNCA (Y-04).
describe("a scene recall XML refuses goes to YNCA (Y-04, review 2026-10-05 A3)", () => {
  const YNCA_SCENE: ObjectDef = {
    id: "scene.recall",
    type: "state",
    common: { name: "Recall scene", type: "number", role: "level", read: true, write: true, min: 1, max: 12, step: 1 },
  };

  /**
   * A YNCA transport that serves `scene.recall` and records what it was asked to write.
   *
   * @param writes collects the values written through it
   * @returns the transport
   */
  function ynca(writes: unknown[]): ConnectableTransport {
    return {
      transport: "ynca",
      connect: () => Promise.resolve(true),
      buildObjects: () => [YNCA_SCENE],
      seedOwned: () => undefined,
      handleWrite: (_id, value): Promise<WriteOutcome> => {
        writes.push(value);
        return Promise.resolve("sent");
      },
      onDrop: () => undefined,
      close: () => undefined,
    };
  }

  test.each([
    [new XmlRefusalError("<Main_Zone><Scene>", 4), 1],
    [new Error("ECONNRESET"), 1],
    [undefined, 0],
  ])("XML answers %s → YNCA receives %d write(s)", async (failure, expected) => {
    const xml = new TransportConnectionAdapter("xml", "living", () => undefined);
    const h = xmlHarness({ Main_Zone: { power: true } }, undefined, {
      upsertObject: xml.interceptUpsert,
      setStateAck: xml.interceptSetStateAck,
    });
    h.client.xmlAnswers[`Main_Zone|${SCENES}`] = sceneList;
    h.client.sendError = failure;
    xml.bind(h.controller);
    // The connect attempt connects every transport before it hands the live set to the handle.
    expect(await xml.connect()).toBe(true);
    const writes: unknown[] = [];
    const store: { tree: LearnedTree } = { tree: { shared: {}, transports: [], firmware: {} } };
    const handle = new MultiTransportHandle("living", [xml, ynca(writes)], {
      upsertObject: () => Promise.resolve(),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      adapterVersion: "3.2.0",
      tree: { get: () => store.tree, set: tree => (store.tree = tree) },
      settleTree: () => Promise.resolve(),
    });
    await handle.start();
    handle.handleStateChange("living.scene.recall", false, 2);
    await settle(10);
    expect(h.client.sent()).toEqual(["Main_Zone:<Scene><Scene_Sel>Scene 2</Scene_Sel></Scene>"]);
    expect(writes).toHaveLength(expected);
    handle.close();
  });
});

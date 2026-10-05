import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settle, xmlHarness } from "../../../test/helpers/xml-controller";

// Decision C3 (review 2026-10-05): the RX-V473's description declares its pad under `Main_Zone,List_Control` —
// Cursor (Up … Return to Home) and Menu_Control (On Screen, Option, Display). desc.xml decides: the code knew only
// `Cursor_Control`. A51: the menu switched the input unconditionally (the RX-V3900's iPod is read-only) and an
// unguarded nudge could cost the window.

const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", name), "utf8");
const LIST = (element: string, lines: string): string =>
  `<YAMAHA_AV rsp="GET" RC="0"><${element}><List_Info><Menu_Status>Ready</Menu_Status><Menu_Layer>1</Menu_Layer>` +
  `<Menu_Name>${element}</Menu_Name><Current_List>${lines}</Current_List><Cursor_Position><Current_Line>1</Current_Line>` +
  `<Max_Line>1</Max_Line></Cursor_Position></List_Info></${element}></YAMAHA_AV>`;
const BOOKMARKS = "<Line_1><Txt>Bookmarks</Txt><Attribute>Container</Attribute></Line_1>";

describe("the zone pad desc.xml declares, on its path, with its keys (decision C3)", () => {
  test("RX-V473 without a menu source: remote.cursor and remote.menu of the main zone go through List_Control", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.descriptor = fixture("desc-rx-v473.xml");
    await h.controller.start();
    expect(Object.keys(h.defs.get("living.remote.cursor")?.common.states ?? {})).toEqual([
      "up",
      "down",
      "left",
      "right",
      "select",
      "return",
      "home",
    ]);
    expect(Object.keys(h.defs.get("living.remote.menu")?.common.states ?? {})).toEqual([
      "on_screen",
      "option",
      "display",
    ]);
    h.client.calls.length = 0;
    await h.controller.handleWrite("remote.cursor", "select");
    await h.controller.handleWrite("remote.menu", "option");
    expect(h.controller.handleWrite("remote.menu", "top_menu")).toBe("unavailable");
    expect(h.client.sent()).toEqual([
      "Main_Zone:<List_Control><Cursor>Sel</Cursor></List_Control>",
      "Main_Zone:<List_Control><Menu_Control>Option</Menu_Control></List_Control>",
    ]);
  });

  test("RX-V473 with a menu source: the browse surface carries the same declared pad", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.descriptor = fixture("desc-rx-v473.xml");
    h.client.xmlAnswers["NET_RADIO|<List_Info>GetParam</List_Info>"] = LIST("NET_RADIO", BOOKMARKS);
    await h.controller.start();
    expect(Object.keys(h.defs.get("living.remote.menu")?.common.states ?? {})).toEqual([
      "on_screen",
      "option",
      "display",
    ]);
    h.client.calls.length = 0;
    // No menu open — the declared zone pad takes the key all the same.
    expect(h.controller.handleWrite("remote.cursor", "up")).toBe("sent");
    await settle();
    expect(h.client.sent()).toEqual(["Main_Zone:<List_Control><Cursor>Up</Cursor></List_Control>"]);
  });

  test("RX-V675 keeps its Cursor_Control pads in both zones", async () => {
    const h = xmlHarness({ Main_Zone: { power: true }, Zone_2: { power: true } });
    h.client.descriptor = fixture("desc-rx-v675.xml");
    await h.controller.start();
    h.client.calls.length = 0;
    await h.controller.handleWrite("multiroom.zone2.remote.menu", "top_menu");
    await h.controller.handleWrite("remote.cursor", "home");
    expect(h.client.sent()).toEqual([
      "Zone_2:<Cursor_Control><Menu_Control>Top Menu</Menu_Control></Cursor_Control>",
      "Main_Zone:<Cursor_Control><Cursor>Return to Home</Cursor></Cursor_Control>",
    ]);
  });
});

describe("opening a menu (review 2026-10-05, A51)", () => {
  const INPUTS = "Main_Zone|<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>";

  test("a zone already on the input is not switched again", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, input: "NET RADIO" } });
    h.client.xmlAnswers["NET_RADIO|<List_Info>GetParam</List_Info>"] = LIST("NET_RADIO", BOOKMARKS);
    await h.controller.start();
    h.client.calls.length = 0;
    void h.controller.handleWrite("player.browse.source", "netRadio");
    await settle();
    expect(h.client.sent()).toEqual([]);
    expect(h.acks).toContainEqual({ id: "living.player.browse.line1", value: "\u{1F4C1} Bookmarks" });
  });

  test("an input the zone declares read-only is not switched to — the menu opens as it is, and the log says so", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, input: "TV" } });
    // The RX-V3900's input list (inventory fixture): iPod is RW=R.
    h.client.xmlAnswers[INPUTS] = (
      JSON.parse(readFileSync(join(__dirname, "../../../test/fixtures/inventory/rxv3900.json"), "utf8")) as {
        xml: { answers: Record<string, string> };
      }
    ).xml.answers["Main_Zone/Input"];
    h.client.xmlAnswers["iPod|<List_Info_2>GetParam</List_Info_2>"] =
      '<YAMAHA_AV rsp="GET" RC="0"><iPod><List_Info_2><Menu_Layer>1</Menu_Layer><Menu_Name>iPod</Menu_Name><Current_List>' +
      "<Line_1><Txt>Playlists</Txt><Container>True</Container></Line_1></Current_List></List_Info_2></iPod></YAMAHA_AV>";
    await h.controller.start();
    h.client.calls.length = 0;
    void h.controller.handleWrite("player.browse.source", "ipod");
    await settle();
    expect(h.client.sent()).toEqual([]);
    expect(h.acks).toContainEqual({ id: "living.player.browse.line1", value: "\u{1F4C1} Playlists" });
    // The driver's line names the device like every other line of the controller.
    expect(h.debugs).toContain("living: menu of ipod: input iPod takes no switch over XML — its menu opens as it is");
  });

  test("a refused nudge of an empty window does not cost the menu: the window is read again", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, input: "HDMI1" } });
    const answers = [LIST("NET_RADIO", ""), LIST("NET_RADIO", BOOKMARKS)];
    let probed = false;
    h.client.getXml = (zone: string, inner: string): Promise<string> => {
      h.client.calls.push({ method: "getXml", zone, inner });
      if (zone !== "NET_RADIO") {
        return Promise.resolve("");
      }
      if (!probed) {
        probed = true;
        return Promise.resolve(LIST("NET_RADIO", BOOKMARKS));
      }
      return Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]);
    };
    h.client.send = (zone: string, inner: string): Promise<void> => {
      h.client.calls.push({ method: "send", zone, inner });
      return inner.includes("Jump_Line") ? Promise.reject(new Error("device refused (RC=4)")) : Promise.resolve();
    };
    await h.controller.start();
    void h.controller.handleWrite("player.browse.source", "netRadio");
    await settle(20);
    expect(h.acks).toContainEqual({ id: "living.player.browse.line1", value: "\u{1F4C1} Bookmarks" });
    expect(h.warnings.some(line => line.includes("open netRadio failed"))).toBe(false);
  });
});

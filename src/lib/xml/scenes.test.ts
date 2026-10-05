import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settle, xmlHarness } from "../../../test/helpers/xml-controller";
import { parseSceneList } from "./protocol";

// Review 2026-10-05, A23: the RX-V6A declares all eight scenes with a blank title — the recall dropdown read
// {"1":"",…,"8":""} and eight empty `title<N>` datapoints stood in the tree; an emptied VIS field recalled scene 1.
// And (krobi 2026-10-05) the names the user gives scenes and inputs in the receiver follow it at runtime (liveLabels).

/** The RX-V6A's real answers (inventory fixture, the 2026-09-01 capture). */
const RX_V6A = (
  JSON.parse(readFileSync(join(__dirname, "../../../test/fixtures/inventory/rxv6a.json"), "utf8")) as {
    xml: { answers: Record<string, string> };
  }
).xml.answers;
const SCENES = "<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>";
const INPUTS = "<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>";

describe("a scene without a title (review 2026-10-05, A23)", () => {
  test("the RX-V6A's blank titles: numbers as labels, no empty title datapoints, no title-less list", async () => {
    expect(parseSceneList(RX_V6A["Main_Zone/Scene"]).map(scene => scene.title)).toEqual(Array(8).fill(""));
    const h = xmlHarness({ Main_Zone: { power: true }, Zone_2: { power: false } });
    h.client.xmlAnswers[`Main_Zone|${SCENES}`] = RX_V6A["Main_Zone/Scene"];
    h.client.xmlAnswers[`Zone_2|${SCENES}`] = RX_V6A["Zone_2/Scene"];
    await h.controller.start();
    for (const prefix of ["living.", "living.multiroom.zone2."]) {
      const recall = h.defs.get(`${prefix}scene.recall`);
      expect(recall?.common.states).toEqual({ 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8" });
      expect(h.objects.filter(id => id.startsWith(`${prefix}scene.title`))).toEqual([]);
      expect(h.objects).not.toContain(`${prefix}scene.list`);
    }
  });

  test("named and unnamed scenes side by side: the name where there is one, a title datapoint only for it", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.xmlAnswers[`Main_Zone|${SCENES}`] =
      '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Scene><Scene_Sel_Item>' +
      "<Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie</Title></Item_1>" +
      "<Item_2><Param>Scene 2</Param><RW>W</RW><Title>  </Title></Item_2>" +
      "</Scene_Sel_Item></Scene></Main_Zone></YAMAHA_AV>";
    await h.controller.start();
    expect(h.defs.get("living.scene.recall")?.common.states).toEqual({ 1: "Movie", 2: "2" });
    expect(h.objects.filter(id => id.startsWith("living.scene.title"))).toEqual(["living.scene.title1"]);
    expect(h.acks).toContainEqual({ id: "living.scene.list", value: JSON.stringify([{ num: 1, title: "Movie" }]) });
    // The unnamed scene is still a scene: recalled by its number.
    h.client.calls.length = 0;
    await expect(Promise.resolve(h.controller.handleWrite("scene.recall", 2))).resolves.toBe("sent");
    expect(h.client.sent()).toEqual(["Main_Zone:<Scene><Scene_Sel>Scene 2</Scene_Sel></Scene>"]);
  });

  test("an emptied text field recalls nothing — not the first blank title", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.xmlAnswers[`Main_Zone|${SCENES}`] = RX_V6A["Main_Zone/Scene"];
    await h.controller.start();
    h.client.calls.length = 0;
    expect(h.controller.handleWrite("scene.recall", "")).toBe("unavailable");
    await settle();
    expect(h.client.sent()).toEqual([]);
  });
});

describe("the user's names follow the receiver (liveLabels, krobi 2026-10-05)", () => {
  test("the scene recall and the input dropdown are marked; a zone without a declared list is not", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, input: "NET RADIO" }, Zone_2: { power: true, input: "AUDIO1" } });
    h.client.xmlAnswers[`Main_Zone|${SCENES}`] = RX_V6A["Main_Zone/Scene"];
    h.client.xmlAnswers[`Main_Zone|${INPUTS}`] = RX_V6A["Main_Zone/Input"];
    await h.controller.start();
    expect(h.defs.get("living.scene.recall")?.liveLabels).toBe(true);
    expect(h.defs.get("living.input")?.liveLabels).toBe(true);
    // Zone 2 declares no input list here: a plain text input, nothing to follow.
    expect(h.defs.get("living.multiroom.zone2.input")?.liveLabels).toBeUndefined();
    // A list the device does not let the user rename keeps its labels as read in.
    expect(h.defs.get("living.sleep")?.liveLabels).toBeUndefined();
  });
});

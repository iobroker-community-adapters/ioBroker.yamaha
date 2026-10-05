import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  knownScenes,
  resolveSceneNumber,
  sceneListSurface,
  sceneNumber,
  sceneRecallStates,
  yncaSceneTitles,
} from "./scene-titles";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";
import { parseSceneList } from "../xml/protocol";

const declaration =
  '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Scene><Scene_Sel_Item>' +
  "<Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie Viewing</Title></Item_1>" +
  "<Item_2><Param>Scene 2</Param><RW>W</RW><Title>Radio Listening</Title></Item_2>" +
  "</Scene_Sel_Item></Scene></Main_Zone></YAMAHA_AV>";

describe("scene titles from the shared device memory", () => {
  test("reads the XML declaration per zone", () => {
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA, "xmlScenes:main": declaration });
    expect(knownScenes(memory, "main")).toEqual([
      { num: 1, title: "Movie Viewing" },
      { num: 2, title: "Radio Listening" },
    ]);
    expect(knownScenes(memory, "zone2")).toEqual([]);
  });

  test("falls back to the YNCA scene names for the main zone", () => {
    const memory = new ProbeMemory({
      __schema: DISCOVERY_SCHEMA,
      yncaStaticValues: { MAIN: { SCENE1NAME: "BD/DVD", SCENE4NAME: "RADIO" } },
    });
    expect(knownScenes(memory, "main")).toEqual([
      { num: 1, title: "BD/DVD" },
      { num: 4, title: "RADIO" },
    ]);
  });

  test("resolveSceneNumber takes numbers, numeric strings and titles (case-insensitive)", () => {
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA, "xmlScenes:main": declaration });
    expect(resolveSceneNumber(2, memory, "main")).toBe(2);
    expect(resolveSceneNumber("3", memory, "main")).toBe(3);
    expect(resolveSceneNumber("movie viewing", memory, "main")).toBe(1);
    expect(resolveSceneNumber("Unknown Scene", memory, "main")).toBeUndefined();
    expect(resolveSceneNumber(null, new ProbeMemory(), "main")).toBeUndefined();
  });

  test("a YNCA scene name is trimmed, and a name of blanks names no scene", () => {
    expect(yncaSceneTitles({ SCENE1NAME: " BD/DVD ", SCENE2NAME: "   ", SCENE3NAME: "" }, "MAIN")).toEqual([
      { num: 1, title: "BD/DVD" },
    ]);
  });
});

describe("title source precedence", () => {
  test("the XML declaration beats the YNCA names when BOTH transports reported titles", () => {
    const memory = new ProbeMemory();
    memory.set(
      "xmlScenes:main",
      `<YAMAHA_AV rsp="GET" RC="0"><Scene><Scene_Sel_Item>` +
        `<Item_1><Param>Scene 1</Param><RW>W</RW><Title>XML Movie</Title></Item_1>` +
        `</Scene_Sel_Item></Scene></YAMAHA_AV>`,
    );
    memory.set("yncaStaticValues", { MAIN: { SCENE1NAME: "YNCA Movie", SCENE2NAME: "YNCA TV" } });
    // The per-zone XML declaration is the richer, zone-aware source — it must win.
    expect(knownScenes(memory, "main")).toEqual([{ num: 1, title: "XML Movie" }]);
    // A zone neither transport named has no titles.
    expect(knownScenes(memory, "zone2")).toEqual([]);
  });

  // A MusicCast-owned `multiroom.zone2.scene.recall` resolves a title only YNCA reported (B16).
  test("a zone falls back to its own four YNCA scene names", () => {
    const memory = new ProbeMemory();
    memory.set("yncaStaticValues", {
      MAIN: { SCENE1NAME: "Main Movie" },
      ZONE2: { SCENE2NAME: "Patio", SCENE5NAME: "beyond the four" },
    });
    expect(knownScenes(memory, "zone2")).toEqual([{ num: 2, title: "Patio" }]);
    expect(resolveSceneNumber("patio", memory, "zone2")).toBe(2);
    expect(knownScenes(memory, "zone3")).toEqual([]);
  });
});

// Fleet rule 2026-09-28: a JSON list only IN ADDITION — every title is its own datapoint (audit 2026-09-29, D8).
describe("the scene list surface", () => {
  // Review 2026-10-05, A23: a scene without a title got an empty title datapoint (eight on the RX-V6A).
  test("carries the JSON list and one title datapoint per TITLED scene — an empty text is no value", () => {
    const surface = sceneListSurface("multiroom.zone2.scene", [
      { num: 1, title: " Movie " },
      { num: 2, title: "" },
      { num: 3, title: "   " },
    ]);
    expect(surface.objects.map(o => o.id)).toEqual(["multiroom.zone2.scene.list", "multiroom.zone2.scene.title1"]);
    expect(surface.objects[1].common).toMatchObject({ type: "string", role: "text", write: false });
    expect((surface.objects[1].common.name as Record<string, string>).en).toBe("Scene 1 title");
    expect(surface.values).toEqual([
      {
        id: "multiroom.zone2.scene.list",
        // Every declared scene stays in the list — a recall slot exists without a title.
        value: JSON.stringify([
          { num: 1, title: "Movie" },
          { num: 2, title: "" },
          { num: 3, title: "" },
        ]),
      },
      { id: "multiroom.zone2.scene.title1", value: "Movie" },
    ]);
  });
});

// Review 2026-10-05, A23: the ONE label rule of a recall dropdown, for the three protocols.
describe("sceneRecallStates", () => {
  test("labels a scene with its trimmed title, a scene without one with its number", () => {
    expect(
      sceneRecallStates([
        { num: 1, title: " Movie " },
        { num: 2, title: "" },
        { num: 4, title: "  " },
      ]),
    ).toEqual({ 1: "Movie", 2: "2", 4: "4" });
    expect(sceneRecallStates([])).toEqual({});
  });
});

// The RX-V6A declares its eight XML scenes with empty titles (inventory capture): an emptied VIS field recalled
// scene 1 — input, volume and DSP changed — and the dropdown offered eight blank entries (review 2026-10-05, A23).
describe("a device that declares its scenes without titles (RX-V6A, XML)", () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "..", "test", "fixtures", "inventory", "rxv6a.json"), "utf8"),
  ) as { xml: { answers: Record<string, string> } };
  const answer = fixture.xml.answers["Main_Zone/Scene"];
  const scenes = parseSceneList(answer);

  test("the capture holds eight scenes, all without a title", () => {
    expect(scenes).toHaveLength(8);
    expect(scenes.every(scene => scene.title.trim() === "")).toBe(true);
  });

  test("an empty or blank write names no scene", () => {
    expect(sceneNumber("", scenes)).toBeUndefined();
    expect(sceneNumber("   ", scenes)).toBeUndefined();
    const memory = new ProbeMemory();
    memory.set("xmlScenes:main", answer);
    expect(resolveSceneNumber("", memory, "main")).toBeUndefined();
    expect(resolveSceneNumber(3, memory, "main")).toBe(3);
  });

  test("the dropdown shows the numbers, and no title datapoint stands empty", () => {
    expect(sceneRecallStates(scenes)).toEqual({ 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8" });
    expect(sceneListSurface("scene", scenes).objects.map(o => o.id)).toEqual(["scene.list"]);
  });
});

// One resolution for all three transports: "1.5" was scene 2 on XML and YNCA and nothing on MusicCast
// (audit 2026-09-29, D16).
describe("sceneNumber", () => {
  const scenes = [
    { num: 1, title: "Movie" },
    { num: 2, title: "Radio" },
  ];
  test("takes whole numbers and titles, and nothing else", () => {
    expect(sceneNumber(2, scenes)).toBe(2);
    expect(sceneNumber(" 3 ", scenes)).toBe(3);
    expect(sceneNumber("radio", scenes)).toBe(2);
    expect(sceneNumber("1.5", scenes)).toBeUndefined();
    expect(sceneNumber(1.5, scenes)).toBeUndefined();
    expect(sceneNumber(0, scenes)).toBeUndefined();
    expect(sceneNumber(true, scenes)).toBeUndefined();
    expect(sceneNumber("0x1", scenes)).toBeUndefined();
    expect(sceneNumber("Party", scenes)).toBeUndefined();
  });
});

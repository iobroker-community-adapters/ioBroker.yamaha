import { knownScenes, resolveSceneNumber, sceneListSurface } from "./scene-titles";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";

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
    expect(resolveSceneNumber(null, undefined, "main")).toBeUndefined();
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
  test("carries the JSON list and one title datapoint per scene, empty titles included", () => {
    const surface = sceneListSurface("multiroom.zone2.scene", [
      { num: 1, title: "Movie" },
      { num: 2, title: "" },
    ]);
    expect(surface.objects.map(o => o.id)).toEqual([
      "multiroom.zone2.scene.list",
      "multiroom.zone2.scene.title1",
      "multiroom.zone2.scene.title2",
    ]);
    expect(surface.objects[1].common).toMatchObject({ type: "string", role: "text", write: false });
    expect((surface.objects[1].common.name as Record<string, string>).en).toBe("Scene 1 title");
    expect(surface.values).toEqual([
      {
        id: "multiroom.zone2.scene.list",
        value: JSON.stringify([
          { num: 1, title: "Movie" },
          { num: 2, title: "" },
        ]),
      },
      { id: "multiroom.zone2.scene.title1", value: "Movie" },
      { id: "multiroom.zone2.scene.title2", value: "" },
    ]);
  });
});

import { knownScenes, resolveSceneNumber, sceneStatesMap } from "./scene-titles";
import { ProbeMemory } from "../lifecycle/probe-memory";

const declaration =
  '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Scene><Scene_Sel_Item>' +
  "<Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie Viewing</Title></Item_1>" +
  "<Item_2><Param>Scene 2</Param><RW>W</RW><Title>Radio Listening</Title></Item_2>" +
  "</Scene_Sel_Item></Scene></Main_Zone></YAMAHA_AV>";

describe("scene titles from the shared device memory", () => {
  test("reads the XML declaration per zone", () => {
    const memory = new ProbeMemory({ "xmlScenes:main": declaration });
    expect(knownScenes(memory, "main")).toEqual([
      { num: 1, title: "Movie Viewing" },
      { num: 2, title: "Radio Listening" },
    ]);
    expect(knownScenes(memory, "zone2")).toEqual([]);
  });

  test("falls back to the YNCA scene names for the main zone", () => {
    const memory = new ProbeMemory({ yncaStaticValues: { MAIN: { SCENE1NAME: "BD/DVD", SCENE4NAME: "RADIO" } } });
    expect(knownScenes(memory, "main")).toEqual([
      { num: 1, title: "BD/DVD" },
      { num: 4, title: "RADIO" },
    ]);
    expect(sceneStatesMap(memory, "main")).toEqual({ 1: "BD/DVD", 4: "RADIO" });
  });

  test("resolveSceneNumber takes numbers, numeric strings and titles (case-insensitive)", () => {
    const memory = new ProbeMemory({ "xmlScenes:main": declaration });
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
    // A zone the XML never declared falls back to nothing (YNCA names are main-only).
    expect(knownScenes(memory, "zone2")).toEqual([]);
  });
});

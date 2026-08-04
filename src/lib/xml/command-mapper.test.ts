import { stateToXml, parseXmlStatus } from "./command-mapper";
import type { BasicStatus } from "./protocol";

describe("stateToXml", () => {
  test("maps power to a Power_Control command on the main zone", () => {
    expect(stateToXml("power", true)).toEqual({
      zone: "Main_Zone",
      inner: "<Power_Control><Power>On</Power></Power_Control>",
    });
  });

  test("maps mute", () => {
    expect(stateToXml("mute", false)).toEqual({ zone: "Main_Zone", inner: "<Volume><Mute>Off</Mute></Volume>" });
  });

  test("maps volume from decibels to tenths in Val", () => {
    expect(stateToXml("volume", -30)).toEqual({
      zone: "Main_Zone",
      inner: "<Volume><Lvl><Val>-300</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Volume>",
    });
  });

  test("maps input", () => {
    expect(stateToXml("input", "HDMI1")).toEqual({
      zone: "Main_Zone",
      inner: "<Input><Input_Sel>HDMI1</Input_Sel></Input>",
    });
  });

  test("resolves a zoned state to the Zone_N element", () => {
    expect(stateToXml("zone2.power", true)).toEqual({
      zone: "Zone_2",
      inner: "<Power_Control><Power>On</Power></Power_Control>",
    });
  });

  test("maps straight and direct to their Surround/Sound_Video commands", () => {
    expect(stateToXml("straight", true)).toEqual({
      zone: "Main_Zone",
      inner: "<Surround><Program_Sel><Current><Straight>On</Straight></Current></Program_Sel></Surround>",
    });
    expect(stateToXml("direct", false)).toEqual({
      zone: "Main_Zone",
      inner: "<Sound_Video><Direct><Mode>Off</Mode></Direct></Sound_Video>",
    });
  });

  test("dialogue level is read-only — no write command", () => {
    expect(stateToXml("dialogueLevel", 2)).toBeUndefined();
  });

  test("returns undefined for an unmapped state or unknown zone", () => {
    expect(stateToXml("nonsense", 1)).toBeUndefined();
    expect(stateToXml("zone9.power", true)).toBeUndefined();
  });
});

describe("parseXmlStatus", () => {
  test("maps a Basic_Status to unified states in a stable order", () => {
    const bs: BasicStatus = { power: true, volume: -30, mute: false, input: "HDMI1" };
    expect(parseXmlStatus(bs, "main")).toEqual([
      { id: "power", value: true },
      { id: "volume", value: -30 },
      { id: "mute", value: false },
      { id: "input", value: "HDMI1" },
    ]);
  });

  test("prefixes non-main zones and skips absent fields", () => {
    expect(parseXmlStatus({ power: false }, "zone2")).toEqual([{ id: "zone2.power", value: false }]);
  });

  test("emits straight, direct, adaptive DRC and dialogue level when present", () => {
    const bs: BasicStatus = { straight: true, direct: false, adaptiveDrc: "Auto", dialogueLevel: 2 };
    const u = parseXmlStatus(bs, "main");
    expect(u).toContainEqual({ id: "straight", value: true });
    expect(u).toContainEqual({ id: "direct", value: false });
    expect(u).toContainEqual({ id: "adaptiveDrc", value: "Auto" });
    expect(u).toContainEqual({ id: "dialogueLevel", value: 2 });
  });
});

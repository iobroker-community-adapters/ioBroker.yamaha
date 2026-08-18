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
    expect(stateToXml("multiroom.zone2.power", true)).toEqual({
      zone: "Zone_2",
      inner: "<Power_Control><Power>On</Power></Power_Control>",
    });
  });

  test("maps straight and direct to their Surround/Sound_Video commands", () => {
    expect(stateToXml("sound.straight", true)).toEqual({
      zone: "Main_Zone",
      inner: "<Surround><Program_Sel><Current><Straight>On</Straight></Current></Program_Sel></Surround>",
    });
    expect(stateToXml("sound.direct", false)).toEqual({
      zone: "Main_Zone",
      inner: "<Sound_Video><Direct><Mode>Off</Mode></Direct></Sound_Video>",
    });
  });

  test("dialogue level is read-only — no write command", () => {
    expect(stateToXml("sound.dialogueLevel", 2)).toBeUndefined();
  });

  test("maps tone, subwoofer trim and extra-bass/YPAO writes (soef lib paths)", () => {
    expect(stateToXml("sound.bass", 3)).toEqual({
      zone: "Main_Zone",
      inner: "<Sound_Video><Tone><Bass><Val>3</Val><Exp>1</Exp><Unit>dB</Unit></Bass></Tone></Sound_Video>",
    });
    expect(stateToXml("sound.subwooferTrim", -1)).toEqual({
      zone: "Main_Zone",
      inner: "<Volume><Subwoofer_Trim><Val>-1</Val><Exp>1</Exp><Unit>dB</Unit></Subwoofer_Trim></Volume>",
    });
    expect(stateToXml("sound.extraBass", true)).toEqual({
      zone: "Main_Zone",
      inner: "<Sound_Video><Extra_Bass>Auto</Extra_Bass></Sound_Video>",
    });
    expect(stateToXml("sound.ypaoVolume", false)).toEqual({
      zone: "Main_Zone",
      inner: "<Sound_Video><YPAO_Volume>Off</YPAO_Volume></Sound_Video>",
    });
  });

  test("scene recall (write-only) maps to Scene_Load on the main zone only", () => {
    expect(stateToXml("scene.recall", 2)).toEqual({
      zone: "Main_Zone",
      inner: "<Scene><Scene_Load>Scene 2</Scene_Load></Scene>",
    });
    expect(stateToXml("multiroom.zone2.scene.recall", 2)).toBeUndefined(); // scenes are a main-zone feature
  });

  test("HDMI outputs and party are written on the System element, not the zone", () => {
    expect(stateToXml("hdmiOut1", true)).toEqual({
      zone: "System",
      inner: "<Sound_Video><HDMI><Output><OUT_1>On</OUT_1></Output></HDMI></Sound_Video>",
    });
    expect(stateToXml("multiroom.party", true)).toEqual({
      zone: "System",
      inner: "<Party_Mode><Mode>On</Mode></Party_Mode>",
    });
  });

  test("dialogue lift maps to a Dialogue_Adjust command on its zone", () => {
    expect(stateToXml("sound.dialogueLift", 3)).toEqual({
      zone: "Main_Zone",
      inner: "<Sound_Video><Dialogue_Adjust><Dialogue_Lift>3</Dialogue_Lift></Dialogue_Adjust></Sound_Video>",
    });
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
    expect(parseXmlStatus({ power: false }, "zone2")).toEqual([{ id: "multiroom.zone2.power", value: false }]);
  });

  test("emits straight, direct, adaptive DRC and dialogue level when present", () => {
    const bs: BasicStatus = { straight: true, direct: false, adaptiveDrc: "Auto", dialogueLevel: 2 };
    const u = parseXmlStatus(bs, "main");
    expect(u).toContainEqual({ id: "sound.straight", value: true });
    expect(u).toContainEqual({ id: "sound.direct", value: false });
    expect(u).toContainEqual({ id: "sound.adaptiveDrc", value: "Auto" });
    expect(u).toContainEqual({ id: "sound.dialogueLevel", value: 2 });
  });
});

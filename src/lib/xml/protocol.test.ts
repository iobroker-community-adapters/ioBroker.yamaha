import { encodePut, encodeGet, parseBasicStatus } from "./protocol";

describe("encodePut / encodeGet", () => {
  test("wraps an inner command in the YAMAHA_AV PUT envelope for a zone", () => {
    expect(encodePut("Main_Zone", "<Power_Control><Power>On</Power></Power_Control>")).toBe(
      '<YAMAHA_AV cmd="PUT"><Main_Zone><Power_Control><Power>On</Power></Power_Control></Main_Zone></YAMAHA_AV>',
    );
  });

  test("builds a Basic_Status GET request for a zone", () => {
    expect(encodeGet("Main_Zone", "<Basic_Status>GetParam</Basic_Status>")).toBe(
      '<YAMAHA_AV cmd="GET"><Main_Zone><Basic_Status>GetParam</Basic_Status></Main_Zone></YAMAHA_AV>',
    );
  });
});

describe("parseBasicStatus", () => {
  test("parses sound program, pure direct and sleep from an extended Basic_Status", () => {
    const xml =
      "<Surround><Program_Sel><Current><Sound_Program>Movie</Sound_Program></Current></Program_Sel></Surround>" +
      "<Sound_Video><Pure_Direct><Mode>On</Mode></Pure_Direct></Sound_Video>" +
      "<Power_Control><Sleep>30 min</Sleep></Power_Control>";
    const status = parseBasicStatus(xml);
    expect(status.soundProgram).toBe("Movie");
    expect(status.pureDirect).toBe(true);
    expect(status.sleep).toBe("30 min");
  });

  test("extracts power, volume (dB), mute and input from a Basic_Status response", () => {
    const xml = `<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Basic_Status>
      <Power_Control><Power>On</Power></Power_Control>
      <Volume><Lvl><Val>-300</Val><Exp>1</Exp><Unit>dB</Unit></Lvl><Mute>Off</Mute></Volume>
      <Input><Input_Sel>HDMI1</Input_Sel></Input>
    </Basic_Status></Main_Zone></YAMAHA_AV>`;
    expect(parseBasicStatus(xml)).toEqual({ power: true, volume: -30, mute: false, input: "HDMI1" });
  });

  test("returns only the fields the response carries", () => {
    const xml =
      "<YAMAHA_AV><Main_Zone><Basic_Status><Power_Control><Power>Standby</Power></Power_Control></Basic_Status></Main_Zone></YAMAHA_AV>";
    expect(parseBasicStatus(xml)).toEqual({ power: false });
  });

  test("parses straight, direct, adaptive DRC and dialogue level (rxv + openHAB paths)", () => {
    const xml =
      "<Surround><Program_Sel><Current><Straight>On</Straight></Current></Program_Sel></Surround>" +
      "<Sound_Video><Direct><Mode>Off</Mode></Direct><Adaptive_DRC>Auto</Adaptive_DRC>" +
      "<Dialogue_Adjust><Dialogue_Lvl><Val>2</Val></Dialogue_Lvl></Dialogue_Adjust></Sound_Video>";
    const status = parseBasicStatus(xml);
    expect(status.straight).toBe(true);
    expect(status.direct).toBe(false);
    expect(status.adaptiveDrc).toBe("Auto");
    expect(status.dialogueLevel).toBe(2);
  });

  test("returns nothing for a malformed response", () => {
    expect(parseBasicStatus("not xml")).toEqual({});
  });
});

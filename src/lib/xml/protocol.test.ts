import {
  assertXmlOk,
  encodeGet,
  encodePut,
  parseBasicStatus,
  parseInputList,
  parseModelName,
  parseReturnCode,
  parseSceneList,
  parseTunerInfo,
} from "./protocol";

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
    expect(status.volume).toBeUndefined(); // Dialogue_Lvl's <Val> must not be read as the volume
  });

  test("parses tone, subwoofer trim and extra-bass/YPAO toggles (soef paths the predecessor exposed)", () => {
    const xml =
      "<Sound_Video><Tone><Bass><Val>30</Val></Bass><Treble><Val>-20</Val></Treble></Tone>" +
      "<Extra_Bass>Auto</Extra_Bass><YPAO_Volume>Off</YPAO_Volume></Sound_Video>" +
      "<Volume><Subwoofer_Trim><Val>10</Val></Subwoofer_Trim></Volume>";
    const s = parseBasicStatus(xml);
    expect(s.bass).toBe(3);
    expect(s.treble).toBe(-2);
    expect(s.subwooferTrim).toBe(1);
    expect(s.extraBass).toBe(true); // Auto -> on
    expect(s.ypaoVolume).toBe(false); // Off -> off
    expect(s.volume).toBeUndefined(); // Subwoofer_Trim's <Val> must not be read as the volume
  });

  test("parses HDMI outputs, party and dialogue lift (predecessor paths)", () => {
    const xml =
      "<Sound_Video><HDMI><Output><OUT_1>On</OUT_1><OUT_2>Off</OUT_2></Output></HDMI>" +
      "<Dialogue_Adjust><Dialogue_Lift>3</Dialogue_Lift></Dialogue_Adjust></Sound_Video>" +
      "<Party_Info>On</Party_Info>";
    const s = parseBasicStatus(xml);
    expect(s.hdmiOut1).toBe(true);
    expect(s.hdmiOut2).toBe(false);
    expect(s.dialogueLift).toBe(3);
    expect(s.party).toBe(true);
  });

  test("returns nothing for a malformed response", () => {
    expect(parseBasicStatus("not xml")).toEqual({});
  });
});

describe("parseModelName", () => {
  it("treats an empty element as no model at all", () => {
    // An empty <Model_Name/> would become an empty model string, which drives the
    // device-class icon and the card's model line into a blank.
    expect(parseModelName("<Model_Name></Model_Name>")).toBeUndefined();
    expect(parseModelName("<YAMAHA_AV/>")).toBeUndefined();
    expect(parseModelName("<Model_Name>RX-V771</Model_Name>")).toBe("RX-V771");
  });
});

describe("return codes (the device's own verdict)", () => {
  test("parses the RC attribute from a response envelope", () => {
    expect(parseReturnCode('<YAMAHA_AV rsp="PUT" RC="0"></YAMAHA_AV>')).toBe(0);
    expect(parseReturnCode('<YAMAHA_AV rsp="GET" RC="2"><Tuner><Play_Info></Play_Info></Tuner></YAMAHA_AV>')).toBe(2);
    expect(parseReturnCode("<no-envelope/>")).toBeUndefined();
  });

  test("assertXmlOk passes RC=0 through and throws on a refusal or an empty body", () => {
    const ok = '<YAMAHA_AV rsp="PUT" RC="0"></YAMAHA_AV>';
    expect(assertXmlOk(ok, "x")).toBe(ok);
    // Captured RX-V6A behaviour: RC="2" for a node the model does not carry.
    expect(() => assertXmlOk('<YAMAHA_AV rsp="GET" RC="2"></YAMAHA_AV>', "<Tuner> Play_Info")).toThrow("RC=2");
    // Unknown nodes answer a bodyless HTTP 400 — an empty body is a refusal too.
    expect(() => assertXmlOk("", "<X/>")).toThrow("empty response");
    // A body without an RC attribute (some GET answers) is not a refusal.
    expect(assertXmlOk("<Model_Name>RX-V771</Model_Name>", "x")).toBe("<Model_Name>RX-V771</Model_Name>");
  });
});

describe("parseSceneList (the device's own scene declaration, #615)", () => {
  // The captured RX-V6A shape, shortened to three items.
  const declaration =
    '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Scene><Scene_Sel_Item>' +
    "<Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie Viewing</Title><Icon><On>1</On></Icon></Item_1>" +
    "<Item_2><Param>Scene 2</Param><RW>W</RW><Title>Radio &amp; News</Title><Icon><On>2</On></Icon></Item_2>" +
    "<Item_3><Param>Scene 3</Param><RW></RW><Title>Locked</Title><Icon><On>3</On></Icon></Item_3>" +
    "</Scene_Sel_Item></Scene></Main_Zone></YAMAHA_AV>";

  test("returns the writable scenes with their numbers and decoded titles", () => {
    expect(parseSceneList(declaration)).toEqual([
      { num: 1, title: "Movie Viewing" },
      { num: 2, title: "Radio & News" },
    ]);
  });

  test("a refusal or unrelated body declares no scenes", () => {
    expect(parseSceneList("")).toEqual([]);
    expect(parseSceneList('<YAMAHA_AV RC="2"></YAMAHA_AV>')).toEqual([]);
  });
});

describe("parseInputList (the zone's own input vocabulary)", () => {
  test("returns the Param of every item, entities decoded", () => {
    const body =
      "<Input_Sel_Item><Item_1><Param>HDMI1</Param></Item_1><Item_2><Param>NET RADIO</Param></Item_2></Input_Sel_Item>";
    expect(parseInputList(body)).toEqual(["HDMI1", "NET RADIO"]);
    expect(parseInputList("")).toEqual([]);
  });
});

describe("parseTunerInfo (classic <Tuner> Play_Info)", () => {
  test("reads preset, scaled frequency, RDS and the signal flags, presence-checked", () => {
    const body =
      "<Tuner><Play_Info><Preset><Preset_Sel>3</Preset_Sel></Preset>" +
      "<Tuning><Freq><Val>9810</Val><Exp>2</Exp><Unit>MHz</Unit></Freq></Tuning>" +
      "<Signal_Info><Tuned>Assert</Tuned><Stereo>Negate</Stereo></Signal_Info>" +
      "<Meta_Info><Program_Service>Radio X</Program_Service><Radio_Text>Now playing</Radio_Text></Meta_Info>" +
      "</Play_Info></Tuner>";
    expect(parseTunerInfo(body)).toEqual({
      preset: 3,
      frequency: 98.1,
      frequencyUnit: "MHz",
      rdsService: "Radio X",
      rdsText: "Now playing",
      tuned: true,
      stereo: false,
    });
  });

  test("an empty preset slot ('No Preset') reads as 0; absent fields stay absent", () => {
    expect(parseTunerInfo("<Preset><Preset_Sel>No Preset</Preset_Sel></Preset>")).toEqual({ preset: 0 });
    expect(parseTunerInfo("")).toEqual({});
  });
});

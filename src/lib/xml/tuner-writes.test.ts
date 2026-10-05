import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settle, xmlHarness, type XmlHarness } from "../../../test/helpers/xml-controller";
import { tunerBandOf } from "./protocol";

// Review 2026-10-05, A20: a frequency went to the band the tuner last REPORTED and was clamped to that band's edge —
// `tuner.band = FM` then `tuner.frequency = 98100` sent `Band FM`, then `Freq AM 1710`. A26: the grid and the preset
// slot follow the one rule of every protocol (`snapToGrid`, `slotNumber`).

const PLAY_INFO = "Tuner|<Play_Info>GetParam</Play_Info>";
const PRESETS = "Tuner|<Play_Control><Preset><Preset_Sel_Item>GetParam</Preset_Sel_Item></Preset></Play_Control>";
const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", name), "utf8");
/** The 2008 generation's own description (RX-V3900, inventory fixture): `Freq` with the unit, no band element. */
const RX_V3900 = (
  JSON.parse(readFileSync(join(__dirname, "../../../test/fixtures/inventory/rxv3900.json"), "utf8")) as {
    xml: { descriptor: string };
  }
).xml.descriptor;

/** A 2009+ tuner on AM 1000 kHz (`Freq,Current`). */
const onAm =
  '<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Info><Preset><Preset_Sel>1</Preset_Sel></Preset><Tuning><Band>AM</Band>' +
  "<Freq><Current><Val>1000</Val><Exp>0</Exp><Unit>kHz</Unit></Current></Freq></Tuning></Play_Info></Tuner></YAMAHA_AV>";
/** The 2008 tuner on AM 999 kHz (`Freq` flat, RX-V3900). */
const onAm2008 =
  '<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Info><Tuning><Band>AM</Band><Freq><Val>999</Val><Exp>0</Exp>' +
  "<Unit>kHz</Unit></Freq></Tuning><Preset>A1</Preset></Play_Info></Tuner></YAMAHA_AV>";

/**
 * A started receiver with the classic tuner.
 *
 * @param descriptor the device description
 * @param playInfo the tuner's Play_Info answer
 * @returns the harness, its calls cleared
 */
async function tuner(descriptor: string, playInfo: string): Promise<XmlHarness> {
  const h = xmlHarness({ Main_Zone: { power: true } });
  h.client.descriptor = descriptor;
  h.client.xmlAnswers[PLAY_INFO] = playInfo;
  await h.controller.start();
  h.client.calls.length = 0;
  return h;
}

describe("the band of a frequency is its own (review 2026-10-05, A20)", () => {
  test("AM below 2000 kHz, FM above — the declared ranges and a written value alike", () => {
    expect([522, 1710, 1999].map(tunerBandOf)).toEqual(["AM", "AM", "AM"]);
    expect([76000, 87500, 108000].map(tunerBandOf)).toEqual(["FM", "FM", "FM"]);
  });

  test("an FM frequency written while the tuner is on AM goes to FM (RX-V675, 2009–2017)", async () => {
    const h = await tuner(fixture("desc-rx-v675.xml"), onAm);
    await expect(Promise.resolve(h.controller.handleWrite("tuner.frequency", 98100))).resolves.toBe("sent");
    expect(h.client.sent()).toEqual([
      "Tuner:<Play_Control><Tuning><Freq><FM><Val>9810</Val><Exp>2</Exp><Unit>MHz</Unit></FM></Freq></Tuning></Play_Control>",
    ]);
  });

  test("a script switching to FM and setting 98.1 MHz in one go tunes 98.1 MHz, not AM 1710", async () => {
    const h = await tuner(fixture("desc-rx-v675.xml"), onAm);
    void h.controller.handleWrite("tuner.band", "FM");
    void h.controller.handleWrite("tuner.frequency", 98100);
    await settle();
    expect(h.client.sent()).toEqual([
      "Tuner:<Play_Control><Tuning><Band>FM</Band></Tuning></Play_Control>",
      "Tuner:<Play_Control><Tuning><Freq><FM><Val>9810</Val><Exp>2</Exp><Unit>MHz</Unit></FM></Freq></Tuning></Play_Control>",
    ]);
  });

  test("an AM frequency on the US grid snaps to its 10 kHz step", async () => {
    const h = await tuner(fixture("desc-rx-v675.xml"), onAm);
    await h.controller.handleWrite("tuner.frequency", 1004);
    expect(h.client.sent()).toEqual([
      "Tuner:<Play_Control><Tuning><Freq><AM><Val>1000</Val><Exp>0</Exp><Unit>kHz</Unit></AM></Freq></Tuning></Play_Control>",
    ]);
  });

  test.each([
    [1800, "it lies outside the AM range this tuner declares"],
    [108500, "it lies outside the FM range this tuner declares"],
    [50000, "it lies outside the FM range this tuner declares"],
  ])("%d kHz is outside the declared band: not clamped to its edge, not sent, and said", async (khz, reason) => {
    const h = await tuner(fixture("desc-rx-v675.xml"), onAm);
    expect(h.controller.handleWrite("tuner.frequency", khz)).toBe("unavailable");
    await settle();
    expect(h.client.sent()).toEqual([]);
    expect(h.debugs).toContain(`living: tuner.frequency = ${khz} not sent — ${reason}`);
  });

  test("the 2008 generation (RX-V3900) writes the flat Freq with the unit of the value's band", async () => {
    const h = await tuner(RX_V3900, onAm2008);
    await h.controller.handleWrite("tuner.frequency", 98130); // 50 kHz grid → 98.15 MHz
    await h.controller.handleWrite("tuner.frequency", 1000); // 9 kHz grid from 531 → 999 kHz
    expect(h.client.sent()).toEqual([
      "Tuner:<Play_Control><Tuning><Freq><Val>9815</Val><Exp>2</Exp><Unit>MHz</Unit></Freq></Tuning></Play_Control>",
      "Tuner:<Play_Control><Tuning><Freq><Val>999</Val><Exp>0</Exp><Unit>kHz</Unit></Freq></Tuning></Play_Control>",
    ]);
  });

  test("a tuner whose band is not reported yet still tunes — the value names it", async () => {
    const h = await tuner(
      fixture("desc-rx-v675.xml"),
      '<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Info><Preset><Preset_Sel>1</Preset_Sel></Preset></Play_Info></Tuner></YAMAHA_AV>',
    );
    await expect(Promise.resolve(h.controller.handleWrite("tuner.frequency", 98100))).resolves.toBe("sent");
  });
});

describe("a preset is a whole declared slot on every protocol (review 2026-10-05, A26)", () => {
  test.each([
    [2.5, "it names no preset slot"],
    [0, "it names no preset slot"],
    [true, "it names no preset slot"],
  ])("%j is no preset", async (value, reason) => {
    const h = await tuner(fixture("desc-rx-v675.xml"), onAm);
    expect(h.controller.handleWrite("tuner.preset", value)).toBe("unavailable");
    expect(h.debugs).toContain(`living: tuner.preset = ${JSON.stringify(value)} not sent — ${reason}`);
  });

  test("past the last slot the device declares is no preset either", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    h.client.xmlAnswers[PLAY_INFO] = onAm2008;
    h.client.xmlAnswers[PRESETS] =
      '<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Control><Preset><Preset_Sel_Item>' +
      "<Item_1><Param>A1</Param><RW>RW</RW><Title>hr3</Title></Item_1>" +
      "<Item_2><Param>A2</Param><RW>RW</RW><Title>SWR3</Title></Item_2>" +
      "</Preset_Sel_Item></Preset></Play_Control></Tuner></YAMAHA_AV>";
    await h.controller.start();
    h.client.calls.length = 0;
    expect(h.controller.handleWrite("tuner.preset", 3)).toBe("unavailable");
    await expect(Promise.resolve(h.controller.handleWrite("tuner.preset", 2))).resolves.toBe("sent");
    expect(h.client.sent()).toEqual([
      "Tuner:<Play_Control><Preset><Preset_Sel>A2</Preset_Sel></Preset></Play_Control>",
    ]);
  });
});

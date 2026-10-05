import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { xmlHarness, type XmlHarness } from "../../../test/helpers/xml-controller";
import { rememberedBrowseVerdicts } from "./browse-probe";

// Review 2026-10-05, A21: the menu probe was one verdict for twelve menus. A single "not now" (RC 3/4) threw it all
// away — a proven NET_RADIO menu was not offered for the session (0 instead of 22 objects), and a service that always
// answers RC 4 (region-locked) kept the menu away for good.

/** The RX-V6A's real answers (inventory fixture, the 2026-09-01 capture). */
const RX_V6A = (
  JSON.parse(readFileSync(join(__dirname, "../../../test/fixtures/inventory/rxv6a.json"), "utf8")) as {
    xml: { answers: Record<string, string> };
  }
).xml.answers;
const LIST = "<List_Info>GetParam</List_Info>";
const NOT_NOW = '<YAMAHA_AV rsp="GET" RC="4"><Pandora><List_Info></List_Info></Pandora></YAMAHA_AV>';

/**
 * Start a receiver whose NET_RADIO proves its menu; Pandora answers as given, every other menu is absent (RC 2).
 *
 * @param pandora Pandora's answer
 * @param memory the device's memory
 * @returns the started harness
 */
async function receiver(pandora: string | undefined, memory: ProbeMemory): Promise<XmlHarness> {
  const h = xmlHarness({ Main_Zone: { power: true } }, memory);
  for (const element of ["SERVER", "USB", "iPod_USB", "JUKE", "Napster", "Rhapsody", "SiriusXM", "NET_USB", "iPod"]) {
    for (const list of ["List_Info", "List_Info_2"]) {
      h.client.xmlAnswers[`${element}|<${list}>GetParam</${list}>`] =
        `<YAMAHA_AV rsp="GET" RC="2"><${element}></${element}></YAMAHA_AV>`;
    }
  }
  h.client.xmlAnswers[`NET_RADIO|${LIST}`] = RX_V6A["NET_RADIO/List_Info"];
  if (pandora !== undefined) {
    h.client.xmlAnswers[`Pandora|${LIST}`] = pandora;
  }
  await h.controller.start();
  return h;
}

const browseObjects = (h: XmlHarness): string[] => h.objects.filter(id => id.includes(".player.browse"));
const asked = (h: XmlHarness): string[] =>
  h.client.calls.filter(call => call.method === "getXml" && /List_Info/.test(call.inner ?? "")).map(call => call.zone);

describe("one verdict per menu source (review 2026-10-05, A21)", () => {
  test('a proven NET_RADIO menu is offered although Pandora answers "not now"', async () => {
    const control = await receiver(undefined, new ProbeMemory({ __schema: DISCOVERY_SCHEMA }));
    const h = await receiver(NOT_NOW, new ProbeMemory({ __schema: DISCOVERY_SCHEMA }));
    expect(browseObjects(h).length).toBeGreaterThan(0);
    expect(browseObjects(h)).toEqual(browseObjects(control));
    const verdicts = h.memory.remembered<{ proven: string[]; absent: string[] }>("xmlBrowseSources:v2");
    expect(verdicts?.proven).toEqual(["NET_RADIO"]);
    // Pandora is undecided: in neither list.
    expect(verdicts?.absent).not.toContain("Pandora");
    expect(verdicts?.absent).toContain("SERVER");
  });

  test("the next connect asks only the undecided source — and a lasting RC 4 never hides the menu", async () => {
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
    await receiver(NOT_NOW, memory);
    for (let connect = 0; connect < 2; connect++) {
      const again = await receiver(NOT_NOW, memory);
      expect(asked(again)).toEqual(["Pandora"]);
      expect(browseObjects(again).length).toBeGreaterThan(0);
    }
    // Once Pandora answers for good, nothing is asked any more.
    await receiver('<YAMAHA_AV rsp="GET" RC="2"></YAMAHA_AV>', memory);
    expect(memory.remembered<{ absent: string[] }>("xmlBrowseSources:v2")?.absent).toContain("Pandora");
    const settled = await receiver(NOT_NOW, memory);
    expect(asked(settled)).toEqual([]);
  });

  test("the list an earlier release remembered counts as proven; the others are asked once more", async () => {
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA, "xmlBrowseSources:v2": ["NET_RADIO"] });
    const h = await receiver(undefined, memory);
    expect(asked(h)).not.toContain("NET_RADIO");
    expect(asked(h)).toContain("SERVER");
    expect(browseObjects(h).length).toBeGreaterThan(0);
    expect(memory.remembered<{ proven: string[] }>("xmlBrowseSources:v2")?.proven).toEqual(["NET_RADIO"]);
  });

  test("the remembered verdicts read every shape", () => {
    expect(rememberedBrowseVerdicts(undefined)).toEqual({ proven: new Set(), absent: new Set() });
    expect(rememberedBrowseVerdicts(["SERVER", 3])).toEqual({ proven: new Set(["SERVER"]), absent: new Set() });
    expect(rememberedBrowseVerdicts({ proven: ["USB"], absent: ["JUKE"] })).toEqual({
      proven: new Set(["USB"]),
      absent: new Set(["JUKE"]),
    });
    expect(rememberedBrowseVerdicts({ proven: "USB" })).toEqual({ proven: new Set(), absent: new Set() });
  });
});

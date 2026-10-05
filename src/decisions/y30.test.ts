import { describe, expect, test } from "vitest";
import { catalogToObjects } from "../lib/catalog/build-objects";
import { keyedCommon, type ObjectDef } from "../lib/catalog/types";
import { CommandGate } from "../lib/lifecycle/command-gate";
import { DISCOVERY_SCHEMA } from "../lib/lifecycle/discovery-schema";
import { ProbeMemory } from "../lib/lifecycle/probe-memory";
import { XmlDeviceController } from "../lib/xml/device-controller";
import { YNCA_CATALOG, enumStatesFor } from "../lib/ynca/catalog";
import { YXC_AMP_CATALOG } from "../lib/yxc/catalog";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { XML_AMP_CATALOG } from "../lib/xml/catalog";
import { stateToXml } from "../lib/xml/command-mapper";
import { parseBasicStatus, parseDescriptor } from "../lib/xml/protocol";

// Y-30 (krobi 2026-10-05 22:47 "if the protocol can take a free number it becomes a free number, and if fixed values
// then a dropdown"): sleep knows only fixed steps on every protocol (MusicCast YXC §5.4: 0/30/60/90/120), so it is a
// dropdown everywhere — with the same values on every receiver. The 2008 XML generation (RX-V3900) says `30` … `120`
// and showed them so; it shows the shared spelling now (Werkbank parity finding, accepted 22:56). The other half
// (22:50 "the free value shall not be a string but a number"): a free number is never text — a datapoint with limits
// is a number on every protocol.

const STEPS = ["Off", "30 min", "60 min", "90 min", "120 min"];

/**
 * A device description declaring the sleep steps in the given words.
 *
 * @param words the declared steps
 * @returns the desc.xml excerpt
 */
function descriptor(words: readonly string[]): string {
  const steps = words.map(word => `<Direct>${word}</Direct>`).join("");
  return `<Cmd ID="P1" Type="Text">Power_Control,Sleep=Param_1</Cmd><Param_1>${steps}</Param_1>`;
}

describe("Y-30 sleep is the same dropdown on every protocol and generation", () => {
  test("YNCA and MusicCast build a dropdown of the five steps", () => {
    const ynca = catalogToObjects(YNCA_CATALOG.filter(entry => entry.id === "sleep")).find(o => o.id === "sleep");
    const yxc = mapYxcToObjects({ zones: [{ id: "main", funcs: ["sleep"], inputs: [] }], media: [] }).find(
      o => o.id === "sleep",
    );
    for (const common of [ynca?.common, yxc?.common]) {
      expect([common?.type, Object.keys(common?.states ?? {})]).toEqual(["string", STEPS]);
    }
  });

  test("XML: every generation's declared steps become the same values", () => {
    expect(parseDescriptor(descriptor(["120 min", "90 min", "60 min", "30 min", "Off"])).sleep).toEqual(STEPS);
    expect(parseDescriptor(descriptor(["120", "90", "60", "30", "Off"])).sleep).toEqual(STEPS);
  });

  test("XML 2008: a reported step reads in the shared spelling, a written one goes out in the device's own", () => {
    const status = (word: string): unknown =>
      parseBasicStatus(`<Basic_Status><Power_Control><Sleep>${word}</Sleep></Power_Control></Basic_Status>`).sleep;
    expect([status("30"), status("120"), status("Off"), status("60 min")]).toEqual([
      "30 min",
      "120 min",
      "Off",
      "60 min",
    ]);
    expect(stateToXml("sleep", "30 min", "legacy")?.inner).toBe("<Power_Control><Sleep>30</Sleep></Power_Control>");
    expect(stateToXml("sleep", "30 min", "classic")?.inner).toBe(
      "<Power_Control><Sleep>30 min</Sleep></Power_Control>",
    );
    expect(stateToXml("sleep", "Off", "legacy")?.inner).toBe("<Power_Control><Sleep>Off</Sleep></Power_Control>");
  });
});

describe("Y-30 a free number is a number, never text", () => {
  test("no datapoint of the three protocol builders carries limits without being a number", () => {
    const funcs = [
      ...new Set(YXC_AMP_CATALOG.flatMap(entry => (entry.create.kind === "func" ? [entry.create.func] : []))),
    ];
    const ranges = Object.fromEntries(
      [...new Set(YXC_AMP_CATALOG.flatMap(entry => (entry.range ? [entry.range] : [])))].map(key => [
        key,
        { min: -10, max: 10, step: 1 },
      ]),
    );
    const commons: Array<[string, { type?: string; min?: number; max?: number }]> = [
      ...catalogToObjects([...YNCA_CATALOG]).map(def => [`ynca ${def.id}`, def.common] as [string, typeof def.common]),
      ...mapYxcToObjects({ zones: [{ id: "main", funcs, inputs: ["hdmi1"], ranges }], media: [] }).map(
        def => [`yxc ${def.id}`, def.common] as [string, typeof def.common],
      ),
      ...XML_AMP_CATALOG.map(entry => [`xml ${entry.state}`, entry.common] as [string, typeof entry.common]),
    ];
    const bounded = commons.filter(([, common]) => common.min !== undefined || common.max !== undefined);
    // Positive control: every protocol builds bounded datapoints, so the rule is checked on all three.
    expect(new Set(bounded.map(([id]) => id.split(" ")[0]))).toEqual(new Set(["ynca", "yxc", "xml"]));
    expect(bounded.filter(([, common]) => common.type !== "number").map(([id]) => id)).toEqual([]);
  });
});

describe("Y-30 fixed values are a dropdown", () => {
  /**
   * The XML controller's tree for a receiver whose description declares its sound programs and sleep steps and whose
   * zone declares its inputs.
   *
   * @returns the definitions, by id relative to the device
   */
  async function xmlTree(): Promise<Map<string, ObjectDef>> {
    const programs =
      '<Cmd ID="P2" Type="Text">Surround,Program_Sel,Current,Sound_Program=Param_1</Cmd><Param_1>' +
      "<Direct>Hall in Munich</Direct><Direct>Standard</Direct></Param_1>";
    const desc = `${descriptor(["Off", "30 min", "60 min", "90 min", "120 min"])}${programs}`;
    const answers: Record<string, string> = {
      "Main_Zone|<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>":
        "<Input_Sel_Item><Item_1><Param>HDMI1</Param><RW>RW</RW><Title>HDMI1</Title></Item_1></Input_Sel_Item>",
    };
    const defs = new Map<string, ObjectDef>();
    const controller = new XmlDeviceController("living", {
      gate: new CommandGate({
        minSpacingMs: 0,
        timers: {
          schedule: (h, ms) => setTimeout(h, ms),
          cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>),
        },
      }),
      probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
      client: {
        getStatus: (zone: string) =>
          Promise.resolve(
            zone === "Main_Zone" ? { power: true, input: "HDMI1", soundProgram: "Standard", sleep: "Off" } : {},
          ),
        getSystemConfig: () => Promise.resolve({}),
        getDescriptor: () => Promise.resolve(desc),
        send: () => Promise.resolve(),
        getXml: (zone: string, inner: string) => Promise.resolve(answers[`${zone}|${inner}`] ?? ""),
      },
      scheduleKeepalive: () => () => undefined,
      upsertObject: (id, def) => {
        defs.set(id.replace(/^living\./, ""), def);
        return Promise.resolve();
      },
      setStateAck: () => undefined,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      host: "192.0.2.10",
    });
    await controller.start();
    controller.close();
    return defs;
  }

  test("every entry that declares fixed values builds a dropdown, on all three protocols", async () => {
    const withoutDropdown: string[] = [];
    const checked = { ynca: 0, yxc: 0, xml: 0 };
    // YNCA: every enum, with the list its catalog declares — or, where the official lists share no common core, the
    // value the device reports (`enumStatesFor`, the resolver the controller hands the builder).
    const enums = YNCA_CATALOG.filter(entry => entry.spec.kind === "enum");
    for (const def of catalogToObjects(enums, entry => {
      const found = enums.find(e => e.id === entry.id)!;
      return { states: enumStatesFor(found, [], "Reported") };
    })) {
      if (def.type === "state" && enums.some(e => e.id === def.id)) {
        checked.ynca++;
        if (!def.common.states || Object.keys(def.common.states).length === 0) {
          withoutDropdown.push(`ynca ${def.id}`);
        }
      }
    }
    // MusicCast: the catalog's own list, and the list getFeatures declares for a zone.
    const funcs = [
      ...new Set(YXC_AMP_CATALOG.flatMap(entry => (entry.create.kind === "func" ? [entry.create.func] : []))),
    ];
    const listed = YXC_AMP_CATALOG.filter(entry => entry.common.type === "string").map(entry => entry.state);
    const valueLists = Object.fromEntries(listed.map(state => [state, ["first", "second"]]));
    const yxc = mapYxcToObjects({ zones: [{ id: "main", funcs, inputs: ["hdmi1"], valueLists }], media: [] });
    for (const state of [...listed, ...YXC_AMP_CATALOG.filter(e => e.common.states).map(e => e.state)]) {
      const def = yxc.find(o => o.id === state);
      if (def) {
        checked.yxc++;
        if (!def.common.states) {
          withoutDropdown.push(`yxc ${state}`);
        }
      }
    }
    // XML: the catalog's own lists, and the lists the receiver declares (inputs, programs, sleep steps).
    for (const entry of XML_AMP_CATALOG.filter(e => e.common.states)) {
      checked.xml++;
      if (!keyedCommon(entry.common).states) {
        withoutDropdown.push(`xml ${entry.state}`);
      }
    }
    const xml = await xmlTree();
    for (const id of ["input", "soundProgram", "sleep"]) {
      checked.xml++;
      if (!xml.get(id)?.common.states) {
        withoutDropdown.push(`xml ${id}`);
      }
    }
    // Positive control: every protocol has entries with fixed values, so the rule is checked on all three.
    expect(Object.values(checked).every(count => count > 0)).toBe(true);
    expect(withoutDropdown).toEqual([]);
  });
});

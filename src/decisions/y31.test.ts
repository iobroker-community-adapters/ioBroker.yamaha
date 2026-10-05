import { describe, expect, test } from "vitest";
import { catalogToObjects } from "../lib/catalog/build-objects";
import { YNCA_CATALOG, yncaWrite } from "../lib/ynca/catalog";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { yxcWrite } from "../lib/yxc/command-mapper";
import { XML_AMP_CATALOG } from "../lib/xml/catalog";
import { stateToXml } from "../lib/xml/command-mapper";
import { parseBasicStatus } from "../lib/xml/protocol";

// Y-31 (krobi 2026-10-05 22:47 "y31 yes"): Adaptive DRC is a switch on every protocol. "Auto" from the device means
// on, and a written "Auto" is still taken.

const ID = "sound.adaptiveDrc";

describe("Y-31 Adaptive DRC is a switch everywhere", () => {
  test("YNCA, MusicCast and XML build a boolean switch", () => {
    const ynca = catalogToObjects(YNCA_CATALOG.filter(entry => entry.id === ID)).find(o => o.id === ID)?.common;
    const yxc = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["adaptive_drc"], inputs: [] }],
      media: [],
    }).find(o => o.id === ID)?.common;
    const xml = XML_AMP_CATALOG.find(entry => entry.state === ID)?.common;
    for (const common of [ynca, yxc, xml]) {
      expect([common?.type, common?.role, common?.write]).toEqual(["boolean", "switch", true]);
    }
  });

  test("the device's Auto reads as on, Off as off", () => {
    const entry = YNCA_CATALOG.find(e => e.id === ID);
    expect(entry?.spec).toMatchObject({ kind: "onoff", on: "Auto", off: "Off" });
    expect(parseBasicStatus("<Sound_Video><Adaptive_DRC>Auto</Adaptive_DRC></Sound_Video>").adaptiveDrc).toBe(true);
    expect(parseBasicStatus("<Sound_Video><Adaptive_DRC>Off</Adaptive_DRC></Sound_Video>").adaptiveDrc).toBe(false);
  });

  test("a written true and a written Auto both switch it on, on every protocol", async () => {
    const entry = YNCA_CATALOG.find(e => e.id === ID)!;
    for (const value of [true, "Auto"]) {
      expect(yncaWrite(entry, value)).toMatchObject({ func: "ADAPTIVEDRC", value: "Auto" });
      expect(stateToXml(ID, value)?.inner).toContain("<Adaptive_DRC>Auto</Adaptive_DRC>");
      const sent: boolean[] = [];
      const command = yxcWrite(ID, value).command;
      expect(command?.kind).toBe("run");
      await (command as { run(client: unknown): Promise<unknown> }).run({
        setAdaptiveDrc: (on: boolean) => {
          sent.push(on);
          return Promise.resolve();
        },
      });
      expect(sent).toEqual([true]);
    }
    expect(yncaWrite(entry, false)).toMatchObject({ value: "Off" });
    expect(stateToXml(ID, false)?.inner).toContain("<Adaptive_DRC>Off</Adaptive_DRC>");
  });
});

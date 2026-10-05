import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formDifferences, type FormDifference } from "../lib/catalog/object-form";
import { withValueLabels } from "../lib/catalog/state-labels";
import { keyedCommon, type ObjectDef } from "../lib/catalog/types";
import { yncaObjectsFor } from "../lib/ynca/catalog";
import type { YncaCapabilities } from "../lib/ynca/capability";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import type { YxcCapabilities } from "../lib/yxc/capability";
import { XML_AMP_CATALOG } from "../lib/xml/catalog";

// Y-29 (krobi 2026-10-05 22:47 "y29 yes"): the three protocols behave the same. For the user it makes no difference
// whether YNCA, MusicCast or XML serves a datapoint: the same form, the same values, the same behaviour on a write and
// on an error. A difference stands only in the parity check's exception list (src/lib/parity.test.ts), with the reason
// the protocol cannot do otherwise — today exactly three.

const ROOT = join(__dirname, "..", "..");

/** The parity check's exception list as written: each entry's id pattern. */
function exceptionIds(): string[] {
  const text = readFileSync(join(ROOT, "src", "lib", "parity.test.ts"), "utf-8");
  const block = /const EXCEPTIONS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/^\s*id:\s*(\/.*\/),?$/gm)].map(match => match[1]);
}

/** The three exceptions and the fields each may differ in (the parity check's list, pinned below). */
const EXCEPTIONS: ReadonlyArray<{ id: RegExp; fields: readonly string[] }> = [
  { id: /^(multiroom\.zone[234B]\.)?volume$/, fields: ["common.unit", "common.min", "common.max"] },
  { id: /^sound\.subwooferTrim$/, fields: ["common.unit", "common.min", "common.max", "common.step"] },
  { id: /^tuner\.presetSave$/, fields: ["common.min", "common.name"] },
];

/** Fields that follow writability: a protocol that cannot write a value shows it as a read-only value. */
const WRITABILITY_FIELDS = new Set(["common.write", "common.role", "common.min", "common.max", "common.step"]);

/** One AV receiver that speaks all three protocols, as each protocol declares it. */
const YNCA: YncaCapabilities = {
  model: "RX-V6A",
  subunits: {
    SYS: { MODELNAME: "RX-V6A", VERSION: "1.0" },
    MAIN: {
      PWR: "On",
      VOL: "-40.0",
      MUTE: "Off",
      INP: "HDMI1",
      SOUNDPRG: "Standard",
      STRAIGHT: "Off",
      ENHANCER: "Off",
      PUREDIRMODE: "Off",
      SLEEP: "Off",
      ADAPTIVEDRC: "Off",
      TONEBASS: "0.0",
      TONETREBLE: "0.0",
      SWFRTRIM: "0.0",
    },
  },
};

const YXC: YxcCapabilities = {
  zones: [
    {
      id: "main",
      funcs: ["power", "volume", "mute", "sleep", "tone_control", "adaptive_drc", "pure_direct", "enhancer", "direct"],
      inputs: ["hdmi1"],
      ranges: {
        volume: { min: 0, max: 161, step: 1 },
        actual_volume_db: { min: -80.5, max: 16.5, step: 0.5 },
        tone_control: { min: -12, max: 12, step: 1 },
      },
    },
  ],
  media: [],
};

/** The XML catalog's main-zone datapoints, as the XML controller names them. */
function xmlObjects(): ObjectDef[] {
  return XML_AMP_CATALOG.filter(entry => !entry.zonesOnly && !entry.state.startsWith("multiroom.")).map(entry => ({
    id: entry.state,
    type: "state",
    common: keyedCommon(entry.common),
  }));
}

/**
 * The differences between two protocols' definitions of one datapoint that are bugs — the parity check's rule: a
 * value only one list carries is that protocol's vocabulary, a field that follows writability differs with it, and
 * the three exceptions.
 *
 * @param id the canonical id
 * @param a one protocol's definition
 * @param b the other's
 * @returns the unexplained differences
 */
function unexplained(id: string, a: ObjectDef, b: ObjectDef): FormDifference[] {
  const writabilityDiffers = a.common.write !== b.common.write;
  return formDifferences(withValueLabels(id, a, "en"), withValueLabels(id, b, "en")).filter(
    d =>
      !(d.field.startsWith("common.states.") && (d.a === undefined || d.b === undefined)) &&
      !(writabilityDiffers && WRITABILITY_FIELDS.has(d.field)) &&
      !EXCEPTIONS.some(exception => exception.id.test(id) && exception.fields.includes(d.field)),
  );
}

describe("Y-29 the three protocols behave the same", () => {
  test("the parity check's exceptions are exactly today's three: volume (Y-05), subwoofer (Y-33), preset store", () => {
    expect(exceptionIds()).toEqual(EXCEPTIONS.map(exception => String(exception.id)));
  });

  test("a datapoint two protocols build on one receiver has the same form", () => {
    const trees = {
      ynca: yncaObjectsFor(YNCA),
      yxc: mapYxcToObjects(YXC),
      xml: xmlObjects(),
    };
    const states = (tree: ObjectDef[]): Map<string, ObjectDef> =>
      new Map(tree.filter(def => def.type === "state").map(def => [def.id, def]));
    const byProtocol = Object.entries(trees).map(([protocol, tree]) => [protocol, states(tree)] as const);
    const findings: string[] = [];
    let compared = 0;
    for (let i = 0; i < byProtocol.length; i++) {
      for (let j = i + 1; j < byProtocol.length; j++) {
        const [nameA, a] = byProtocol[i];
        const [nameB, b] = byProtocol[j];
        for (const [id, defA] of a) {
          const defB = b.get(id);
          if (!defB) {
            continue;
          }
          compared++;
          for (const d of unexplained(id, defA, defB)) {
            findings.push(`${nameA}/${nameB} ${id} ${d.field}: ${JSON.stringify(d.a)} ≠ ${JSON.stringify(d.b)}`);
          }
        }
      }
    }
    // Positive control: the protocols really share datapoints on this receiver, so the comparison is not empty.
    expect(compared).toBeGreaterThan(20);
    expect(findings).toEqual([]);
  });
});

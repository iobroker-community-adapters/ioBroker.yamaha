import { formDifferences, type FormDifference } from "./catalog/object-form";
import { withValueLabels } from "./catalog/state-labels";
import type { Transport } from "./catalog/owner-policy";
import type { ObjectDef } from "./catalog/types";
import {
  readTransport,
  startFixtures,
  type FixtureDevice,
  type TransportTree,
} from "../../test/helpers/parity-harness";

/**
 * Parity of the three protocols (krobi 2026-10-05: "alle 3 protokolle müssen sich konsistent verhalten, für den
 * enduser darf es keinen unterschied welche protokoll genutzt wird"). Every inventory fixture device is read once per
 * protocol it speaks, each protocol alone and through the real client, controller and transport adapter. A datapoint
 * two protocols build on one receiver must have the same form; every value a protocol reports must have an object.
 *
 * A difference is a bug unless it stands below with the proof that the protocol cannot do otherwise.
 */

/** Differences that are the receiver's or the specification's, not the adapter's — each with its reason. */
const EXCEPTIONS: ReadonlyArray<{ id: RegExp; fields: readonly string[]; why: string }> = [
  {
    id: /^(multiroom\.zone[234B]\.)?volume$/,
    fields: ["common.unit", "common.min", "common.max"],
    why: "Y-05 (sealed): volume shows the scale the receiver reports — MusicCast the display (dB or plain numbers), YNCA and XML decibels; the owner is chosen once per receiver",
  },
  {
    id: /^sound\.subwooferTrim$/,
    fields: ["common.unit", "common.min", "common.max", "common.step"],
    why: "MusicCast's subwoofer steps differ by model (-12..12, -10..10, -4..4) and no specification says what a step is; on a receiver YNCA or XML own it in decibels",
  },
  {
    id: /^tuner\.presetSave$/,
    fields: ["common.min", "common.name"],
    why: "YNCA's MEM takes 0 for the first free slot (official command list) — MusicCast has no such slot",
  },
];

/** Fields that follow writability: a protocol that cannot write a value shows it as a read-only value. */
const WRITABILITY_FIELDS = new Set(["common.write", "common.role", "common.min", "common.max", "common.step"]);

/**
 * The differences between two protocols' definitions of one datapoint that are bugs.
 *
 * @param id the canonical id
 * @param a one protocol's definition
 * @param b the other's
 * @returns the unexplained differences
 */
function unexplained(id: string, a: ObjectDef, b: ObjectDef): FormDifference[] {
  const writabilityDiffers = a.common.write !== b.common.write;
  return formDifferences(withValueLabels(id, a, "en"), withValueLabels(id, b, "en")).filter(d => {
    // A value list is each protocol's declaration of what IT takes — different words are its vocabulary, which the
    // coordinator unifies per receiver. A value both list has to read the same.
    if (d.field.startsWith("common.states.") && (d.a === undefined || d.b === undefined)) {
      return false;
    }
    // Only one protocol can write it (the owner policy hands it to that one, with its evidence).
    if (writabilityDiffers && WRITABILITY_FIELDS.has(d.field)) {
      return false;
    }
    return !EXCEPTIONS.some(exception => exception.id.test(id) && exception.fields.includes(d.field));
  });
}

describe("parity of YNCA, MusicCast and XML over the inventory fixtures (krobi 2026-10-05)", () => {
  let fixtures: { devices: FixtureDevice[]; stop: () => Promise<void> };
  const trees = new Map<string, Map<Transport, TransportTree>>();

  beforeAll(async () => {
    fixtures = await startFixtures();
    for (const device of fixtures.devices) {
      const byTransport = new Map<Transport, TransportTree>();
      for (const transport of device.transports) {
        byTransport.set(transport, await readTransport(device, transport));
      }
      trees.set(device.id, byTransport);
    }
  }, 120_000);

  afterAll(async () => {
    await fixtures.stop();
  });

  it("reads every fixture device over every protocol it speaks", () => {
    for (const device of fixtures.devices) {
      for (const transport of device.transports) {
        expect(trees.get(device.id)?.get(transport)?.objects.size, `${device.id}/${transport}`).toBeGreaterThan(10);
      }
    }
  });

  it("builds every datapoint two protocols serve on one receiver with the same form", () => {
    const found: string[] = [];
    for (const [device, byTransport] of trees) {
      const transports = [...byTransport.keys()];
      for (let i = 0; i < transports.length; i++) {
        for (let j = i + 1; j < transports.length; j++) {
          const one = byTransport.get(transports[i])!.objects;
          const other = byTransport.get(transports[j])!.objects;
          for (const [id, a] of one) {
            const b = other.get(id);
            if (a.type !== "state" || b?.type !== "state") {
              continue;
            }
            for (const d of unexplained(id, a, b)) {
              found.push(
                `${device} ${transports[i]}/${transports[j]} ${id} ${d.field}: ${JSON.stringify(d.a)} ≠ ${JSON.stringify(d.b)}`,
              );
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("gives every value a protocol reports an object, so no value is dropped silently", () => {
    const orphans: string[] = [];
    for (const [device, byTransport] of trees) {
      for (const [transport, tree] of byTransport) {
        for (const id of tree.values.keys()) {
          if (!tree.objects.has(id)) {
            orphans.push(`${device}/${transport} ${id}`);
          }
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  it("names the same datapoint the same on every receiver, whichever protocol serves it", () => {
    // Across receivers: type and name of one canonical id (bounds and lists are the device's own).
    const seen = new Map<string, { where: string; type: unknown; name: string }>();
    const found: string[] = [];
    for (const [device, byTransport] of trees) {
      for (const [transport, tree] of byTransport) {
        for (const [id, def] of tree.objects) {
          if (def.type !== "state") {
            continue;
          }
          const name = JSON.stringify(def.common.name);
          const before = seen.get(id);
          if (!before) {
            seen.set(id, { where: `${device}/${transport}`, type: def.common.type, name });
          } else if (before.type !== def.common.type || before.name !== name) {
            found.push(
              `${id}: ${before.where} ${String(before.type)} ${before.name} ≠ ${device}/${transport} ${String(def.common.type)} ${name}`,
            );
          }
        }
      }
    }
    expect(
      found.filter(line => !EXCEPTIONS.some(e => e.id.test(line.split(":")[0]) && e.fields.includes("common.name"))),
    ).toEqual([]);
  });
});

import type { ObjectDef } from "./types";

/**
 * The form of a datapoint that has to be the same whichever protocol serves it (krobi 2026-10-05: "alle 3 protokolle
 * müssen sich konsistent verhalten"): the object type, and in `common` the value type, unit, role, name, read/write,
 * the bounds and the value list.
 */

/** One difference in what a user sees of a datapoint, between two definitions of it. */
export interface FormDifference {
  /**
   * What differs: `type`, `common.type`, `common.unit`, `common.role`, `common.name`, `common.read`, `common.write`,
   * `common.min`, `common.max`, `common.step` — or `common.states.<value>` for one entry of the value list.
   */
  field: string;
  /** The first definition's side; undefined where it has none. */
  a: unknown;
  /** The second definition's side; undefined where it has none. */
  b: unknown;
}

/** The `common` fields compared as they stand. */
const PLAIN_FIELDS = ["type", "role", "read", "write", "min", "max", "step"] as const;

/**
 * Whether two names read the same: the same text, or translation objects with the same text in every language.
 *
 * @param a one name
 * @param b the other
 * @returns whether a reader sees the same name in every language
 */
function sameName(a: ioBroker.StringOrTranslated, b: ioBroker.StringOrTranslated): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return a === b;
  }
  const languages = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...languages].every(
    language => (a as Record<string, string>)[language] === (b as Record<string, string>)[language],
  );
}

/**
 * The differences in the user-visible form of two definitions of ONE datapoint — the check behind the rule that a
 * datapoint is the same on YNCA, MusicCast and XML. Not compared: the id, the explanation, and the flags the adapter
 * never writes to the object (`liveLabels`, `declaredStates`, `unproven`, `reportedValue`). A missing unit and an
 * empty one are the same; every other field is compared as it stands.
 *
 * The value labels the user sees come from the one label table at write time — to compare those, pass both
 * definitions through `withValueLabels` (catalog/state-labels.ts) in the same language first.
 *
 * @param a one definition (as one protocol builds it)
 * @param b the other (as another protocol builds it)
 * @returns the differences, empty when a user sees the same datapoint
 */
export function formDifferences(a: ObjectDef, b: ObjectDef): FormDifference[] {
  const differences: FormDifference[] = [];
  if (a.type !== b.type) {
    differences.push({ field: "type", a: a.type, b: b.type });
  }
  for (const field of PLAIN_FIELDS) {
    if (a.common[field] !== b.common[field]) {
      differences.push({ field: `common.${field}`, a: a.common[field], b: b.common[field] });
    }
  }
  if ((a.common.unit ?? "") !== (b.common.unit ?? "")) {
    differences.push({ field: "common.unit", a: a.common.unit, b: b.common.unit });
  }
  if (!sameName(a.common.name, b.common.name)) {
    differences.push({ field: "common.name", a: a.common.name, b: b.common.name });
  }
  const statesA = a.common.states ?? {};
  const statesB = b.common.states ?? {};
  for (const value of new Set([...Object.keys(statesA), ...Object.keys(statesB)])) {
    const labelA = Object.hasOwn(statesA, value) ? statesA[value] : undefined;
    const labelB = Object.hasOwn(statesB, value) ? statesB[value] : undefined;
    if (labelA !== labelB) {
      differences.push({ field: `common.states.${value}`, a: labelA, b: labelB });
    }
  }
  return differences;
}

import type { ObjectDef } from "./types";
import { canonicalIdOf, capabilityKeyOf, pickOwner, type Transport } from "./owner-policy";

/** One transport's contribution: the objects its catalog builds for this device. */
export interface TransportObjects {
  /** The transport these objects come from. */
  transport: Transport;
  /** The objects the transport's catalog builds (its own state ids, possibly drifting/zoned). */
  objects: readonly ObjectDef[];
}

/**
 * Merge the present transports' catalogs into one unified object tree. Each capability appears
 * exactly once, emitted by its owning transport (see {@link pickOwner}) under the canonical id;
 * drifting ids and per-zone duplicates across transports collapse to one node. Objects are
 * ordered parents-before-children so the intermediate channels exist before their states.
 *
 * @param contributions the objects each present transport offers
 * @returns the deduplicated tree and the owner of each canonical id (for write routing)
 */
export function coordinateObjectTree(contributions: readonly TransportObjects[]): {
  objects: ObjectDef[];
  ownerByCanonicalId: Map<string, Transport>;
} {
  // Map iteration follows insertion order, so first-seen order needs no side list.
  const byId = new Map<string, { key: string; defs: Map<Transport, ObjectDef> }>();
  for (const { transport, objects } of contributions) {
    for (const obj of objects) {
      const canonicalId = canonicalIdOf(transport, obj.id);
      let entry = byId.get(canonicalId);
      if (!entry) {
        entry = { key: capabilityKeyOf(transport, obj.id), defs: new Map() };
        byId.set(canonicalId, entry);
      }
      entry.defs.set(transport, obj);
    }
  }
  const ownerByCanonicalId = new Map<string, Transport>();
  const resolved: ObjectDef[] = [...byId].map(([canonicalId, entry]) => {
    const owner = pickOwner(entry.key, [...entry.defs.keys()]);
    ownerByCanonicalId.set(canonicalId, owner);
    const ownerDef = entry.defs.get(owner);
    // Internal invariant, not a reachable state: pickOwner always returns one of the
    // candidates it was handed (= this entry's own defs). It exists so a future change
    // to pickOwner fails loudly instead of writing an empty object.
    if (!ownerDef) {
      throw new Error(`coordinateObjectTree: owner ${owner} has no def for ${canonicalId}`);
    }
    // Dropdown borrowing: the owner wins the WRITE PATH, but another transport may know
    // the value labels the owner cannot deliver — the scene titles come over XML/YNCA
    // while MusicCast owns the recall, the device's own input list comes over XML while
    // YNCA owns the input. The label map is pure presentation, so borrowing it never
    // changes routing; borrowed in modernity-independent claim order (first with one).
    const resolvedDef: ObjectDef = { ...ownerDef, id: canonicalId };
    if (!resolvedDef.common.states) {
      for (const def of entry.defs.values()) {
        if (def.common.states) {
          resolvedDef.common = { ...resolvedDef.common, states: def.common.states };
          break;
        }
      }
    }
    return resolvedDef;
  });
  // Parents before children: shallower id paths (fewer dotted segments) first. Array.sort is
  // stable (ES2019+), so equal-depth objects keep their first-seen order.
  resolved.sort((a, b) => a.id.split(".").length - b.id.split(".").length);
  return { objects: resolved, ownerByCanonicalId };
}

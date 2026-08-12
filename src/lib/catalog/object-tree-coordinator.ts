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
  const order: string[] = [];
  const byId = new Map<string, { key: string; defs: Map<Transport, ObjectDef> }>();
  for (const { transport, objects } of contributions) {
    for (const obj of objects) {
      const canonicalId = canonicalIdOf(transport, obj.id);
      let entry = byId.get(canonicalId);
      if (!entry) {
        entry = { key: capabilityKeyOf(transport, obj.id), defs: new Map() };
        byId.set(canonicalId, entry);
        order.push(canonicalId);
      }
      entry.defs.set(transport, obj);
    }
  }
  const ownerByCanonicalId = new Map<string, Transport>();
  const resolved: ObjectDef[] = order.map(canonicalId => {
    const entry = byId.get(canonicalId);
    if (!entry) {
      throw new Error(`coordinateObjectTree: missing entry for ${canonicalId}`);
    }
    const owner = pickOwner(entry.key, [...entry.defs.keys()]);
    ownerByCanonicalId.set(canonicalId, owner);
    const ownerDef = entry.defs.get(owner);
    if (!ownerDef) {
      throw new Error(`coordinateObjectTree: owner ${owner} has no def for ${canonicalId}`);
    }
    return { ...ownerDef, id: canonicalId };
  });
  // Parents before children: shallower id paths (fewer dotted segments) first. Array.sort is
  // stable (ES2019+), so equal-depth objects keep their first-seen order.
  resolved.sort((a, b) => a.id.split(".").length - b.id.split(".").length);
  return { objects: resolved, ownerByCanonicalId };
}

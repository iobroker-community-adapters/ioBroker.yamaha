import { channelCommon, type ObjectDef } from "./types";
import { canonicalIdOf, capabilityKeyOf, pickOwner, STATES_VOCABULARY, type Transport } from "./owner-policy";
import { translateDeclaredStates } from "./musiccast-vocabulary";

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
    const unproven = new Set([...entry.defs].filter(([, def]) => def.unproven).map(([transport]) => transport));
    const owner = pickOwner(entry.key, [...entry.defs.keys()], unproven);
    ownerByCanonicalId.set(canonicalId, owner);
    const ownerDef = entry.defs.get(owner);
    // Internal invariant, not a reachable state: pickOwner always returns one of the
    // candidates it was handed (= this entry's own defs). It exists so a future change
    // to pickOwner fails loudly instead of writing an empty object.
    if (!ownerDef) {
      throw new Error(`coordinateObjectTree: owner ${owner} has no def for ${canonicalId}`);
    }
    // Dropdown borrowing, two cases. (a) The owner has no labels at all: another claimant's map
    // is pure presentation and is taken as is (the scene titles over XML/YNCA while MusicCast owns
    // the recall). (b) The owner carries a catalog UNION and another transport carries the
    // device's OWN declaration: the declaration wins (#619 — the XML input list on the YNCA-owned
    // input), but only within one wire vocabulary, because the map's KEYS are what the owner's
    // write path will be asked to send. Borrowing never changes routing; borrowed in
    // modernity-independent claim order (first with one).
    const resolvedDef: ObjectDef = { ...ownerDef, id: canonicalId };
    if (!resolvedDef.common.states) {
      for (const def of entry.defs.values()) {
        if (def.common.states) {
          resolvedDef.common = { ...resolvedDef.common, states: def.common.states };
          break;
        }
      }
    } else if (!ownerDef.declaredStates) {
      for (const [transport, def] of entry.defs) {
        if (def.declaredStates && def.common.states && STATES_VOCABULARY[transport] === STATES_VOCABULARY[owner]) {
          resolvedDef.common = { ...resolvedDef.common, states: def.common.states };
          resolvedDef.declaredStates = true;
          break;
        }
      }
      // (c) No declaration in the owner's own vocabulary: a MusicCast declaration reaches a classic
      // owner through the evidenced dictionary — all or nothing, so no dropdown is ever half
      // translated. The XML list, when present, was taken above: the device's own spelling beats
      // the dictionary.
      if (!resolvedDef.declaredStates && STATES_VOCABULARY[owner] === "classic") {
        for (const [transport, def] of entry.defs) {
          if (def.declaredStates && def.common.states && STATES_VOCABULARY[transport] === "musiccast") {
            const translated = translateDeclaredStates(entry.key, def.common.states);
            if (translated) {
              resolvedDef.common = { ...resolvedDef.common, states: translated };
              resolvedDef.declaredStates = true;
              break;
            }
          }
        }
      }
    }
    return resolvedDef;
  });
  // Id drift can CREATE a parent path that no transport ever built a channel for: XML calls the
  // first HDMI output `hdmiOut1` — one flat segment, so its own parent loop makes no channel —
  // and canonicalIdOf turns it into `hdmi.out1`, which now needs an `hdmi` folder. Nobody was
  // responsible for that folder, and an XML-only receiver ended up with a datapoint whose parent
  // object did not exist (repochecker E3009, measured on the object inventory 2026-09-07).
  // This is the one place that knows the canonical ids, so it is the one place that can close it.
  const present = new Set(resolved.map(object => object.id));
  for (const object of [...resolved]) {
    const segments = object.id.split(".");
    for (let i = 1; i < segments.length; i++) {
      const channelId = segments.slice(0, i).join(".");
      if (!present.has(channelId)) {
        present.add(channelId);
        resolved.push({ id: channelId, type: "channel", common: channelCommon(segments[i - 1]) });
      }
    }
  }
  // Parents before children: shallower id paths (fewer dotted segments) first. Array.sort is
  // stable (ES2019+), so equal-depth objects keep their first-seen order.
  resolved.sort((a, b) => a.id.split(".").length - b.id.split(".").length);
  return { objects: resolved, ownerByCanonicalId };
}

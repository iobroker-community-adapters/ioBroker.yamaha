import { parentChannels, type ObjectDef } from "./types";
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
 * A declared list with the owner's currently reported value kept on it: a dropdown must never
 * hide what the device is showing, whichever transport declared the list (the harness measures
 * it on every fixture; an RX-A2070 whose YNCA half reports TV while its MusicCast list has none).
 *
 * @param states the adopted declared map
 * @param reported the value the owner reports right now, if known
 * @returns the map, the reported value appended when it was missing
 */
function withReported(states: Record<string, string>, reported: string | undefined): Record<string, string> {
  if (!reported || reported in states) {
    return states;
  }
  return { ...states, [reported]: reported };
}

/**
 * The value list a claimant lends an owner that has none. The labels are presentation, but the
 * keys are what the owner's write path will send and what it reports, so they must be the
 * owner's own values: the same value type, and for text the same wire vocabulary — or a MusicCast
 * list the evidenced dictionary translates in full. MusicCast's sleep minutes (`30`) on the
 * XML-owned text timer (`30 min`) were keys that receiver never reports and refuses (live
 * RX-V6A 2026-09-30: the value `Off` outside its own list).
 *
 * @param key the transport-neutral capability key
 * @param owner the owning transport
 * @param ownerDef the owner's definition
 * @param transport the claimant
 * @param def the claimant's definition
 * @returns the map to adopt, or undefined when its keys are not the owner's values
 */
function lentStates(
  key: string,
  owner: Transport,
  ownerDef: ObjectDef,
  transport: Transport,
  def: ObjectDef,
): Record<string, string> | undefined {
  const states = def.common.states;
  if (!states || def.common.type !== ownerDef.common.type) {
    return undefined;
  }
  if (def.common.type !== "string" || STATES_VOCABULARY[transport] === STATES_VOCABULARY[owner]) {
    return states;
  }
  return STATES_VOCABULARY[owner] === "classic" ? translateDeclaredStates(key, states) : undefined;
}

/**
 * Merge the present transports' catalogs into one unified object tree. Each capability appears
 * exactly once, emitted by its owning transport (see {@link pickOwner}) under the canonical id;
 * drifting ids and per-zone duplicates across transports collapse to one node. Objects are
 * ordered parents-before-children so the intermediate channels exist before their states.
 *
 * An owner the adapter already learned for an id ({@link LearnedTree}) is kept as long as it is one of the
 * contributors — ownership is decided once and stored, not computed again from whoever answered this time.
 *
 * @param contributions the objects each present transport offers
 * @param learnedOwners the owners already learned, by canonical id — they win over the ranking
 * @returns the deduplicated tree and the owner of each canonical id (for write routing)
 */
export function coordinateObjectTree(
  contributions: readonly TransportObjects[],
  learnedOwners?: ReadonlyMap<string, Transport>,
): {
  objects: ObjectDef[];
  ownerByCanonicalId: Map<string, Transport>;
} {
  // Map iteration follows insertion order, so first-seen order needs no side list.
  const byId = new Map<
    string,
    {
      key: string;
      defs: Map<Transport, ObjectDef>;
    }
  >();
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
    const learned = learnedOwners?.get(canonicalId);
    const owner =
      learned !== undefined && entry.defs.has(learned)
        ? learned
        : pickOwner(entry.key, [...entry.defs.keys()], unproven);
    ownerByCanonicalId.set(canonicalId, owner);
    const ownerDef = entry.defs.get(owner);
    // Internal invariant, not a reachable state: pickOwner always returns one of the
    // candidates it was handed (= this entry's own defs). It exists so a future change
    // to pickOwner fails loudly instead of writing an empty object.
    if (!ownerDef) {
      throw new Error(`coordinateObjectTree: owner ${owner} has no def for ${canonicalId}`);
    }
    // Dropdown borrowing, two cases. (a) The owner has no labels at all: another claimant's map
    // is taken for its labels (the scene titles over XML/YNCA while MusicCast owns the recall) —
    // see lentStates for when its keys fit the owner. (b) The owner carries a catalog UNION and another transport carries the
    // device's OWN declaration: the declaration wins (#619 — the XML input list on the YNCA-owned
    // input), but only within one wire vocabulary, because the map's KEYS are what the owner's
    // write path will be asked to send. Borrowing never changes routing; borrowed in
    // modernity-independent claim order (first with one).
    const resolvedDef: ObjectDef = { ...ownerDef, id: canonicalId };
    if (!resolvedDef.common.states) {
      for (const [transport, def] of entry.defs) {
        const lent = lentStates(entry.key, owner, ownerDef, transport, def);
        if (lent) {
          resolvedDef.common = { ...resolvedDef.common, states: lent };
          break;
        }
      }
    } else if (!ownerDef.declaredStates) {
      for (const [transport, def] of entry.defs) {
        if (def.declaredStates && def.common.states && STATES_VOCABULARY[transport] === STATES_VOCABULARY[owner]) {
          resolvedDef.common = {
            ...resolvedDef.common,
            states: withReported(def.common.states, ownerDef.reportedValue),
          };
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
              resolvedDef.common = { ...resolvedDef.common, states: withReported(translated, ownerDef.reportedValue) };
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
    resolved.push(...parentChannels(object.id, present));
  }
  // Parents before children: shallower id paths (fewer dotted segments) first. Array.sort is
  // stable (ES2019+), so equal-depth objects keep their first-seen order.
  resolved.sort((a, b) => a.id.split(".").length - b.id.split(".").length);
  return { objects: resolved, ownerByCanonicalId };
}

/**
 * Whether a user write meant for a datapoint's owner may be sent through another transport instead —
 * when the owner is offline or the device refused the command there (krobi 2026-10-02: "always try the
 * most modern one; if the command does not work with it, then the next one"). The ownership itself
 * does not move. Only where the value keeps its meaning: the same object and value type, the same unit,
 * and — where a dropdown is involved — the same wire vocabulary. A decibel bass (YNCA) is not MusicCast's
 * step count, a sleep text is not a number, "HDMI1" is not "hdmi1". A transport that only reads the
 * datapoint cannot carry a write (`hdmi.out3`, `sound.surroundAI` on MusicCast — audit 2026-09-29, A27).
 *
 * @param from the owner and its definition
 * @param from.transport the owner
 * @param from.def its definition
 * @param to the other transport and its definition
 * @param to.transport the other transport
 * @param to.def its definition
 * @returns whether the other transport can carry the write unchanged
 */
export function canCarryWrite(
  from: { transport: Transport; def: ObjectDef },
  to: { transport: Transport; def: ObjectDef },
): boolean {
  if (from.def.type !== to.def.type || from.def.common.type !== to.def.common.type) {
    return false;
  }
  if ((from.def.common.unit ?? "") !== (to.def.common.unit ?? "")) {
    return false;
  }
  if (!to.def.common.write) {
    return false;
  }
  const dropdown = Boolean(from.def.common.states) || Boolean(to.def.common.states);
  return !dropdown || STATES_VOCABULARY[from.transport] === STATES_VOCABULARY[to.transport];
}

/**
 * Whether a transport learned later may take a datapoint over: its definition must keep the form the
 * datapoint already has (2026-10-02 — a read-in receiver keeps its tree). The same shape test as
 * {@link canCarryWrite}, judged on the definitions themselves: the existing dropdown values must all
 * still be there (a device's list may grow, `HDMI1` is not `hdmi1`).
 *
 * @param existing the datapoint as it stands
 * @param existing.type its object type
 * @param existing.common its common
 * @param live the definition a live transport builds now
 * @returns whether writing the live definition leaves the datapoint's form unchanged
 */
export function keepsForm(existing: { type: string; common: Partial<ObjectDef["common"]> }, live: ObjectDef): boolean {
  if (existing.type !== live.type || existing.common.type !== live.common.type) {
    return false;
  }
  if ((existing.common.unit ?? "") !== (live.common.unit ?? "")) {
    return false;
  }
  if (existing.common.write && !live.common.write) {
    return false;
  }
  const before = Object.keys(existing.common.states ?? {});
  const now = new Set(Object.keys(live.common.states ?? {}));
  return before.every(value => now.has(value));
}

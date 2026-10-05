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
 * @returns the list to adopt, or undefined when its keys are not the owner's values
 */
function lentStates(
  key: string,
  owner: Transport,
  ownerDef: ObjectDef,
  transport: Transport,
  def: ObjectDef,
): AdoptedList | undefined {
  const states = def.common.states;
  if (!states || def.common.type !== ownerDef.common.type) {
    return undefined;
  }
  if (def.common.type !== "string" || STATES_VOCABULARY[transport] === STATES_VOCABULARY[owner]) {
    return { states, liveLabels: def.liveLabels === true };
  }
  // The dictionary gives words, not the names the user gave: no live labels.
  const translated = STATES_VOCABULARY[owner] === "classic" ? translateDeclaredStates(key, states) : undefined;
  return translated ? { states: translated, liveLabels: false } : undefined;
}

/** A value list a datapoint takes from another transport, and where its labels come from. */
interface AdoptedList {
  /** The list. */
  states: Record<string, string>;
  /** The list is a device's own declaration (see `ObjectDef.declaredStates`). */
  declared?: boolean;
  /** Its labels are names the user gives in the receiver (see `ObjectDef.liveLabels`). */
  liveLabels: boolean;
}

/**
 * The value list another transport gives the owner's datapoint, if any. Three cases. (a) The owner has no list
 * at all: another claimant's list is taken for its labels (the scene titles over XML/YNCA while MusicCast owns the
 * recall) — see {@link lentStates} for when its keys fit the owner. (b) The owner carries a catalog UNION and another
 * transport carries the device's OWN declaration: the declaration wins (#619 — the XML input list on the YNCA-owned
 * input), but only within one wire vocabulary, because the list's KEYS are what the owner's write path will be
 * asked to send. (c) No declaration in the owner's vocabulary: a MusicCast declaration reaches a classic owner
 * through the evidenced dictionary — all or nothing, so no dropdown is ever half translated; the XML list, when
 * present, was taken in (b): the device's own spelling beats the dictionary. Borrowing never changes routing;
 * borrowed in modernity-independent claim order (first with one).
 *
 * The labels' origin travels with the list: a list whose labels are names the user gives in the receiver
 * (`liveLabels`) follows renames while the adapter runs, any other keeps its labels (krobi 2026-10-05). A lent or
 * declared list brings the lender's flag; a dictionary brings words, not names — there the owner keeps its own
 * label (and flag) for a value it labels, so the input names YNCA reads (Y-25) survive a MusicCast declaration.
 *
 * A switch takes no list: its values are `true` and `false` over every protocol. XML's description words
 * (`On`/`Standby`) were lent to YNCA's and MusicCast's boolean `power` and `mute`, and a dropdown entry
 * "Standby" sent nothing (review 2026-10-05, A19).
 *
 * @param key the transport-neutral capability key
 * @param owner the owning transport
 * @param ownerDef the owner's definition
 * @param defs every transport's definition of the datapoint
 * @returns the list to adopt, or undefined when the owner keeps its own
 */
function adoptedList(
  key: string,
  owner: Transport,
  ownerDef: ObjectDef,
  defs: ReadonlyMap<Transport, ObjectDef>,
): AdoptedList | undefined {
  const own = ownerDef.common.states;
  if (ownerDef.common.type === "boolean" || (own && ownerDef.declaredStates)) {
    return undefined;
  }
  if (!own) {
    for (const [transport, def] of defs) {
      const lent = lentStates(key, owner, ownerDef, transport, def);
      if (lent) {
        return lent;
      }
    }
    return undefined;
  }
  for (const [transport, def] of defs) {
    if (def.declaredStates && def.common.states && STATES_VOCABULARY[transport] === STATES_VOCABULARY[owner]) {
      return {
        states: withReported(def.common.states, ownerDef.reportedValue),
        declared: true,
        liveLabels: def.liveLabels === true,
      };
    }
  }
  if (STATES_VOCABULARY[owner] !== "classic") {
    return undefined;
  }
  for (const [transport, def] of defs) {
    const translated =
      def.declaredStates && def.common.states && STATES_VOCABULARY[transport] === "musiccast"
        ? translateDeclaredStates(key, def.common.states)
        : undefined;
    if (translated) {
      const labelled = Object.fromEntries(
        Object.entries(translated).map(([value, word]) => [value, Object.hasOwn(own, value) ? own[value] : word]),
      );
      return {
        states: withReported(labelled, ownerDef.reportedValue),
        declared: true,
        liveLabels: ownerDef.liveLabels === true,
      };
    }
  }
  return undefined;
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
    // The owner's definition — with its own list and that list's label origin (`liveLabels`) — unless another
    // transport gives the datapoint a better list (see adoptedList).
    const resolvedDef: ObjectDef = { ...ownerDef, id: canonicalId };
    const adopted = adoptedList(entry.key, owner, ownerDef, entry.defs);
    if (adopted) {
      resolvedDef.common = { ...resolvedDef.common, states: adopted.states };
      if (adopted.declared) {
        resolvedDef.declaredStates = true;
      }
      if (adopted.liveLabels) {
        resolvedDef.liveLabels = true;
      } else {
        delete resolvedDef.liveLabels;
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

/** A datapoint's form: as a transport builds it, or as it stands in the tree (the owner wrote it there). */
export interface DatapointForm {
  /** The object type. */
  type: string;
  /** Its common part. */
  common: Partial<ObjectDef["common"]>;
}

/**
 * Whether two forms carry the same values: the same object type, value type and unit — the comparison
 * {@link canCarryWrite} and {@link keepsForm} share; each spelled it out by hand (review 2026-10-05, E). A decibel
 * bass (YNCA) is not MusicCast's step count, a sleep text is not a number.
 *
 * @param a one form
 * @param b the other
 * @returns whether a value of one means the same in the other
 */
function sameValues(a: DatapointForm, b: DatapointForm): boolean {
  return a.type === b.type && a.common.type === b.common.type && (a.common.unit ?? "") === (b.common.unit ?? "");
}

/**
 * Whether a datapoint's dropdown says something about its values. A switch is `true` or `false` over every
 * protocol, whatever words it is labelled with: XML labelled its switches with its description's `On`/`Standby`
 * (review 2026-10-05, A19), and a tree that still carries them must neither stop a write from falling back nor a
 * transport from taking the switch over.
 *
 * @param form the datapoint's form
 * @returns whether its value list matters
 */
function listedValues(form: DatapointForm): boolean {
  return form.common.type !== "boolean" && Boolean(form.common.states);
}

/**
 * Whether a user write meant for a datapoint's owner may be sent through another transport instead —
 * when the owner is offline or the device refused the command there (krobi 2026-10-02: "always try the
 * most modern one; if the command does not work with it, then the next one"). The ownership itself
 * does not move. Only where the value keeps its meaning: the same values ({@link sameValues}) and — where a
 * dropdown is involved — the same wire vocabulary: "HDMI1" is not "hdmi1". A transport that only reads the
 * datapoint cannot carry a write (`hdmi.out3`, `sound.surroundAI` on MusicCast — audit 2026-09-29, A27).
 *
 * @param from the owner and its form — as it built the datapoint, or as the datapoint stands in the tree
 * @param from.transport the owner
 * @param from.def its form
 * @param to the other transport and its definition
 * @param to.transport the other transport
 * @param to.def its definition
 * @returns whether the other transport can carry the write unchanged
 */
export function canCarryWrite(
  from: { transport: Transport; def: DatapointForm },
  to: { transport: Transport; def: ObjectDef },
): boolean {
  if (!sameValues(from.def, to.def) || !to.def.common.write) {
    return false;
  }
  const dropdown = listedValues(from.def) || listedValues(to.def);
  return !dropdown || STATES_VOCABULARY[from.transport] === STATES_VOCABULARY[to.transport];
}

/**
 * Whether a transport learned later may take a datapoint over: its definition must keep the form the
 * datapoint already has (2026-10-02 — a read-in receiver keeps its tree). The same values as
 * {@link canCarryWrite} judges, the write not lost, and the existing dropdown values all still there
 * (a device's list may grow, `HDMI1` is not `hdmi1`).
 *
 * @param existing the datapoint as it stands
 * @param live the definition a live transport builds now
 * @returns whether writing the live definition leaves the datapoint's form unchanged
 */
export function keepsForm(existing: DatapointForm, live: ObjectDef): boolean {
  if (!sameValues(existing, live) || (existing.common.write && !live.common.write)) {
    return false;
  }
  if (!listedValues(existing)) {
    return true;
  }
  const now = new Set(Object.keys(live.common.states ?? {}));
  return Object.keys(existing.common.states ?? {}).every(value => now.has(value));
}

import { ID_SCHEME } from "../device-id";

/**
 * Moving a device's object tree to a new id — the one-time step of the 3.0.0 id rule, for every
 * device an earlier version created under a name-derived id.
 *
 * ioBroker has no rename: an object that should live under another id is written there and the
 * old one deleted. What the user attached to the tree has to be carried by hand, or it is lost
 * with the old objects — and `delObject` also drops a state's value and every enum membership
 * (see `clearStaleBounds` in main.ts). Carried here:
 *
 * - every object (device, channels, states) with its whole `common` — the recording settings in
 *   `common.custom` included — and its `native`;
 * - every value, with its `ack`, `ts` and `lc`, so nothing reads as changed;
 * - the rooms and functions (enum members) the objects belonged to — NOT here: deleting the old tree
 *   removes its ids from every enum, written back from the adapter's enum cache, and would take an id
 *   written before it away again. The caller deletes through the fleet helper `moveWithEnums`
 *   (`enum-carry.ts`), which reads the memberships first, deletes, and writes the new ids last;
 *   {@link enumMembersUnder} names the ids it has to carry;
 * - aliases whose target lies in the tree (`alias.*`, `common.alias.id`);
 * - the continuity of recorded history: an enabled recording without an alias id of its own gets
 *   the OLD id as `aliasId` — influxdb, history and sql then store and query the series under the
 *   id it has always had.
 *
 * The OLD tree is deleted by the caller, after everything that points at the device (the device
 * table, the discovery store) was rewritten: until then the old device object carries
 * `native.movingTo` as a journal, and an interrupted move is completed on the next start.
 */

/** What a move reads and writes — the adapter's own object and state calls, injectable for tests. */
export interface DeviceMoveDeps {
  /** The adapter namespace (`yamaha.0`). */
  namespace: string;
  /** Every object under the instance, keyed by full id. */
  objects(): Promise<Record<string, ioBroker.Object | null | undefined>>;
  /** Every state below a full-id prefix (`yamaha.0.B_ro.*`). */
  states(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Write an object whole (full id). */
  setObject(id: string, obj: ioBroker.SettableObject): Promise<void>;
  /** Merge into an object (full id). */
  extendObject(id: string, patch: Partial<ioBroker.SettableObject>): Promise<void>;
  /** Write a state (full id). */
  setState(id: string, state: ioBroker.SettableState): Promise<void>;
  /** Every alias state object (`alias.*`). */
  aliases(): Promise<Record<string, ioBroker.Object | null | undefined>>;
  /** Write a foreign object whole. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<void>;
}

/** What one move carried over. */
export interface MoveReport {
  /** State objects written under the new id. */
  datapoints: number;
  /** Enum objects whose members were carried (filled in by the caller's delete). */
  enums: number;
  /** Alias objects whose target was rewritten. */
  aliases: number;
  /** Recordings that keep their series under the old id (`aliasId`). */
  history: number;
}

/**
 * The id an object has after the move, or undefined when it is not part of the moved tree.
 *
 * @param id a full object id
 * @param fromFull the old device id, namespace included
 * @param toFull the new device id, namespace included
 * @returns the moved id
 */
export function movedId(id: string, fromFull: string, toFull: string): string | undefined {
  if (id === fromFull) {
    return toFull;
  }
  return id.startsWith(`${fromFull}.`) ? `${toFull}${id.slice(fromFull.length)}` : undefined;
}

/**
 * A copy of one object as it is written under the new id: every field it carries, with the few
 * that name the old id rewritten.
 *
 * - the device object's reachability link (`common.statusStates.onlineId`);
 * - the ids the never-filled purge recorded in the capability profile (`pendingPurge`);
 * - a placeholder name: a device the adapter could not name yet carries its id as its name, and a
 *   copy that kept the OLD id there would read as a name the user gave (`nextDeviceLabel`) and stay
 *   for good;
 * - the move journal, which belongs to the old object only;
 * - a recording without an alias id of its own records on under the old id (see the module note).
 *
 * @param id the object's old full id
 * @param obj the object as read
 * @param from the old device id
 * @param to the new device id
 * @param namespace the adapter namespace
 * @returns the object to write, and whether a recording was pointed at the old id
 */
export function rewriteMovedObject(
  id: string,
  obj: ioBroker.Object,
  from: string,
  to: string,
  namespace: string,
): { object: ioBroker.SettableObject; history: number } {
  const fromFull = `${namespace}.${from}`;
  const toFull = `${namespace}.${to}`;
  const copy = JSON.parse(JSON.stringify({ type: obj.type, common: obj.common, native: obj.native ?? {} })) as {
    type: ioBroker.Object["type"];
    common: Record<string, unknown>;
    native: Record<string, unknown>;
  };
  let history = 0;
  if (id === fromFull) {
    delete copy.native.movingTo;
    const status = copy.common.statusStates as { onlineId?: unknown } | undefined;
    if (status && typeof status.onlineId === "string") {
      status.onlineId = movedId(status.onlineId, fromFull, toFull) ?? status.onlineId;
    }
    if (copy.common.name === from) {
      copy.common.name = to;
    }
    if (copy.native.label === from) {
      delete copy.native.label;
      delete copy.native.labelRank;
    }
    copy.native.capabilityProfile = movedProfile(copy.native.capabilityProfile, from, to);
  }
  const custom = copy.common.custom as Record<string, unknown> | undefined;
  if (obj.type === "state" && custom && typeof custom === "object") {
    for (const settings of Object.values(custom)) {
      if (settings && typeof settings === "object") {
        const entry = settings as { enabled?: unknown; aliasId?: unknown };
        if (entry.enabled && (typeof entry.aliasId !== "string" || entry.aliasId === "")) {
          entry.aliasId = id;
          history++;
        }
      }
    }
  }
  return { object: copy as unknown as ioBroker.SettableObject, history };
}

/**
 * The capability profile with the purge's recorded ids moved along — they are namespace-relative
 * ids with the device prefix, and a purge that looks for the old prefix finds nothing any more.
 *
 * @param stored the profile as stored (a JSON string)
 * @param from the old device id
 * @param to the new device id
 * @returns the profile to store
 */
function movedProfile(stored: unknown, from: string, to: string): unknown {
  if (typeof stored !== "string") {
    return stored;
  }
  try {
    const profile = JSON.parse(stored) as { pendingPurge?: unknown };
    if (!Array.isArray(profile.pendingPurge)) {
      return stored;
    }
    profile.pendingPurge = profile.pendingPurge.map(entry =>
      typeof entry === "string" && entry.startsWith(`${from}.`) ? `${to}${entry.slice(from.length)}` : entry,
    );
    return JSON.stringify(profile);
  } catch {
    return stored;
  }
}

/**
 * An alias target with the moved tree followed — a plain id, or the read/write pair.
 *
 * @param target `common.alias.id` as stored
 * @param fromFull the old device id, namespace included
 * @param toFull the new device id, namespace included
 * @returns the new target, or undefined when it does not point into the moved tree
 */
export function movedAliasTarget(target: unknown, fromFull: string, toFull: string): unknown {
  if (typeof target === "string") {
    return movedId(target, fromFull, toFull);
  }
  if (target && typeof target === "object") {
    const pair = target as { read?: unknown; write?: unknown };
    const read = typeof pair.read === "string" ? movedId(pair.read, fromFull, toFull) : undefined;
    const write = typeof pair.write === "string" ? movedId(pair.write, fromFull, toFull) : undefined;
    if (read === undefined && write === undefined) {
      return undefined;
    }
    return { ...pair, ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}) };
  }
  return undefined;
}

/**
 * The ids of the moved tree that some room or function lists — what the delete of the old tree has
 * to carry to the new id.
 *
 * @param enums the enum objects, as `getForeignObjectsAsync("enum.*", "enum")` returns them
 * @param fromFull the old device id, namespace included
 * @returns the old full ids, sorted
 */
export function enumMembersUnder(enums: Record<string, unknown> | null | undefined, fromFull: string): string[] {
  const ids = new Set<string>();
  for (const obj of Object.values(enums ?? {})) {
    const members = (obj as { common?: { members?: unknown } } | null)?.common?.members;
    if (Array.isArray(members)) {
      for (const member of members) {
        if (typeof member === "string" && (member === fromFull || member.startsWith(`${fromFull}.`))) {
          ids.add(member);
        }
      }
    }
  }
  return [...ids].sort();
}

/**
 * Copy a device's tree to its new id and point everything that referred to it there — objects,
 * values, alias targets (the enum members follow at the delete, see the module note). The old tree stays (see the module note). Repeatable: every
 * write replaces, so an interrupted copy is simply done again; the new device object is marked
 * final (`native.idScheme`) only after everything below it is written, so a device object with the
 * mark is a complete copy.
 *
 * @param deps the object and state calls
 * @param from the old device id
 * @param to the new device id
 * @returns what was carried over
 */
export async function copyDeviceTree(deps: DeviceMoveDeps, from: string, to: string): Promise<MoveReport> {
  const fromFull = `${deps.namespace}.${from}`;
  const toFull = `${deps.namespace}.${to}`;
  const report: MoveReport = { datapoints: 0, enums: 0, aliases: 0, history: 0 };
  const all = await deps.objects();
  const target = all[toFull];
  const complete = (target?.native as { idScheme?: unknown } | undefined)?.idScheme === ID_SCHEME;
  if (!complete) {
    // Shallow first, the device object itself LAST: its mark says the copy is whole.
    const tree = Object.entries(all)
      .filter(([id, obj]) => obj && movedId(id, fromFull, toFull) !== undefined)
      .sort(([a], [b]) => a.length - b.length);
    let deviceObject: ioBroker.SettableObject | undefined;
    for (const [id, obj] of tree) {
      const { object, history } = rewriteMovedObject(id, obj!, from, to, deps.namespace);
      report.history += history;
      if (id === fromFull) {
        deviceObject = object;
        continue;
      }
      await deps.setObject(movedId(id, fromFull, toFull)!, object);
      if (obj!.type === "state") {
        report.datapoints++;
      }
    }
    if (deviceObject) {
      await deps.setObject(toFull, deviceObject);
    }
    const states = await deps.states(`${fromFull}.*`);
    for (const [id, state] of Object.entries(states)) {
      const next = movedId(id, fromFull, toFull);
      if (!next || !state || state.val === undefined) {
        continue;
      }
      await deps.setState(next, {
        val: state.val,
        ack: state.ack,
        ...(typeof state.ts === "number" ? { ts: state.ts } : {}),
        ...(typeof state.lc === "number" ? { lc: state.lc } : {}),
        ...(typeof state.q === "number" ? { q: state.q } : {}),
      });
    }
  }
  for (const [id, obj] of Object.entries(await deps.aliases())) {
    const alias = (obj?.common as { alias?: { id?: unknown } } | undefined)?.alias;
    if (!obj || !alias) {
      continue;
    }
    const moved = movedAliasTarget(alias.id, fromFull, toFull);
    if (moved === undefined) {
      continue;
    }
    await deps.setForeignObject(id, {
      ...obj,
      common: { ...obj.common, alias: { ...alias, id: moved } },
    } as unknown as ioBroker.SettableObject);
    report.aliases++;
  }
  // The mark goes on last — only a whole copy may skip the copy on a repeated run.
  if (!complete) {
    await deps.extendObject(toFull, { native: { idScheme: ID_SCHEME } });
  }
  return report;
}

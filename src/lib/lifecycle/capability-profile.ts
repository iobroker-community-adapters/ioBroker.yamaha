import { identityFrom, mergeIdentity, type DeviceIdentity } from "../device-identity";
import { DISCOVERY_SCHEMA } from "./discovery-schema";
import { emptyLearnedTree, hasLearned, parseLearnedTree, type LearnedTree } from "./learned-tree";
import { memorySchemaOf, ProbeMemory, SCHEMA_KEY } from "./probe-memory";
import {
  createSubunitCache,
  isAvailSnapshot,
  type YncaAvailSnapshot,
  type YncaSubunitCache,
} from "../ynca/subunit-cache";
import { MEMORY_KEY } from "./memory-keys";

/** The device object's native key the profile lives under — a JSON STRING (see {@link serializeCapabilityProfile}). */
export const PROFILE_KEY = "capabilityProfile";

/**
 * The three keys the profile replaces (releases before 2.7.0: `probeCache` JSON string, `yncaAvail` object,
 * `purgeVersion` string). Read once by {@link loadCapabilityProfile} and deleted on the first
 * persist, so a device object does not carry both shapes forever.
 */
export const LEGACY_PROFILE_KEYS = ["probeCache", "yncaAvail", "purgeVersion"] as const;

/** What each transport reads as the device's identity, derived from the memory entries at persist time. */
export interface ProfileIdentity {
  /** YNCA: `SYS:MODELNAME` + `SYS:VERSION`. */
  ynca?: { model: string; firmware: string };
  /** MusicCast: `getDeviceInfo` model name + `system_version`, plus `system_id`/`device_id` when reported. */
  yxc?: { model: string; systemVersion: string; serial?: string; mac?: string };
  /** XML: `System>Config` model + `System_ID` + firmware version. */
  xml?: { model: string; systemId: string; version: string };
}

/** The parts the adapter holds per device and hands to {@link serializeCapabilityProfile}. */
export interface ProfileParts {
  /** The ProbeMemory entries (with or without the memory's own schema marker — it is not stored twice). */
  memory: Record<string, unknown>;
  /** The YNCA AVAIL snapshot, if any (its schema is the profile's). */
  yncaAvail?: Omit<YncaAvailSnapshot, "schema">;
  /** Which transport serves and owns which datapoint (see {@link LearnedTree}). */
  tree?: LearnedTree;
}

/** What loading a device object's native part yields — the guards of the two memories stay downstream. */
export interface LoadedProfile {
  /** ProbeMemory's initial entries, `__schema` carried as stored (0 = a 2.5.2 memory), or undefined. */
  memory: Record<string, unknown> | undefined;
  /** The AVAIL snapshot in the CURRENT schema, or undefined (another schema, another shape, none). */
  yncaAvail: YncaAvailSnapshot | undefined;
  /** The learned ownership as stored — the store keeps it only under the current discovery schema. */
  tree: LearnedTree;
  /** When the profile was first learned under its schema (kept across persists). */
  learnedAt: string | undefined;
  /** The schema the stored memory was learned under (for the re-learn log line); undefined = no memory. */
  storedSchema: number | undefined;
  /** True when any legacy key is present — the first persist deletes them. */
  legacy: boolean;
}

/**
 * One capability profile per device, replacing the three stores of 2.5.2/2.6.0 — the plan's
 * Task 14. Stored as a JSON STRING under `native.capabilityProfile` because `extendObject`
 * merges nested objects key by key (a dropped memory entry would rise from the dead) while a
 * string replaces. Nothing here decides validity: `ProbeMemory` discards a memory of another
 * discovery schema, `isAvailSnapshot` a snapshot of another schema, the controllers a memory of
 * another device identity — exactly as before the profile existed, so the migration re-probes
 * nothing and a device that is OFF during the update keeps its fast path.
 *
 * @param native the device object's native part (untrusted storage)
 * @returns the loaded parts
 */
export function loadCapabilityProfile(native: Record<string, unknown> | undefined): LoadedProfile {
  const legacy = LEGACY_PROFILE_KEYS.some(key => native?.[key] !== undefined && native?.[key] !== null);
  const profile = parseProfile(native?.[PROFILE_KEY]);
  if (profile) {
    const memory = { [SCHEMA_KEY]: profile.schema, ...profile.memory };
    const snapshot = profile.yncaAvail ? { schema: profile.schema, ...profile.yncaAvail } : undefined;
    return {
      memory,
      yncaAvail: isAvailSnapshot(snapshot) ? snapshot : undefined,
      tree: profile.tree,
      learnedAt: profile.learnedAt,
      storedSchema: profile.schema,
      legacy,
    };
  }
  const memory = parseLegacyMemory(native?.probeCache);
  const avail = native?.yncaAvail;
  return {
    memory,
    yncaAvail: isAvailSnapshot(avail) ? avail : undefined,
    tree: emptyLearnedTree(),
    learnedAt: undefined,
    storedSchema: memory ? memorySchemaOf(memory) : undefined,
    legacy,
  };
}

/**
 * The profile as the adapter writes it: the current discovery schema, provenance (adapter
 * version, first learned), the derived identity, and the parts. `adapterVersion` is provenance
 * only — the adapter version never invalidates a memory (advisor round 2026-09-09).
 *
 * @param parts the per-device parts
 * @param provenance what to record about the writer
 * @param provenance.adapterVersion the adapter version writing the profile
 * @param provenance.learnedAt when the profile was first learned under its schema (ISO time)
 * @returns the JSON string for `native.capabilityProfile`
 */
export function serializeCapabilityProfile(
  parts: ProfileParts,
  provenance: { adapterVersion: string; learnedAt: string },
): string {
  const memory: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parts.memory)) {
    if (key !== SCHEMA_KEY) {
      memory[key] = value;
    }
  }
  return JSON.stringify({
    schema: DISCOVERY_SCHEMA,
    adapterVersion: provenance.adapterVersion,
    learnedAt: provenance.learnedAt,
    identity: profileIdentityOf(memory),
    memory,
    ...(parts.yncaAvail ? { yncaAvail: parts.yncaAvail } : {}),
    ...(parts.tree && hasLearned(parts.tree) ? { tree: parts.tree } : {}),
  });
}

/**
 * The identity each transport validated its memory portion against, read out of the entries the
 * controllers keep: YNCA `yncaCapabilities.model/firmware`, MusicCast `yxcIdentity`
 * ("model|system_version"), XML `xmlIdentity` ("model|systemId|version"). Diagnostic — the
 * controllers keep their own guards.
 *
 * @param memory the memory entries
 * @returns the identity halves that are known
 */
export function profileIdentityOf(memory: Record<string, unknown>): ProfileIdentity {
  const identity: ProfileIdentity = {};
  const caps = memory[MEMORY_KEY.yncaCapabilities] as { model?: unknown; firmware?: unknown } | undefined;
  if (typeof caps === "object" && caps !== null && typeof caps.model === "string") {
    identity.ynca = { model: caps.model, firmware: typeof caps.firmware === "string" ? caps.firmware : "" };
  }
  const ids = memory[MEMORY_KEY.yxcDeviceIds] as { serial?: unknown; mac?: unknown } | undefined;
  const serial = typeof ids === "object" && ids !== null && typeof ids.serial === "string" ? ids.serial : undefined;
  const mac = typeof ids === "object" && ids !== null && typeof ids.mac === "string" ? ids.mac : undefined;
  const yxcIdentity = memory[MEMORY_KEY.yxcIdentity];
  if (typeof yxcIdentity === "string" || serial !== undefined || mac !== undefined) {
    const [model = "", systemVersion = ""] = typeof yxcIdentity === "string" ? yxcIdentity.split("|") : ["", ""];
    identity.yxc = {
      model,
      systemVersion,
      ...(serial !== undefined ? { serial } : {}),
      ...(mac !== undefined ? { mac } : {}),
    };
  }
  const xmlIdentity = memory[MEMORY_KEY.xmlIdentity];
  if (typeof xmlIdentity === "string") {
    const [model = "", systemId = "", version = ""] = xmlIdentity.split("|");
    identity.xml = { model, systemId, version };
  }
  return identity;
}

interface StoredProfile {
  schema: number;
  learnedAt: string | undefined;
  memory: Record<string, unknown>;
  yncaAvail: Omit<YncaAvailSnapshot, "schema"> | undefined;
  tree: LearnedTree;
}

function parseProfile(raw: unknown): StoredProfile | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || typeof parsed.schema !== "number" || !isPlainObject(parsed.memory)) {
    return undefined;
  }
  const avail = parsed.yncaAvail;
  return {
    schema: parsed.schema,
    learnedAt: typeof parsed.learnedAt === "string" ? parsed.learnedAt : undefined,
    memory: parsed.memory,
    yncaAvail: isPlainObject(avail) ? (avail as unknown as Omit<YncaAvailSnapshot, "schema">) : undefined,
    tree: parseLearnedTree(parsed.tree),
  };
}

function parseLegacyMemory(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the adapter hands a {@link DeviceProfileStore}. */
export interface DeviceProfileDeps {
  /** The running adapter version — recorded as provenance, never used to invalidate. */
  adapterVersion: string;
  /** The current time as an ISO string (for `learnedAt`). */
  now: () => string;
  /** Write a native patch to the device object (the adapter coalesces these). */
  persist: (patch: Record<string, unknown>) => void;
  /** Debug log — the re-learn line when the stored schema differs from the current one. */
  log?: (message: string) => void;
}

/**
 * The model a device remembers — the one resolver (audit 2026-09-29, A29): the transports' identities
 * in the profile (the same name on all three, any half will do; an empty half does not stop the
 * search), else `native.model`, which sits beside the profile and outlives a discovery-schema bump.
 * Two resolvers stood side by side, one stopping at an empty MusicCast model the other skipped.
 *
 * @param memory the profile's probe memory
 * @param nativeModel the device object's `native.model` (untrusted)
 * @returns the model name, or undefined
 */
export function modelFrom(memory: Record<string, unknown>, nativeModel: unknown): string | undefined {
  const identity = profileIdentityOf(memory);
  const stored = typeof nativeModel === "string" && nativeModel.length > 0 ? nativeModel : undefined;
  return identity.ynca?.model || identity.yxc?.model || identity.xml?.model || stored;
}

/**
 * The identity the transports left in a profile's memory — XML `System_ID` and MusicCast `system_id`
 * are the same serial (measured on the RX-V6A), `device_id` is the MAC. Each source is judged on its
 * own: a scrubbed XML System_ID ("00000000") used to win the `||` and hide MusicCast's valid serial
 * (audit 2026-09-24, A10).
 *
 * @param memory the profile's probe memory
 * @returns the identity, or undefined
 */
function identityOfMemory(memory: Record<string, unknown>): DeviceIdentity | undefined {
  const identity = profileIdentityOf(memory);
  const serial = identityFrom({ serial: identity.xml?.systemId })?.serial ?? identity.yxc?.serial;
  return identityFrom({ serial, mac: identity.yxc?.mac });
}

/**
 * Everything a device object says about the device's identity: its own `native.identity`, the
 * profile's (only a profile of the current discovery schema), and — where there is one — a record's.
 * One function for the move decision and the device card (audit 2026-09-29, A30); both built a
 * throwaway profile store for it.
 *
 * @param native the device object's native part (untrusted)
 * @param record an identity known besides (the discovery record)
 * @returns the merged identity, or undefined
 */
export function identityOfDeviceObject(
  native: Record<string, unknown> | undefined,
  record?: DeviceIdentity,
): DeviceIdentity | undefined {
  const stored =
    typeof native?.identity === "object" && native.identity !== null ? identityFrom(native.identity) : undefined;
  const loaded = loadCapabilityProfile(native);
  const kept = loaded.memory !== undefined && memorySchemaOf(loaded.memory) === DISCOVERY_SCHEMA;
  const profile = kept ? identityOfMemory(withoutSchema(loaded.memory!)) : undefined;
  return mergeIdentity(mergeIdentity(record, stored), profile);
}

/**
 * One device's capability profile, held by the adapter across reconnect attempts (the
 * controllers are rebuilt per attempt): the {@link ProbeMemory} and the YNCA subunit cache
 * persist through it into ONE JSON string, together with the learned tree (who serves which
 * datapoint). Legacy keys found at load are converted at once — one
 * patch with the profile and the three deletions — so the migration needs no device traffic and
 * the object never carries both shapes.
 */
export class DeviceProfileStore {
  /** The per-device memory of constant device answers. */
  public readonly probeMemory: ProbeMemory;
  /** The per-device cache of the YNCA AVAIL probe. */
  public readonly subunitCache: YncaSubunitCache;
  private memory: Record<string, unknown>;
  private yncaAvail: Omit<YncaAvailSnapshot, "schema"> | undefined;
  private learnedTree: LearnedTree;
  private readonly learnedAt: string;
  private legacy: boolean;
  /** The device object's `native.model` — the model beside the profile (see {@link modelFrom}). */
  private nativeModel: unknown;

  /**
   * @param deviceId the id-safe device id (for the log line)
   * @param native the device object's native part as stored (untrusted)
   * @param deps the adapter callbacks
   */
  public constructor(
    deviceId: string,
    native: Record<string, unknown> | undefined,
    private readonly deps: DeviceProfileDeps,
  ) {
    const loaded = loadCapabilityProfile(native);
    this.nativeModel = native?.model;
    const kept = loaded.memory !== undefined && memorySchemaOf(loaded.memory) === DISCOVERY_SCHEMA;
    if (loaded.storedSchema !== undefined && !kept) {
      deps.log?.(
        `${deviceId}: discovery logic changed (schema ${loaded.storedSchema} → ${DISCOVERY_SCHEMA}) — re-learning the device`,
      );
    }
    this.memory = kept ? withoutSchema(loaded.memory!) : {};
    this.learnedAt = kept && loaded.learnedAt ? loaded.learnedAt : deps.now();
    this.yncaAvail = loaded.yncaAvail ? withoutSnapshotSchema(loaded.yncaAvail) : undefined;
    this.learnedTree = kept ? loaded.tree : emptyLearnedTree();
    this.legacy = loaded.legacy;
    this.probeMemory = new ProbeMemory(loaded.memory, entries => {
      this.memory = withoutSchema(entries);
      this.persistNow();
    });
    this.subunitCache = createSubunitCache(loaded.yncaAvail, snapshot => {
      this.yncaAvail = snapshot ? withoutSnapshotSchema(snapshot) : undefined;
      this.persistNow();
    });
    if (this.legacy) {
      this.persistNow();
    }
  }

  /** Which transport serves and owns which datapoint of this device (see {@link LearnedTree}). */
  public get tree(): LearnedTree {
    return this.learnedTree;
  }

  /**
   * Keep a new learned tree — written with the rest of the profile, through the coalescing persist.
   *
   * @param tree the tree as the device handle learned it
   */
  public setTree(tree: LearnedTree): void {
    this.learnedTree = tree;
    this.persistNow();
  }

  /**
   * The model the transports reported — the same name on all three, so any half will do.
   *
   * @returns the model name, or undefined while no transport ever answered
   */
  public model(): string | undefined {
    return modelFrom(this.memory, this.nativeModel);
  }

  /**
   * Take the model the device just reported (kept as `native.model` beside the profile).
   *
   * @param model the reported model name
   * @returns true when it differs from the one remembered
   */
  public noteModel(model: string): boolean {
    if (this.nativeModel === model) {
      return false;
    }
    this.nativeModel = model;
    return true;
  }

  /**
   * The device's identity as the transports learned it — XML `System_ID` and MusicCast
   * `system_id` are the same serial (measured on the RX-V6A), `device_id` is the MAC. Undefined
   * until a transport reported one, and for a scrubbed value (see `identityFrom`).
   *
   * @returns the identity, or undefined
   */
  public identity(): DeviceIdentity | undefined {
    return identityOfMemory(this.memory);
  }

  /** Write the profile now (through the adapter's coalescing persist). */
  public persistNow(): void {
    const patch: Record<string, unknown> = {
      [PROFILE_KEY]: serializeCapabilityProfile(
        {
          memory: this.memory,
          yncaAvail: this.yncaAvail,
          tree: this.learnedTree,
        },
        { adapterVersion: this.deps.adapterVersion, learnedAt: this.learnedAt },
      ),
    };
    if (this.legacy) {
      // `null` deletes a native key on extendObject — the same way a stale description is removed.
      for (const key of LEGACY_PROFILE_KEYS) {
        patch[key] = null;
      }
      this.legacy = false;
    }
    this.deps.persist(patch);
  }
}

function withoutSchema(memory: Record<string, unknown>): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(memory)) {
    if (key !== SCHEMA_KEY) {
      entries[key] = value;
    }
  }
  return entries;
}

/**
 * The YNCA snapshot as the profile keeps it — the schema lives on the profile. Every other field
 * rides along: `probed` was dropped here from 2.13.0 on, so after every restart no source counted
 * as asked, none could be judged absent, and a YNCA receiver's input dropdown offered the whole
 * source catalog again (#619 back through the restart — found by the 3.0.0 upgrade suite, the
 * first run that starts the adapter twice).
 *
 * @param snapshot the snapshot with its schema
 * @returns the snapshot without it
 */
function withoutSnapshotSchema(snapshot: YncaAvailSnapshot): Omit<YncaAvailSnapshot, "schema"> {
  return {
    subunits: snapshot.subunits,
    ...(snapshot.probed ? { probed: snapshot.probed } : {}),
    model: snapshot.model,
    firmware: snapshot.firmware,
  };
}

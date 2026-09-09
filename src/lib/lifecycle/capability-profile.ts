import { DISCOVERY_SCHEMA } from "./discovery-schema";
import { memorySchemaOf, ProbeMemory, SCHEMA_KEY } from "./probe-memory";
import {
  createSubunitCache,
  isAvailSnapshot,
  type YncaAvailSnapshot,
  type YncaSubunitCache,
} from "../ynca/subunit-cache";

/** The device object's native key the profile lives under — a JSON STRING (see {@link serializeCapabilityProfile}). */
export const PROFILE_KEY = "capabilityProfile";

/**
 * The three keys the profile replaces (2.5.2/2.6.0: `probeCache` JSON string, `yncaAvail` object,
 * `purgeVersion` string). Read once by {@link loadCapabilityProfile} and deleted on the first
 * persist, so a device object does not carry both shapes forever.
 */
export const LEGACY_PROFILE_KEYS = ["probeCache", "yncaAvail", "purgeVersion"] as const;

/** What each transport reads as the device's identity, derived from the memory entries at persist time. */
export interface ProfileIdentity {
  /** YNCA: `SYS:MODELNAME` + `SYS:VERSION`. */
  ynca?: { model: string; firmware: string };
  /** MusicCast: `getDeviceInfo` model name + `system_version`. */
  yxc?: { model: string; systemVersion: string };
  /** XML: `System>Config` model + `System_ID` + firmware version. */
  xml?: { model: string; systemId: string; version: string };
}

/** The parts the adapter holds per device and hands to {@link serializeCapabilityProfile}. */
export interface ProfileParts {
  /** The ProbeMemory entries (with or without the memory's own schema marker — it is not stored twice). */
  memory: Record<string, unknown>;
  /** The YNCA AVAIL snapshot, if any (its schema is the profile's). */
  yncaAvail?: Omit<YncaAvailSnapshot, "schema">;
  /** The adapter version whose never-filled purge ran for this device. */
  purgeVersion?: string;
  /** Never-filled datapoints seen missing once — deleted when still missing on the next start. */
  pendingPurge: string[];
}

/** What loading a device object's native part yields — the guards of the two memories stay downstream. */
export interface LoadedProfile {
  /** ProbeMemory's initial entries, `__schema` carried as stored (0 = a 2.5.2 memory), or undefined. */
  memory: Record<string, unknown> | undefined;
  /** The AVAIL snapshot in the CURRENT schema, or undefined (another schema, another shape, none). */
  yncaAvail: YncaAvailSnapshot | undefined;
  /** The adapter version whose never-filled purge ran for this device, if any. */
  purgeVersion: string | undefined;
  /** Never-filled datapoints seen missing once (see {@link ProfileParts.pendingPurge}). */
  pendingPurge: string[];
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
      purgeVersion: profile.purgeVersion,
      pendingPurge: profile.pendingPurge,
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
    purgeVersion: typeof native?.purgeVersion === "string" ? native.purgeVersion : undefined,
    pendingPurge: [],
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
    ...(parts.purgeVersion !== undefined ? { purgeVersion: parts.purgeVersion } : {}),
    ...(parts.pendingPurge.length > 0 ? { pendingPurge: parts.pendingPurge } : {}),
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
  const caps = memory.yncaCapabilities as { model?: unknown; firmware?: unknown } | undefined;
  if (typeof caps === "object" && caps !== null && typeof caps.model === "string") {
    identity.ynca = { model: caps.model, firmware: typeof caps.firmware === "string" ? caps.firmware : "" };
  }
  if (typeof memory.yxcIdentity === "string") {
    const [model = "", systemVersion = ""] = memory.yxcIdentity.split("|");
    identity.yxc = { model, systemVersion };
  }
  if (typeof memory.xmlIdentity === "string") {
    const [model = "", systemId = "", version = ""] = memory.xmlIdentity.split("|");
    identity.xml = { model, systemId, version };
  }
  return identity;
}

interface StoredProfile {
  schema: number;
  learnedAt: string | undefined;
  memory: Record<string, unknown>;
  yncaAvail: Omit<YncaAvailSnapshot, "schema"> | undefined;
  purgeVersion: string | undefined;
  pendingPurge: string[];
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
    purgeVersion: typeof parsed.purgeVersion === "string" ? parsed.purgeVersion : undefined,
    pendingPurge: Array.isArray(parsed.pendingPurge)
      ? parsed.pendingPurge.filter((id): id is string => typeof id === "string")
      : [],
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
 * One device's capability profile, held by the adapter across reconnect attempts (the
 * controllers are rebuilt per attempt): the {@link ProbeMemory} and the YNCA subunit cache
 * persist through it into ONE JSON string, together with the never-filled purge marker and the
 * ids awaiting their purge confirmation. Legacy keys found at load are converted at once — one
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
  private purgeVersionValue: string | undefined;
  private pending: string[];
  private readonly learnedAt: string;
  private legacy: boolean;

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
    const kept = loaded.memory !== undefined && memorySchemaOf(loaded.memory) === DISCOVERY_SCHEMA;
    if (loaded.storedSchema !== undefined && !kept) {
      deps.log?.(
        `${deviceId}: discovery logic changed (schema ${loaded.storedSchema} → ${DISCOVERY_SCHEMA}) — re-learning the device`,
      );
    }
    this.memory = kept ? withoutSchema(loaded.memory!) : {};
    this.learnedAt = kept && loaded.learnedAt ? loaded.learnedAt : deps.now();
    this.yncaAvail = loaded.yncaAvail ? withoutSnapshotSchema(loaded.yncaAvail) : undefined;
    this.purgeVersionValue = loaded.purgeVersion;
    this.pending = loaded.pendingPurge;
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

  /** The adapter version whose never-filled purge ran for this device, if any. */
  public get purgeVersion(): string | undefined {
    return this.purgeVersionValue;
  }

  /**
   * Record that the never-filled purge ran under a version.
   *
   * @param version the adapter version
   */
  public markPurged(version: string): void {
    this.purgeVersionValue = version;
    this.persistNow();
  }

  /** Never-filled datapoints seen missing once — candidates for the next start's confirmation. */
  public get pendingPurge(): readonly string[] {
    return this.pending;
  }

  /**
   * Replace the pending-purge list.
   *
   * @param ids the datapoint ids (namespace-relative)
   */
  public setPendingPurge(ids: readonly string[]): void {
    this.pending = [...ids];
    this.persistNow();
  }

  /** Write the profile now (through the adapter's coalescing persist). */
  public persistNow(): void {
    const patch: Record<string, unknown> = {
      [PROFILE_KEY]: serializeCapabilityProfile(
        {
          memory: this.memory,
          yncaAvail: this.yncaAvail,
          purgeVersion: this.purgeVersionValue,
          pendingPurge: this.pending,
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

function withoutSnapshotSchema(snapshot: YncaAvailSnapshot): Omit<YncaAvailSnapshot, "schema"> {
  return { subunits: snapshot.subunits, model: snapshot.model, firmware: snapshot.firmware };
}

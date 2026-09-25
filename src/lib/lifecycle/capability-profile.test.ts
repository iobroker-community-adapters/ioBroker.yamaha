import {
  DeviceProfileStore,
  LEGACY_PROFILE_KEYS,
  loadCapabilityProfile,
  PROFILE_KEY,
  profileIdentityOf,
  serializeCapabilityProfile,
  type DeviceProfileDeps,
} from "./capability-profile";
import { DISCOVERY_SCHEMA } from "./discovery-schema";

const caps = { model: "RX-V473", firmware: "1.60/2.02", subunits: { MAIN: { PWR: "On" } } };
const avail = { schema: DISCOVERY_SCHEMA, subunits: ["MAIN", "TUN"], model: "RX-V473", firmware: "1.60/2.02" };

describe("capability profile — loading", () => {
  test("migrates the three legacy keys into one profile with the same content", () => {
    const memory = { __schema: DISCOVERY_SCHEMA, yncaCapabilities: caps, xmlIdentity: "RX-V473|0A1B|1.60" };
    const loaded = loadCapabilityProfile({
      probeCache: JSON.stringify(memory),
      yncaAvail: avail,
      purgeVersion: "2.6.0",
    });
    expect(loaded.memory).toEqual(memory);
    expect(loaded.yncaAvail).toEqual(avail);
    expect(loaded.purgeVersion).toBe("2.6.0");
    expect(loaded.pendingPurge).toEqual([]);
    expect(loaded.legacy).toBe(true);
    expect(loaded.storedSchema).toBe(DISCOVERY_SCHEMA);
  });

  test("a 2.5.2 memory without a schema is handed over verbatim — the schema guards stay where they are", () => {
    const memory = { yncaCapabilities: caps };
    const loaded = loadCapabilityProfile({
      probeCache: JSON.stringify(memory),
      yncaAvail: { subunits: ["MAIN"], model: "RX-V473", firmware: "1.60/2.02" },
      purgeVersion: "2.5.2",
    });
    expect(loaded.memory).toEqual(memory);
    expect(loaded.storedSchema).toBe(0);
    // The snapshot carries no schema — the same guard that rejected it in 2.6.0 rejects it here.
    expect(loaded.yncaAvail).toBeUndefined();
    expect(loaded.purgeVersion).toBe("2.5.2");
    expect(loaded.legacy).toBe(true);
  });

  test("reads a stored profile back, schema re-attached to both memory halves", () => {
    const stored = serializeCapabilityProfile(
      {
        memory: { yncaCapabilities: caps, yxcIdentity: "RX-V473|1.60" },
        yncaAvail: { subunits: ["MAIN", "TUN"], model: "RX-V473", firmware: "1.60/2.02" },
        purgeVersion: "2.7.0",
        pendingPurge: ["multiroom.zone2.sound.balance"],
      },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-09T10:00:00.000Z" },
    );
    const loaded = loadCapabilityProfile({ [PROFILE_KEY]: stored });
    expect(loaded.memory).toEqual({ __schema: DISCOVERY_SCHEMA, yncaCapabilities: caps, yxcIdentity: "RX-V473|1.60" });
    expect(loaded.yncaAvail).toEqual(avail);
    expect(loaded.purgeVersion).toBe("2.7.0");
    expect(loaded.pendingPurge).toEqual(["multiroom.zone2.sound.balance"]);
    expect(loaded.learnedAt).toBe("2026-09-09T10:00:00.000Z");
    expect(loaded.legacy).toBe(false);
    expect(loaded.storedSchema).toBe(DISCOVERY_SCHEMA);
  });

  test("the profile wins over leftover legacy keys, which are still marked for deletion", () => {
    const stored = serializeCapabilityProfile(
      { memory: { yncaCapabilities: caps }, purgeVersion: "2.7.0", pendingPurge: [] },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-09T10:00:00.000Z" },
    );
    const loaded = loadCapabilityProfile({
      [PROFILE_KEY]: stored,
      probeCache: JSON.stringify({ __schema: DISCOVERY_SCHEMA, stale: true }),
      purgeVersion: "2.6.0",
    });
    expect(loaded.memory).toEqual({ __schema: DISCOVERY_SCHEMA, yncaCapabilities: caps });
    expect(loaded.purgeVersion).toBe("2.7.0");
    expect(loaded.legacy).toBe(true);
  });

  test("a profile of another schema hands its memory over with that schema — the guards discard it", () => {
    const stored = JSON.stringify({
      schema: DISCOVERY_SCHEMA + 1,
      adapterVersion: "9.9.9",
      learnedAt: "2030-01-01T00:00:00.000Z",
      identity: {},
      memory: { yncaCapabilities: caps },
      yncaAvail: { subunits: ["MAIN"], model: "RX-V473", firmware: "1.60/2.02" },
      purgeVersion: "9.9.9",
    });
    const loaded = loadCapabilityProfile({ [PROFILE_KEY]: stored });
    expect(loaded.memory?.__schema).toBe(DISCOVERY_SCHEMA + 1);
    expect(loaded.storedSchema).toBe(DISCOVERY_SCHEMA + 1);
    expect(loaded.yncaAvail).toBeUndefined();
    expect(loaded.purgeVersion).toBe("9.9.9");
  });

  test("garbage never throws and loads as an empty profile", () => {
    for (const native of [
      undefined,
      {},
      { [PROFILE_KEY]: 42 },
      { [PROFILE_KEY]: "{not json" },
      { [PROFILE_KEY]: "[1,2]" },
      { [PROFILE_KEY]: JSON.stringify({ schema: "x", memory: "no" }) },
      { probeCache: "[]", yncaAvail: "nope", purgeVersion: 7 },
    ]) {
      const loaded = loadCapabilityProfile(native);
      expect(loaded.memory).toBeUndefined();
      expect(loaded.yncaAvail).toBeUndefined();
      expect(loaded.purgeVersion).toBeUndefined();
      expect(loaded.pendingPurge).toEqual([]);
    }
    expect(loadCapabilityProfile({ probeCache: "[]" }).legacy).toBe(true);
    expect(loadCapabilityProfile({ [PROFILE_KEY]: "{not json" }).legacy).toBe(false);
  });
});

describe("capability profile — serializing", () => {
  test("is one JSON string (extendObject replaces a string, but merges a nested object)", () => {
    const stored = serializeCapabilityProfile(
      { memory: { yncaCapabilities: caps }, purgeVersion: "2.7.0", pendingPurge: [] },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-09T10:00:00.000Z" },
    );
    expect(typeof stored).toBe("string");
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    expect(parsed.schema).toBe(DISCOVERY_SCHEMA);
    expect(parsed.adapterVersion).toBe("2.7.0");
    expect(parsed.learnedAt).toBe("2026-09-09T10:00:00.000Z");
    expect(parsed.identity).toEqual({ ynca: { model: "RX-V473", firmware: "1.60/2.02" } });
    // The memory's own schema marker is not stored twice.
    expect((parsed.memory as Record<string, unknown>).__schema).toBeUndefined();
  });

  test("the identity is derived from the three transports' memory entries", () => {
    expect(
      profileIdentityOf({
        yncaCapabilities: caps,
        yxcIdentity: "RX-V6A|1.8",
        xmlIdentity: "RX-V6A|0123ABCD|1.80/3.14",
      }),
    ).toEqual({
      ynca: { model: "RX-V473", firmware: "1.60/2.02" },
      yxc: { model: "RX-V6A", systemVersion: "1.8" },
      xml: { model: "RX-V6A", systemId: "0123ABCD", version: "1.80/3.14" },
    });
    expect(profileIdentityOf({})).toEqual({});
    expect(profileIdentityOf({ yncaCapabilities: "junk", yxcIdentity: 5, xmlIdentity: "onlymodel" })).toEqual({
      xml: { model: "onlymodel", systemId: "", version: "" },
    });
  });

  test("the MusicCast device ids ride along in the yxc half when the memory carries them", () => {
    expect(
      profileIdentityOf({ yxcIdentity: "WX-030|2.1", yxcDeviceIds: { serial: "0E897553", mac: "00A0DED4F504" } }),
    ).toEqual({ yxc: { model: "WX-030", systemVersion: "2.1", serial: "0E897553", mac: "00A0DED4F504" } });
    // Junk in the ids key changes nothing.
    expect(profileIdentityOf({ yxcIdentity: "WX-030|2.1", yxcDeviceIds: "junk" })).toEqual({
      yxc: { model: "WX-030", systemVersion: "2.1" },
    });
  });

  test("names the keys the adapter reads and deletes", () => {
    expect(PROFILE_KEY).toBe("capabilityProfile");
    expect(LEGACY_PROFILE_KEYS).toEqual(["probeCache", "yncaAvail", "purgeVersion"]);
  });
});

describe("DeviceProfileStore", () => {
  const deps = (): {
    patches: Array<Record<string, unknown>>;
    lines: string[];
    deps: DeviceProfileDeps;
  } => {
    const patches: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    return {
      patches,
      lines,
      deps: {
        adapterVersion: "2.7.0",
        now: () => "2026-09-09T12:00:00.000Z",
        persist: patch => patches.push(patch),
        log: line => lines.push(line),
      },
    };
  };
  const profileOf = (patch: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(patch[PROFILE_KEY] as string) as Record<string, unknown>;

  test("keeps the list of subunits the YNCA probe asked — a restart judges absent sources by it", () => {
    const { patches, deps: d } = deps();
    const store = new DeviceProfileStore("rx", undefined, d);
    store.subunitCache.set({
      subunits: ["MAIN", "NETRADIO"],
      probed: ["NETRADIO", "SPOTIFY"],
      model: "RX-V473",
      firmware: "1.0",
    });
    const saved = profileOf(patches.at(-1)!);
    expect(saved.yncaAvail).toEqual({
      subunits: ["MAIN", "NETRADIO"],
      probed: ["NETRADIO", "SPOTIFY"],
      model: "RX-V473",
      firmware: "1.0",
    });
    // …and after the restart the cache hands it back.
    const again = new DeviceProfileStore("rx", { [PROFILE_KEY]: patches.at(-1)![PROFILE_KEY] }, deps().deps);
    expect(again.subunitCache.get()?.probed).toEqual(["NETRADIO", "SPOTIFY"]);
  });

  test("derives the device identity from the XML system id and the MusicCast device ids", () => {
    const d = deps();
    const stored = serializeCapabilityProfile(
      {
        memory: { xmlIdentity: "RX-V6A|0A1B2C3D|2.15", yxcDeviceIds: { serial: "0A1B2C3D", mac: "00A0DE0A1B2C" } },
        pendingPurge: [],
      },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-01T00:00:00.000Z" },
    );
    const store = new DeviceProfileStore("living", { [PROFILE_KEY]: stored }, d.deps);
    expect(store.identity()).toEqual({ serial: "0A1B2C3D", mac: "00A0DE0A1B2C" });
  });

  test("the remembered model comes from whichever transport answered — XML alone is enough", () => {
    const d = deps();
    const xmlOnly = serializeCapabilityProfile(
      { memory: { xmlIdentity: "RX-V3900|0CE4E483|1.05" }, pendingPurge: [] },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-01T00:00:00.000Z" },
    );
    expect(new DeviceProfileStore("living", { [PROFILE_KEY]: xmlOnly }, d.deps).model()).toBe("RX-V3900");
    const yxcOnly = serializeCapabilityProfile(
      { memory: { yxcIdentity: "WX-030|2.1" }, pendingPurge: [] },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-01T00:00:00.000Z" },
    );
    expect(new DeviceProfileStore("living", { [PROFILE_KEY]: yxcOnly }, d.deps).model()).toBe("WX-030");
    expect(new DeviceProfileStore("living", {}, d.deps).model()).toBeUndefined();
  });

  // A scrubbed XML System_ID won the `||` and hid MusicCast's valid serial (audit 2026-09-24, A10).
  test("an invalid XML System_ID does not hide the MusicCast serial", () => {
    const d = deps();
    const stored = serializeCapabilityProfile(
      {
        memory: { xmlIdentity: "RX-V6A|00000000|2.15", yxcDeviceIds: { serial: "0A1B2C3D", mac: "00A0DE0A1B2C" } },
        pendingPurge: [],
      },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-01T00:00:00.000Z" },
    );
    expect(new DeviceProfileStore("living", { [PROFILE_KEY]: stored }, d.deps).identity()).toEqual({
      serial: "0A1B2C3D",
      mac: "00A0DE0A1B2C",
    });
  });

  test("has no identity while both memories are blank or scrubbed", () => {
    const d = deps();
    expect(new DeviceProfileStore("living", {}, d.deps).identity()).toBeUndefined();
    const scrubbed = serializeCapabilityProfile(
      {
        memory: { xmlIdentity: "RX-V6A|00000000|2.15", yxcDeviceIds: { serial: "00000000", mac: "RXV6A0000" } },
        pendingPurge: [],
      },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-01T00:00:00.000Z" },
    );
    expect(new DeviceProfileStore("living", { [PROFILE_KEY]: scrubbed }, d.deps).identity()).toBeUndefined();
  });

  test("converts the legacy keys at load — one patch with the profile and the three deletions", () => {
    const d = deps();
    new DeviceProfileStore(
      "living",
      {
        probeCache: JSON.stringify({ __schema: DISCOVERY_SCHEMA, yncaCapabilities: caps }),
        yncaAvail: avail,
        purgeVersion: "2.6.0",
      },
      d.deps,
    );
    expect(d.patches).toHaveLength(1);
    expect(d.patches[0]).toMatchObject({ probeCache: null, yncaAvail: null, purgeVersion: null });
    const profile = profileOf(d.patches[0]);
    expect(profile.memory).toEqual({ yncaCapabilities: caps });
    expect(profile.yncaAvail).toEqual({ subunits: ["MAIN", "TUN"], model: "RX-V473", firmware: "1.60/2.02" });
    expect(profile.purgeVersion).toBe("2.6.0");
    expect(profile.learnedAt).toBe("2026-09-09T12:00:00.000Z");
    expect(d.lines).toEqual([]);
  });

  test("a stored profile is not rewritten at load, and a later change writes only the profile key", () => {
    const d = deps();
    const stored = serializeCapabilityProfile(
      { memory: { yncaCapabilities: caps }, purgeVersion: "2.7.0", pendingPurge: [] },
      { adapterVersion: "2.7.0", learnedAt: "2026-09-01T00:00:00.000Z" },
    );
    const store = new DeviceProfileStore("living", { [PROFILE_KEY]: stored }, d.deps);
    expect(d.patches).toHaveLength(0);
    expect(store.probeMemory.remembered("yncaCapabilities")).toEqual(caps);
    store.probeMemory.set("xmlDialect", "classic");
    expect(d.patches).toHaveLength(1);
    expect(Object.keys(d.patches[0])).toEqual([PROFILE_KEY]);
    const profile = profileOf(d.patches[0]);
    expect(profile.memory).toEqual({ yncaCapabilities: caps, xmlDialect: "classic" });
    // learnedAt is the FIRST learning under this schema, kept across persists.
    expect(profile.learnedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(profile.adapterVersion).toBe("2.7.0");
  });

  test("a memory of another schema is re-learned: empty memory, fresh learnedAt, one debug line", () => {
    const d = deps();
    const stored = JSON.stringify({
      schema: DISCOVERY_SCHEMA + 1,
      adapterVersion: "9.9.9",
      learnedAt: "2030-01-01T00:00:00.000Z",
      identity: {},
      memory: { yncaCapabilities: caps },
      yncaAvail: { subunits: ["MAIN"], model: "RX-V473", firmware: "1.60/2.02" },
      purgeVersion: "9.9.9",
    });
    const store = new DeviceProfileStore("living", { [PROFILE_KEY]: stored }, d.deps);
    expect(store.probeMemory.remembered("yncaCapabilities")).toBeUndefined();
    expect(store.subunitCache.get()).toBeUndefined();
    expect(store.purgeVersion).toBe("9.9.9");
    expect(d.lines).toEqual([
      `living: discovery logic changed (schema ${DISCOVERY_SCHEMA + 1} → ${DISCOVERY_SCHEMA}) — re-learning the device`,
    ]);
    store.probeMemory.set("k", 1);
    expect(profileOf(d.patches[0]).learnedAt).toBe("2026-09-09T12:00:00.000Z");
    expect(profileOf(d.patches[0]).memory).toEqual({ k: 1 });
  });

  test("the snapshot, the purge marker and the pending purge persist through the same profile", () => {
    const d = deps();
    const store = new DeviceProfileStore("living", {}, d.deps);
    store.subunitCache.set({ subunits: ["MAIN"], model: "RX-V473", firmware: "1.60/2.02" });
    expect(profileOf(d.patches[0]).yncaAvail).toEqual({ subunits: ["MAIN"], model: "RX-V473", firmware: "1.60/2.02" });
    store.subunitCache.clear();
    expect(profileOf(d.patches[1]).yncaAvail).toBeUndefined();
    store.markPurged("2.7.0");
    expect(store.purgeVersion).toBe("2.7.0");
    expect(profileOf(d.patches[2]).purgeVersion).toBe("2.7.0");
    store.setPendingPurge(["a.b", "c.d"]);
    expect(store.pendingPurge).toEqual(["a.b", "c.d"]);
    expect(profileOf(d.patches[3]).pendingPurge).toEqual(["a.b", "c.d"]);
    // Every profile written under this schema carries the current schema and the identity.
    expect(profileOf(d.patches[3]).schema).toBe(DISCOVERY_SCHEMA);
  });

  test("both halves changed inside one coalescing window land in the LAST profile string", () => {
    // The adapter merges native patches by key inside a 250 ms window (last writer wins the whole
    // string). Every persist serializes EVERY field, so the last string is always complete.
    const d = deps();
    const store = new DeviceProfileStore("living", {}, d.deps);
    store.probeMemory.set("xmlDialect", "classic");
    store.subunitCache.set({ subunits: ["MAIN", "ZONE2"], model: "RX-V6A", firmware: "1.80/3.14" });
    store.probeMemory.set("yncaPadDialect", "zone");
    const last = profileOf(d.patches[d.patches.length - 1]);
    expect(last.memory).toEqual({ xmlDialect: "classic", yncaPadDialect: "zone" });
    expect(last.yncaAvail).toEqual({ subunits: ["MAIN", "ZONE2"], model: "RX-V6A", firmware: "1.80/3.14" });
  });

  test("a 2.5.2 memory (no schema) converts to an empty profile and is re-learned, keeping the purge marker", () => {
    const d = deps();
    const store = new DeviceProfileStore(
      "living",
      { probeCache: JSON.stringify({ yncaCapabilities: caps }), purgeVersion: "2.5.2" },
      d.deps,
    );
    expect(store.probeMemory.remembered("yncaCapabilities")).toBeUndefined();
    expect(d.lines).toHaveLength(1);
    expect(d.patches).toHaveLength(1);
    expect(profileOf(d.patches[0]).memory).toEqual({});
    expect(profileOf(d.patches[0]).purgeVersion).toBe("2.5.2");
    expect(d.patches[0]).toMatchObject({ probeCache: null, yncaAvail: null, purgeVersion: null });
  });
});

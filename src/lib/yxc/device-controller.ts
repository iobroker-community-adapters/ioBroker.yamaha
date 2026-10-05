import { parseYxcFeatures, type YxcCapabilities, type YxcTunerFeatures } from "./capability";
import {
  mapYxcToObjects,
  NETUSB_PLAY_ERRORS,
  rawVolumeFor,
  shownVolumeFor,
  volumeScaleOf,
  yxcDeclaredAbsent,
  type VolumeScale,
} from "./object-mapper";
import { absoluteDeviceUrl } from "../catalog/device-url";
import {
  distributionSummary,
  type DistributionSummary,
  parseYxcClock,
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcPlaylistNames,
  parseYxcPlayQueue,
  parseYxcPresetList,
  parseYxcRecentList,
  parseYxcSignalInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  parseYxcTunerPresetLists,
  stateToYxc,
  CLIENT_SLOT_FIELDS,
  clientSlotEntries,
  NETUSB_SLOT_FIELDS,
  netusbSlotEntries,
  PLAYLIST_SLOT_FIELDS,
  playlistSlotEntries,
  playQueueCounters,
  playQueueSlotEntries,
  STATION_SLOT_FIELDS,
  stationSlotEntries,
  type SlotEntry,
  type YxcCommand,
} from "./command-mapper";
import { slotListObjects, slotListValues, type SlotField } from "../catalog/list-slots";
import {
  mediaTimeUpdates,
  mediaToRefresh,
  netusbListsToRefresh,
  netusbNotice,
  pushSignals,
  zonesToRefresh,
  type NetusbNotice,
} from "./push";
import type { ObjectDef } from "../catalog/types";
import { tName, type I18nKey } from "../i18n";
import type { StateValue } from "../types";
import type { ControllerDepsBase } from "../controller";
import { errText } from "../err-text";
import { coerceBool, selfMap } from "../catalog/value-coerce";
import { PollDropDetector } from "../lifecycle/poll-drop-detector";
import { answeredByDevice, YxcTransportError } from "./http-client";
import { splitZone, zonePrefix } from "./zones";
import { presentSystemEntries, YXC_SYSTEM_CATALOG, type YxcSystemEntry } from "./system-catalog";
import { keyedCommon, parentChannels } from "../catalog/types";
import { knownScenes, resolveSceneNumber, sceneListSurface, sceneRecallStates } from "../catalog/scene-titles";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";
import type { BrowseEngine } from "../browse/browse-engine";
import { createBrowseSurface } from "../browse/surface";
import { YxcBrowseDriver, yxcListLanguage } from "../browse/yxc-browse-driver";
import type { PushLiveness } from "./push-liveness";

/** Renew interval for the push registration + state poll, well under the 10-minute expiry (YXC Basic §10.2). */
const KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * How long a changing write waits for the device's event before its effect is read back and, if the
 * device changed the value without telling, counted against the events (see PushLiveness).
 */
export const PUSH_EXPECT_MS = 5000;

/** How long after a favourite recall the device's `preset_control` verdict is taken as its answer. */
const PRESET_VERDICT_MS = 30_000;

/**
 * The main-zone fields every main-zone event carries (YXC Basic Rev 1.00 §10.3) — a keepalive that
 * finds one of them changed with no event since the previous keepalive saw a change nobody announced.
 * Zone 2–4 events are "Reserved" in Rev 1.00 and documented in Rev 1.10 §11.3 ("same as main zone's");
 * no source ties a revision to an `api_version`, so a device on Rev 1.00 firmware may stay silent for
 * its zones, and a zone's silence proves nothing (audit 2026-09-29, C44 — to be settled on a device).
 */
const ANNOUNCED_MAIN_FIELDS = ["power", "input", "volume", "mute"];

/** The written command kinds a device announces by event when they change something it reports. */
const ANNOUNCED_KINDS = new Set(["run", "volume", "equalizer", "tunerBand", "tunerFreq"]);

/** A zone's status request: answered, refused by the device (it is there), or unanswered. */
type ZoneAnswer = { kind: "ok"; status: unknown } | { kind: "refused"; reason: string } | { kind: "unreachable" };

/**
 * Whether a written value equals the one the device reported — compared the way a state write
 * arrives (a script writes "true" or "-30" as text).
 *
 * @param reported the value the device reported
 * @param written the value that was written
 * @returns true when the write asks for what the device already has
 */
function sameValue(reported: boolean | number | string | null | undefined, written: unknown): boolean {
  if (typeof reported === "boolean") {
    return coerceBool(written) === reported;
  }
  if (typeof reported === "number") {
    return typeof written !== "boolean" && written !== null && written !== "" && Number(written) === reported;
  }
  return reported !== undefined && String(written) === reported;
}

/**
 * With push working, run the full media/list/group sweep only every Nth keepalive (6 × 5 min
 * = every 30 minutes) — a safety net against a dropped UDP packet, not the primary path.
 */
const PUSH_MODE_FULL_SWEEP_EVERY = 6;

/**
 * Extract the model name from a getDeviceInfo response, if it carries a non-empty one.
 *
 * @param deviceInfo the getDeviceInfo response
 * @returns the model name, or undefined
 */
function modelNameFrom(deviceInfo: unknown): string | undefined {
  const model = (deviceInfo as { model_name?: unknown } | null)?.model_name;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * The names the user gave the inputs and sound programs in the MusicCast app (getNameText
 * `input_list` / `sound_program_list`, YXC Basic §4.30): id → text, empty texts left out.
 *
 * @param nameText the getNameText response
 * @returns the two maps
 */
export function nameTextLabels(nameText: unknown): {
  inputs: Record<string, string>;
  soundPrograms: Record<string, string>;
} {
  const list = (key: string): Record<string, string> => {
    const entries = (nameText as Record<string, unknown> | null)?.[key];
    const labels: Record<string, string> = {};
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const { id, text } = (typeof entry === "object" && entry !== null ? entry : {}) as {
          id?: unknown;
          text?: unknown;
        };
        if (typeof id === "string" && typeof text === "string" && text.trim().length > 0) {
          labels[id] = text.trim();
        }
      }
    }
    return labels;
  };
  return { inputs: list("input_list"), soundPrograms: list("sound_program_list") };
}

/**
 * Extract the name a user gave this device from a getNameText response.
 *
 * MusicCast keeps it as the main zone's text — that is the name shown in the app and
 * the one people recognise ("Wohnzimmer"). A device whose zone was never renamed
 * answers with a generic zone name; the caller filters those out.
 *
 * @param nameText the getNameText response
 * @returns the main zone's text, or undefined
 */
export function zoneNameFrom(nameText: unknown): string | undefined {
  const zones = (nameText as { zone_list?: unknown } | null)?.zone_list;
  if (!Array.isArray(zones)) {
    return undefined;
  }
  for (const zone of zones) {
    if (typeof zone !== "object" || zone === null) {
      continue;
    }
    const { id, text } = zone as { id?: unknown; text?: unknown };
    if (id === "main" && typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }
  return undefined;
}

import type { YxcClientLike } from "./client-contract";
import { MEMORY_KEY } from "../lifecycle/memory-keys";
import { YxcPlayerRouting } from "./player-routing";
import { LinkGroup } from "./link-group";

/** Probe-memory key: per zone, the display scale (`db`/`numeric`) its `volume` datapoint was read in on. */
const VOLUME_MODE_KEY = MEMORY_KEY.yxcVolumeMode;
/** Probe-memory key: the device-wide settings (getFuncStatus) this receiver has delivered — never shrunk. */
const SYSTEM_ENTRIES_KEY = MEMORY_KEY.yxcSystemEntries;

// Re-exported so existing importers (the tests' fakes) keep resolving it from here.
export type { YxcClientLike };

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface YxcControllerDeps extends ControllerDepsBase {
  /** The YXC (MusicCast) client for this device. */
  client: YxcClientLike;
  /**
   * Name a zone folder as the tree does — `zone2` → `zoneB` on a device whose zone2 is its Zone B
   * (audit 2026-09-29, C29). Unset (tests, a single transport): the ids stay as built.
   */
  aliasZone?: (from: string, to: string) => void;
  /** The installation's system language, for the menus' language (`getListInfo` `lang`, C48). */
  systemLanguage?: string;
  /** Resolve another configured device's client by IP, for forming a multiroom group. */
  clientFor?: (ip: string) => YxcClientLike | undefined;
  /**
   * The addresses of the other configured devices — a group's server is found among them when this
   * device leaves as a client, and the distribution number counts their clients (YXC Advanced §9.1).
   */
  partnerIps?: () => readonly string[];
  /**
   * Register a push handler for this device (by its address, and by its MusicCast `device_id` when
   * known); returns a function that unregisters it.
   */
  registerPush(onPush: (event: unknown) => void, deviceId?: string): () => void;
  /**
   * Whether the shared push receiver is actually listening. With push the device reports
   * its own changes, so the keepalive only has to renew the subscription and refresh the
   * zone status; without it (the port is taken — see issue #611) the poll is the ONLY
   * source of change and has to cover everything. Absent = assume no push.
   */
  pushActive?(): boolean;
  /**
   * Whether this device's events actually arrive (held per device by the adapter, so the verdict
   * survives a reconnect; audit 2026-09-24, C1).
   */
  pushLiveness: PushLiveness;
  /**
   * The device's address as configured — a cover path it reports is fetched from it (C6). Absent =
   * addresses stay as reported.
   */
  host?: string;
  /** Schedule the keepalive handler; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** Report the name the device carries for itself, for the device object's label. */
  reportDeviceName?(name: string): void;
  /** Report the datapoints this device's getFeatures proves absent (see {@link yxcDeclaredAbsent}). */
  reportDeclaredAbsent?(ids: string[]): void;
}

/**
 * The display scale a zone status reports, if it reports one.
 *
 * Read from the RAW answer rather than from the parsed updates, because the object definition
 * has to be corrected before the parsed value is written (see `applyZoneStatus`).
 *
 * @param status the raw getStatus answer
 * @returns "db" / "numeric", or undefined when the device does not report a mode
 */
function actualVolumeModeOf(status: unknown): string | undefined {
  if (typeof status !== "object" || status === null) {
    return undefined;
  }
  const actual = (status as { actual_volume?: unknown }).actual_volume;
  if (typeof actual !== "object" || actual === null) {
    return undefined;
  }
  const mode = (actual as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : undefined;
}

/**
 * Drives one MusicCast (YXC) device: read capabilities, build the object tree,
 * seed state from getStatus, and route commands both ways. Device pushes arrive
 * via the shared receiver as re-fetch signals; a keepalive poll renews the push
 * registration (the fix for the musiccast "stops updating" bug) and doubles as
 * the poll-only fallback when the push port is unavailable. Create-only.
 */
export class YxcDeviceController {
  private zones: string[] = [];
  private mediaBlocks: string[] = [];
  private cancelKeepalive: (() => void) | undefined;
  private cancelPush: (() => void) | undefined;
  private readonly dropDetector = new PollDropDetector();
  /** The tuner's current band, cached so a frequency write can supply it (setFreq needs band + freq). */
  private lastTunerBand = "fm";
  /** Which media source feeds which zone's "now playing" block, and which zone a recall goes to. */
  private readonly routing = new YxcPlayerRouting({
    zones: () => this.zones,
    media: () => this.mediaBlocks,
    emit: (id, value) => this.emit(id, value),
  });
  /** Each zone's declared value lists (getFeatures), for the on-screen remote's write guard. */
  private readonly zoneValueLists = new Map<string, Readonly<Record<string, string[]>>>();
  /**
   * The capability report of this connect and the display scale each zone's `volume` is presented on —
   * decided once per receiver and remembered ({@link VOLUME_MODE_KEY}); a status on the other scale is
   * converted from the raw step count.
   */
  private capabilities: YxcCapabilities | undefined;
  private readonly zoneVolumeMode = new Map<string, string | undefined>();
  /** Each zone's last-seen equalizer bands, cached so one band write can supply the other two. */
  private readonly lastEqualizer = new Map<string, { low: number; mid: number; high: number }>();
  /** Whether the device reports MusicCast-Link distribution (gates the dist poll and objects). */
  private hasDistribution = false;
  /** What the last getDistributionInfo said about this device's group (effective role, roster, status). */
  private dist: DistributionSummary = distributionSummary(undefined);
  /** The MusicCast Link group: link, leave and rename, one change at a time. */
  private readonly group: LinkGroup;
  /** The tuner features (bands + preset mode) — a preset recall needs the band. */
  private tunerFeatures: YxcTunerFeatures | undefined;
  /** Whether the device reports the clock/alarm block (gates the clock poll). */
  private hasClock = false;
  /** The zones declaring `signal_info` (gates the audio-signal poll). */
  private signalZones: string[] = [];
  /** Whether netusb declares the MusicCast playlists / the play queue (gates their polls). */
  private hasMcPlaylist = false;
  private hasPlayQueue = false;
  /** Counts keepalive runs, so the safety-net sweep can run every Nth one under push. */
  private keepaliveRuns = 0;
  /** Events of this device received on this connection — a write or a keepalive compares it. */
  private pushEvents = 0;
  /** {@link pushEvents} when the previous keepalive finished. */
  private eventsAtLastKeepalive = 0;
  private browseEngine: BrowseEngine | undefined;
  /** `api_version` from getDeviceInfo — below 1.17 a cover comes only as Yamaha's encrypted ymf. */
  private apiVersion: number | undefined;
  /** `system_version` from getDeviceInfo — the firmware this connection read. */
  private systemVersion: string | undefined;

  /**
   * The address a reported cover path is shown at: absolute on the device's own web server. Below API
   * 1.17 a cover ON THE DEVICE is Yamaha's encrypted ymf, which only its app decodes (YXC Basic §7.2) —
   * empty; a service's own web address (`http://static.airable.io/…`, the recent list's example in §7.16)
   * is a plain image on every API version and shows as it is (audit 2026-09-29, C49).
   *
   * @param url the reported path or address
   * @returns the address to show, or ""
   */
  private readonly cover = (url: string): string => {
    const onDevice = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    return this.apiVersion !== undefined && this.apiVersion < 1.17 && onDevice
      ? ""
      : absoluteDeviceUrl(url, this.deps.host);
  };

  /** Per zone, the `disable_flags` of its last status — the functions it cannot operate right now. */
  private readonly disabledFlags = new Map<string, number>();

  /** The menu driver, for a re-read when the device announces a list change. */
  private browseDriver: YxcBrowseDriver | undefined;
  /** The favourite this adapter recalled last, so the device's verdict on it can be told apart. */
  private lastPresetRecall: { num: number; at: number } | undefined;
  /**
   * The device-wide settings this receiver really answers (`/system/getFuncStatus`). Empty
   * until the first successful call — claim with proof, exactly like the XML side's status
   * fields: a capability list is a promise, the answer is the evidence.
   */
  private systemEntries: YxcSystemEntry[] = [];

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: YxcControllerDeps,
  ) {
    this.group = new LinkGroup({
      deviceId,
      client: deps.client,
      clientFor: deps.clientFor,
      partnerIps: deps.partnerIps,
      host: deps.host,
      gate: deps.gate,
      log: deps.log,
      refresh: async () => {
        await this.refreshDistribution(this.userClient);
        return this.dist;
      },
      summary: () => this.dist,
      features: () => this.capabilities?.distribution,
    });
  }

  /**
   * Read capabilities, create the object tree, seed state, and wire up push +
   * keepalive.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  public async start(): Promise<boolean> {
    // Freshness guard for the (persisted) probe memory: ONE LIVE getDeviceInfo proves
    // the device behind this address is still the one the memory was learned from. A
    // swapped or factory-reset device answers a different identity — its remembered
    // YXC answers are dropped and re-probed; a transient failure keeps the memory and
    // leaves the liveness verdict to the zone check below. Also feeds the model line.
    let model: string | undefined;
    try {
      const info = await this.deps.client.getDeviceInfo();
      model = modelNameFrom(info);
      const api = (info as { api_version?: unknown } | null)?.api_version;
      this.apiVersion = typeof api === "number" ? api : undefined;
      const version = (info as { system_version?: unknown } | null)?.system_version;
      const firmware = typeof version === "number" || typeof version === "string" ? String(version) : "";
      this.systemVersion = firmware || undefined;
      const identity = `${model ?? ""}|${firmware}`;
      // An answer without a model is no identity at all (YNCA and XML guard the same way): it must not throw
      // away what this receiver declared.
      if (model && this.deps.probeMemory.remembered(MEMORY_KEY.yxcIdentity) !== identity) {
        this.deps.probeMemory.drop(
          key =>
            key === MEMORY_KEY.yxcFeatures ||
            key === MEMORY_KEY.yxcModel ||
            key === MEMORY_KEY.yxcIdentity ||
            key === VOLUME_MODE_KEY ||
            key === SYSTEM_ENTRIES_KEY,
        );
        this.deps.probeMemory.set(MEMORY_KEY.yxcIdentity, identity);
      }
      // Serial (`system_id`) and MAC (`device_id`) — the device's identity for life. Their own
      // key, NOT part of `yxcIdentity`: adding them there would drop every remembered feature
      // once on the update, for nothing the features depend on. The adapter reads them through
      // the profile (`DeviceProfileStore.identity`).
      const ids = info as { system_id?: unknown; device_id?: unknown } | null;
      this.pushDeviceId = typeof ids?.device_id === "string" && ids.device_id.length > 0 ? ids.device_id : undefined;
      if (typeof ids?.system_id === "string" || typeof ids?.device_id === "string") {
        this.deps.probeMemory.set(MEMORY_KEY.yxcDeviceIds, {
          ...(typeof ids.system_id === "string" ? { serial: ids.system_id } : {}),
          ...(typeof ids.device_id === "string" ? { mac: ids.device_id } : {}),
        });
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDeviceInfo failed (${errText(e)})`);
    }
    // Registered for events NOW, not after the start's reads: those take a second or two, and an event in that
    // window was lost — a volume turned while the adapter connected stood wrong until the next keepalive (review
    // 2026-10-05, A47). Events that arrive before the start has written the device's values wait for it, so a
    // refresh they trigger is never overwritten by the older answer the start is still writing.
    this.earlyEvents = [];
    this.cancelPush = this.deps.registerPush(event => this.onPush(event), this.pushDeviceId);
    // Capabilities and name are constant while the device runs, so on a reconnect —
    // and, persisted, on a restart — they come from the per-device memory instead of
    // costing more round-trips on a connection that is being (re-)established anyway.
    // A capability set with no zone at all is not a MusicCast device answering — it is a
    // truncated or malformed answer. Returned to this run, but NOT remembered: remembering
    // it would freeze the device's shape for good (every later connect reads the memory),
    // and it would also disarm the liveness check below, which needs the zones.
    const capabilities = await this.remember(
      MEMORY_KEY.yxcFeatures,
      async () => parseYxcFeatures(await this.deps.client.getFeatures()),
      features => features.zones.length > 0,
    );
    this.zones = capabilities.zones.map(zone => zone.id);
    if (capabilities.zones.some(zone => zone.id === "zone2" && zone.zoneB === true)) {
      this.deps.aliasZone?.("zone2", "zoneB");
    }
    for (const zone of capabilities.zones) {
      if (zone.valueLists) {
        this.zoneValueLists.set(zone.id, zone.valueLists);
      }
    }
    // Every zone's status comes BEFORE the objects (zones in parallel — disjoint writes, and a
    // zone stuck in its timeout must not hold up the device's readiness): the value a zone
    // reports right now belongs in its dropdown even where the device's own list omits it (the
    // RX-A2070 capture lists only "manual" as tone-control mode and answers "auto"), and the
    // list has to carry it from the start (a later widening is possible since 2.7.1, but a
    // dropdown must not be wrong in between). One request per zone, reused below as the seed.
    const answers = await Promise.all(this.zones.map(zone => this.fetchZoneStatus(zone)));
    const statuses = answers.map(answer => (answer.kind === "ok" ? answer.status : undefined));
    const reported: Record<string, Record<string, string>> = {};
    this.zones.forEach((zone, index) => {
      const status = statuses[index];
      if (status === undefined) {
        return;
      }
      const prefix = zonePrefix(zone);
      const values: Record<string, string> = {};
      for (const update of parseYxcStatus(status, zone)) {
        if (typeof update.value === "string" && update.id.startsWith(prefix)) {
          values[update.id.slice(prefix.length)] = update.value;
        }
      }
      // The display scale is no datapoint of its own — it is a property OF the volume datapoint,
      // so it is read straight from the raw answer and handed to the mapper as the mode the
      // objects are built for.
      const mode = actualVolumeModeOf(status);
      if (mode !== undefined) {
        values.actualVolumeMode = mode;
      }
      reported[zone] = values;
    });
    // The names the user gave the device, its inputs and its sound programs — read FRESH on every
    // connection: they are the user's, and a rename in the app froze here for good while they rode in
    // the probe memory (audit 2026-09-24, C12). The memory's old copy is dropped once.
    this.deps.probeMemory.drop(key => key === MEMORY_KEY.yxcNames);
    const nameText = await this.readNameText();
    // getFeatures carries neither the API version nor the names; the tree depends on both.
    this.capabilities = {
      ...capabilities,
      ...(this.apiVersion !== undefined ? { apiVersion: this.apiVersion } : {}),
      ...(nameText !== undefined ? { names: nameTextLabels(nameText) } : {}),
    };
    // The display scale `volume` is presented on is decided once per receiver and kept: a datapoint does not
    // change its unit and bounds because someone switched the receiver's display (krobi 2026-10-02 — a
    // read-in receiver keeps its tree). A value on the other scale is converted from the raw step count.
    const learnedModes = { ...this.deps.probeMemory.remembered<Record<string, string>>(VOLUME_MODE_KEY) };
    let modesLearned = false;
    for (const zone of this.zones) {
      const reportedMode = reported[zone]?.actualVolumeMode;
      const mode = learnedModes[zone] ?? reportedMode;
      if (learnedModes[zone] === undefined && reportedMode !== undefined) {
        learnedModes[zone] = reportedMode;
        modesLearned = true;
      }
      this.zoneVolumeMode.set(zone, mode);
      if (reported[zone] !== undefined && mode !== undefined) {
        reported[zone].actualVolumeMode = mode;
      }
    }
    if (modesLearned) {
      this.deps.probeMemory.set(VOLUME_MODE_KEY, learnedModes);
    }
    const objects = mapYxcToObjects(this.capabilities, reported);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // Parents before children (channels before their states) — created in order.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    this.deps.reportDeclaredAbsent?.(yxcDeclaredAbsent(this.capabilities));
    await this.setupSceneLists(capabilities, objects);
    if (model) {
      // The info channel and info.model already exist — the adapter creates them for
      // every device up front, so the card renders even while the device is offline.
      this.emit("info.model", model);
    }
    // The name the user gave the device in the MusicCast app. Best-effort like the model
    // above: an older device that does not answer getNameText simply keeps its label.
    const name = nameText === undefined ? undefined : zoneNameFrom(nameText);
    if (name) {
      this.deps.reportDeviceName?.(name);
    }
    // Seed every zone from the status fetched above — the same answer, not a second request.
    const zonesAnswered: boolean[] = [];
    for (const [index, status] of statuses.entries()) {
      if (status === undefined) {
        zonesAnswered.push(false);
        continue;
      }
      this.applyZoneStatus(this.zones[index], status);
      zonesAnswered.push(true);
    }
    // The zone status is the one request of this start that ALWAYS goes to the device: the
    // capabilities above come from the probe memory on every reconnect, and model/name are
    // best-effort, so nothing before this point can tell a live device from a dead one. Without
    // the check a reconnect to a receiver that had lost power still reported "ready —
    // MusicCast ✓" out of memory while YNCA and XML failed honestly, and info.connection stayed
    // true for a device that was not there (krobi's RX-V6A, 2026-08-26). A device that answers
    // no zone at all is gone — a standby device still answers, it just reports power=standby.
    // No `zones.length > 0` escape any more: a device that declares NO zone cannot prove it
    // is alive either, and the whole point of this check is that nothing may report "ready"
    // out of memory. Everything before it — capabilities, model, name — can come from the
    // persisted memory without a single request reaching the device.
    if (!zonesAnswered.some(Boolean)) {
      // A refusal is an answer: the device is there and not ready (response_code 1 "Initializing"
      // while it boots, 99 during a firmware update) — no values to start from, but no "unreachable"
      // either (audit 2026-09-24, C15).
      const refusal = answers.find(answer => answer.kind === "refused");
      this.deps.log.debug(
        refusal?.kind === "refused"
          ? `${this.deviceId}: the device answers but is not ready yet — ${refusal.reason} (YXC)`
          : `${this.deviceId}: no zone answered getStatus — device unreachable (YXC)`,
      );
      return false;
    }
    this.mediaBlocks = capabilities.media;
    this.tunerFeatures = capabilities.tuner;
    this.hasClock = capabilities.clock !== undefined;
    this.signalZones = capabilities.zones.filter(zone => zone.funcs.includes("signal_info")).map(zone => zone.id);
    this.hasMcPlaylist = capabilities.netusbFuncs?.includes("mc_playlist") ?? false;
    this.hasPlayQueue = capabilities.netusbFuncs?.includes("play_queue") ?? false;
    await this.setupBrowse(capabilities);
    const answered = await this.refreshMedia();
    // The DAB scan counters are the one DAB detail the device reports only after a station scan (status stays
    // not_ready before) — the documented start state (nothing scanned) where the tuner ANSWERED without them, so
    // they are not left as valueless read states. Never before or over the tuner read: a reconnect wrote 0 over
    // the 35 stations the read then wrote back (35 → 0 → 35 in the history; review 2026-10-05, A43). Only where
    // the tuner declares the scan (`dab_initial_scan`, YXC Basic §6.2 — audit 2026-09-29, C42).
    if (
      answered.has("tuner") &&
      (capabilities.tuner?.bands ?? []).includes("dab") &&
      (capabilities.tuner?.funcs ?? []).includes("dab_initial_scan")
    ) {
      this.placeholders([
        ["tuner.dab.totalStations", 0],
        ["tuner.dab.scanProgress", 0],
      ]);
    }
    // The WHOLE player block of every zone NOT playing a media source gets its cleared shape.
    this.routing.clearIdle();
    await this.refreshLists();
    this.hasDistribution = capabilities.hasDistribution ?? false;
    if (this.hasDistribution) {
      await this.refreshDistribution();
    }
    await this.setupSystemStates(capabilities);
    // The network player's error and message come by event only — "none" so they never stand valueless (and are
    // not purged as never filled) before the first report (C18). Once per device and adapter run: a reconnect wrote
    // "none" over an error an event had reported (review 2026-10-05, A43).
    if (capabilities.media.includes("netusb") && this.deps.pushLiveness.claimStartValues()) {
      this.placeholders([
        ["player.netPlayer.playError", 0],
        ["player.netPlayer.playErrorText", ""],
        ["player.netPlayer.playMessage", ""],
      ]);
    }
    // The events that came during the start, now that its own values are written.
    const early = this.earlyEvents ?? [];
    this.earlyEvents = undefined;
    for (const event of early) {
      this.handlePush(event);
    }
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    // The adapter logs one combined "ready" line across all transports; this stays at debug.
    this.deps.log.debug(`${this.deviceId}: MusicCast device ready (YXC)`);
    return true;
  }

  /**
   * Create and seed the device-wide settings (`/system/getFuncStatus`) — the counterpart of a
   * zone's getStatus for everything that belongs to the device rather than to a zone. Only the
   * fields this device really delivers become objects.
   *
   * @param capabilities the parsed getFeatures capabilities (for the system-block ranges)
   */
  private async setupSystemStates(capabilities: YxcCapabilities): Promise<void> {
    let status: unknown;
    try {
      status = await this.deps.client.getFuncStatus();
    } catch (e) {
      // The settings this receiver delivered before stay: one unanswered request is no proof they are gone.
      this.deps.log.debug(`${this.deviceId}: getFuncStatus failed (${errText(e)})`);
      status = undefined;
    }
    const known = this.deps.probeMemory.union(
      SYSTEM_ENTRIES_KEY,
      presentSystemEntries(status).map(entry => entry.state),
    );
    this.systemEntries = YXC_SYSTEM_CATALOG.filter(entry => known.has(entry.state));
    if (this.systemEntries.length === 0) {
      return;
    }
    const parents = new Set<string>();
    for (const entry of this.systemEntries) {
      for (const parent of parentChannels(entry.state, parents)) {
        await this.deps.upsertObject(`${this.deviceId}.${parent.id}`, parent);
      }
      const common: ObjectDef["common"] = keyedCommon(entry.common);
      const range = entry.rangeId ? capabilities.systemRanges?.[entry.rangeId] : undefined;
      if (range) {
        common.min = range.min;
        common.max = range.max;
        common.step = range.step;
      }
      // The device's own declaration of the selectable values (the system block's `*_list`,
      // or 1..n from its `*_num`) becomes the dropdown — DECLARED, like a zone's lists.
      let declared = false;
      const list = entry.listId ? capabilities.systemLists?.[entry.listId] : undefined;
      const count = entry.countId ? capabilities.systemCounts?.[entry.countId] : undefined;
      if (list && list.length > 0) {
        common.states = Object.fromEntries(
          list.map(item => [entry.toValue?.(item) ?? item, entry.toValue?.(item) ?? item]),
        );
        declared = true;
      } else if (count !== undefined && count > 0) {
        if (common.type === "number") {
          common.min = 1;
          common.max = count;
          common.step = 1;
        } else {
          const slots = Array.from({ length: count }, (_, i) => entry.toValue?.(i + 1) ?? String(i + 1));
          common.states = selfMap(slots);
        }
        declared = true;
      }
      await this.deps.upsertObject(`${this.deviceId}.${entry.state}`, {
        id: entry.state,
        type: "state",
        common,
        ...(declared ? { declaredStates: true } : {}),
      });
    }
    this.applySystemStatus(status);
  }

  /**
   * Write the device-wide values from a getFuncStatus response.
   *
   * @param status the getFuncStatus response
   */
  private applySystemStatus(status: unknown): void {
    if (typeof status !== "object" || status === null) {
      return;
    }
    const fields = status as Record<string, unknown>;
    for (const entry of this.systemEntries) {
      if (entry.field in fields) {
        this.emit(entry.state, entry.fromStatus(fields[entry.field]));
      }
    }
  }

  /** Re-read the device-wide settings during the keepalive, so a change at the device shows up. */
  private async refreshSystemStates(): Promise<void> {
    if (this.systemEntries.length === 0) {
      return;
    }
    try {
      this.applySystemStatus(await this.deps.client.getFuncStatus());
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getFuncStatus refresh failed (${errText(e)})`);
    }
  }

  /**
   * Ask the device once per adapter run and remember the answer for later reconnects.
   *
   * @param key what is being remembered
   * @param probe the request to run when nothing is remembered yet
   * @param isUsable optional plausibility check — an answer it rejects is used but not remembered
   * @returns the remembered or freshly fetched value
   */
  private remember<T>(key: string, probe: () => Promise<T>, isUsable?: (value: T) => boolean): Promise<T> {
    return this.deps.probeMemory.once(key, probe, isUsable);
  }

  /**
   * Write a device-originated value — but never after the connection was closed. A poll
   * or a browse fetch that was already in flight when the adapter stopped would otherwise
   * still write into a tree that is being torn down.
   *
   * @param relativeId the state id relative to the device
   * @param value the value to write
   */
  private emit(relativeId: string, value: boolean | number | string | null): void {
    if (this.deps.gate.closed) {
      return;
    }
    // Every reported value is handed on, changed or not: the database write compares
    // (`setStateChangedAsync`), and only a value handed on can correct a datapoint someone else
    // wrote or one this transport just took over (audit 2026-09-24, C21 — a poll mirrors the device
    // on every answer). The map keeps what the device reported, for the push-liveness check.
    this.deviceValues.set(relativeId, value);
    this.deps.setStateAck(`${this.deviceId}.${relativeId}`, value);
  }

  /** The MusicCast `device_id` this device reported — the events carry it too (see registerPush). */
  private pushDeviceId: string | undefined;
  /** Events that arrived while the start was still writing the device's values — handled after it (A47). */
  private earlyEvents: unknown[] | undefined;

  /**
   * Write start values only where this connection has not written a value yet — a placeholder never stands over
   * one the device reported (review 2026-10-05, A43).
   *
   * @param values the ids and their start values
   */
  private placeholders(values: ReadonlyArray<readonly [string, number | string]>): void {
    for (const [id, value] of values) {
      if (!this.deviceValues.has(id)) {
        this.emit(id, value);
      }
    }
  }

  /** Per state id, the value the device last reported on THIS connection. */
  private readonly deviceValues = new Map<string, boolean | number | string | null>();
  /** The refreshes running per key, and whether one more was asked for meanwhile (see `coalesced`). */
  private readonly refreshes = new Map<string, { again: boolean }>();
  /** How many slots each list folder has objects for (see `publishSlots`). */
  private readonly slotCounts = new Map<string, number>();

  /**
   * A user write to one of this controller's states, under the controller's own id relative to the
   * device — it becomes a YXC command. The multi-transport handle has already dropped acked
   * echoes and routed only the owner's ids here (audit 2026-09-29, A32: each controller re-checked
   * both, a path production never took).
   *
   * Every path says what became of the write — never a forgotten `undefined`, which the handle reads as
   * "unclear" and so never tries the next protocol (Y-04): a device-wide setting, a group change and a key
   * stayed on MusicCast while YNCA could have carried them (review 2026-10-05, A3). A write this controller
   * drops itself is `unavailable`, with a debug line naming the device, the datapoint and the reason (A46).
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what the device made of the write
   */
  public async handleWrite(stateId: string, value: unknown): Promise<WriteOutcome> {
    if (stateId.startsWith("player.browse.")) {
      if (!this.browseEngine) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} — this device has no menu, write dropped`);
        return "unavailable";
      }
      // The engine says what became of a menu write — the same answer on all three protocols.
      return this.browseEngine.handleWrite(stateId, value);
    }
    const { zone: zoneKey, name } = splitZone(stateId);
    // ONE resolution for every scene write, number or title, as on YNCA and XML: a whole number of 1 or more,
    // or a title the zone reports (the titles may have come over XML or YNCA while MusicCast owns the recall).
    // MusicCast recalled scene 2 for 1.5 and sent `recallScene(0)` for 0 (review 2026-10-05, A26).
    if (name === "scene.recall") {
      const resolved = resolveSceneNumber(value, this.deps.probeMemory, zoneKey);
      if (resolved === undefined) {
        // Same rule and words as the YNCA side: a write that goes nowhere leaves a trace.
        this.deps.log.debug(
          `${this.deviceId}: scene "${String(value)}" is not one this device declares — write dropped ` +
            `(known: ${
              knownScenes(this.deps.probeMemory, zoneKey)
                .map(scene => scene.title)
                .join(", ") || "none yet"
            })`,
        );
        return "unavailable";
      }
      value = resolved;
    }
    // Multiroom writes need controller state (the cached role), so they bypass the pure command map.
    if (stateId === "multiroom.group.leave") {
      return this.group.leave();
    }
    if (stateId === "multiroom.group.linkDevice") {
      return this.group.link(String(value));
    }
    if (stateId === "multiroom.group.name") {
      return this.group.rename(value);
    }
    // Device-wide settings are not part of the zone command map — they carry their own setters.
    const systemEntry = this.systemEntries.find(entry => entry.state === stateId);
    if (systemEntry) {
      if (!systemEntry.write) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} is read-only on MusicCast — write dropped`);
        return "unavailable";
      }
      return this.applySystemWrite(systemEntry, value);
    }
    // The on-screen remote: a word the zone DECLARES (cursor_list/menu_list) goes to the device
    // even where the shared vocabulary lacks it — help, mode and the four colour keys exist on
    // some models only. A word in neither list is dropped by the vocabulary check below.
    if ((name === "remote.cursor" || name === "remote.menu") && typeof value === "string") {
      const declared = this.zoneValueLists.get(zoneKey)?.[name];
      if (declared?.includes(value)) {
        const word = value;
        return this.applyCommand(stateId, {
          kind: "run",
          run: client =>
            name === "remote.cursor" ? client.controlCursor(word, zoneKey) : client.controlMenu(word, zoneKey),
        });
      }
      // A zone that declares its keys takes those and no other — the shared vocabulary below is for a
      // zone without a list; before, a word the zone does not have still went out (audit 2026-09-29, C46).
      if (declared !== undefined) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} "${value}" is not a key this zone declares — not sent`);
        return "unavailable";
      }
    }
    const command = stateToYxc(stateId, value);
    if (!command) {
      this.deps.log.debug(
        `${this.deviceId}: ${stateId} — "${String(value)}" is no value MusicCast takes, write dropped`,
      );
      return "unavailable";
    }
    // A function the zone reports not operable right now (YXC Basic §5.1 `disable_flags`: b0 volume,
    // b1 mute, b2 link audio delay — a soundbar in standby reports 3) is not sent: the device would
    // refuse it with a warning; the datapoint gets the device's value back (audit 2026-09-24, C27).
    const bit = ({ volume: 0b1, mute: 0b10, "sound.linkAudioDelay": 0b100 } as Record<string, number>)[name];
    const disabled = (): boolean => bit !== undefined && ((this.disabledFlags.get(zoneKey) ?? 0) & bit) !== 0;
    if (disabled()) {
      // The flags are those of the zone's LAST status: a script's "power on, then volume" was judged on the
      // standby flags and its volume dropped, push or not (YSP-1600, review 2026-10-05, A18). The zone is asked
      // now — behind the power write in the command gate — and that answer decides; it also puts the device's
      // value back on the datapoint when the function is still not operable.
      await this.refreshZone(zoneKey, this.userClient);
      if (disabled()) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} is not operable on the device right now — not sent`);
        return "unavailable";
      }
    }
    return this.applyCommand(stateId, command, value);
  }

  /**
   * The client at USER priority, for every read that belongs to a user's write: its read-back, the zone a
   * stale standby flag is checked against, the group read inside a group change. From its verb a read is
   * background work and waited behind the poll sweep, while YNCA reads back at user priority (review
   * 2026-10-05, A58).
   *
   * @returns the user-priority twin of the device's client
   */
  private get userClient(): YxcClientLike {
    return this.deps.client.forUser();
  }

  /** @returns the firmware (`system_version`) read on this connection, if any */
  public firmware(): string | undefined {
    return this.systemVersion;
  }

  /**
   * Apply a write to a device-wide setting and read the block back — taken or refused — so the state shows
   * what the device actually has.
   *
   * @param entry the system catalog entry
   * @param value the written value
   * @returns what the device made of the write
   */
  private async applySystemWrite(entry: YxcSystemEntry, value: unknown): Promise<WriteOutcome> {
    // A switch reads the words a script writes ("false", "off", "0") for what they mean — the
    // entry's Boolean() would send every non-empty string as on.
    const input = entry.common.type === "boolean" ? coerceBool(value) : value;
    if (input === undefined) {
      this.deps.log.debug(`${this.deviceId}: ${entry.state} — "${String(value)}" is no switch value, write dropped`);
      return "unavailable";
    }
    let outcome: WriteOutcome = "sent";
    try {
      await entry.write?.apply(this.deps.client, input);
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: ${entry.state} could not be set (${errText(e)})`);
      this.checkAliveAfter(e);
      // A write nobody answered leaves it to the liveness check (and to the next protocol).
      if (!answeredByDevice(e)) {
        return "unavailable";
      }
      // A refused setting is read back like a taken one — the datapoint shows what the device
      // kept (audit 2026-09-24, C28).
      outcome = "refused";
    }
    void this.readSystemBack(entry.state);
    return outcome;
  }

  /**
   * Read the device-wide settings back after a write to one of them.
   *
   * @param stateId the written setting, for the failure line
   */
  private async readSystemBack(stateId: string): Promise<void> {
    try {
      this.applySystemStatus(await this.userClient.getFuncStatus());
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: reading ${stateId} back failed (${errText(e)})`);
    }
  }

  /**
   * After a write that no device answered, find out at once whether the device is still there.
   * Only the keepalive used to feed the drop detector: a device switched off right after a poll
   * stayed "connected" for up to three polls — 15 minutes — while every write merely warned.
   * A refusal (the device answered, and said no) is proof of life and checks nothing.
   *
   * @param failure the error the write ended with
   */
  private checkAliveAfter(failure: unknown): void {
    if (!(failure instanceof YxcTransportError)) {
      return;
    }
    void this.verifyAlive();
  }

  /**
   * Ask the device once, now: the main zone's status. No answer is a drop — reported at once,
   * not after the third missed five-minute poll. One probe for a burst of askers (failed
   * writes, the multi-transport handle after another transport dropped): the second and later
   * ones ride on the first.
   */
  public verifyAlive(): Promise<void> {
    return this.dropDetector.verify(() => this.refreshZone(this.zones[0] ?? "main"));
  }

  /**
   * Register the supervisor's drop handler. MusicCast has no socket-drop event, so a
   * drop is inferred from a run of failed keepalive polls (see keepalive).
   *
   * @param cb invoked once when the device is judged gone
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.dropDetector.onDrop(cb);
  }

  /**
   * Create the browsing surface (#613) when the device has the netusb block: the
   * `netusb/getListInfo` + `setListControl` API drives an 8-line window under
   * `player.browse.*`.
   *
   * @param capabilities the parsed getFeatures capabilities
   */
  private async setupBrowse(capabilities: YxcCapabilities): Promise<void> {
    const gate = this.deps.gate;
    if (!capabilities.media.includes("netusb")) {
      return;
    }
    const inputs = capabilities.zones.find(zone => zone.id === "main")?.inputs ?? [];
    const driver = new YxcBrowseDriver(
      this.deps.client,
      inputs,
      this.cover,
      input => this.routing.recallZone(input),
      yxcListLanguage(this.deps.systemLanguage),
    );
    this.browseDriver = driver;
    this.browseEngine = await createBrowseSurface(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.emit(id, value),
      log: this.deps.log,
      delay: ms => gate.delay(ms),
    });
  }

  /** Cancel the keepalive and unregister the push handler. Synchronous — safe from onUnload. */
  public close(): void {
    this.browseEngine?.close();
    // Closing the gate empties its queue and aborts its signal: queued requests are
    // dropped and every pending wait ends, so nothing writes after the teardown.
    this.deps.gate.close();
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
    // Unregister from the shared push receiver — otherwise a push arriving after
    // teardown would setState on a controller the adapter has already dropped.
    this.cancelPush?.();
    this.cancelPush = undefined;
  }

  /**
   * Handle a device push: each named zone is re-fetched via getStatus, each named
   * media source via getPlayInfo, each announced list with its own request. A few values
   * ride in the push itself and are written directly: the playback clock, the network
   * player's error, message and preset verdict, and the CD drive state. Refreshing only
   * the named sources keeps a track-change push from re-polling every source.
   *
   * @param event the parsed push event
   */
  private onPush(event: unknown): void {
    this.pushEvents++;
    if (this.deps.pushLiveness.noteEvent()) {
      this.deps.log.info(`${this.deviceId}: MusicCast events arrive again`);
    }
    if (this.earlyEvents !== undefined) {
      this.earlyEvents.push(event);
      return;
    }
    this.handlePush(event);
  }

  /**
   * Act on one device event (see {@link onPush}).
   *
   * @param event the parsed push event
   */
  private handlePush(event: unknown): void {
    for (const zone of zonesToRefresh(event)) {
      if (this.zones.includes(zone)) {
        this.coalesced(`zone:${zone}`, () => this.refreshZone(zone));
      }
    }
    for (const block of mediaToRefresh(event)) {
      if (this.mediaBlocks.includes(block)) {
        this.coalesced(`media:${block}`, () => this.refreshMediaSource(block));
      }
    }
    // The playback clock ticks every second while a source plays: its values go to the player
    // states of the zone listening to that source, and nothing is asked of the device.
    for (const { block, info } of mediaTimeUpdates(event)) {
      if (this.mediaBlocks.includes(block)) {
        this.routing.route(block, parseYxcPlayInfo(info, block, this.cover));
      }
    }
    // The favourites/recently-played lists announce their changes as flags in the push.
    const lists = netusbListsToRefresh(event);
    if (lists.presets && this.mediaBlocks.includes("netusb")) {
      void this.refreshNetusbPresets();
    }
    if (lists.recent && this.mediaBlocks.includes("netusb")) {
      void this.refreshNetusbRecent();
    }
    // Every other area the device announces, each re-read with its own one request (C3).
    const signals = pushSignals(event);
    if (signals.distribution && this.hasDistribution) {
      void this.refreshDistribution();
    }
    if (signals.system) {
      void this.refreshSystemStates();
    }
    for (const zone of signals.signalZones) {
      if (this.signalZones.includes(zone)) {
        void this.refreshZoneSignal(zone);
      }
    }
    if (signals.tunerPresets && this.mediaBlocks.includes("tuner")) {
      void this.refreshTunerPresets();
    }
    if (signals.clock && this.hasClock) {
      void this.refreshClock();
    }
    if (signals.nameText) {
      void this.refreshDeviceName();
    }
    if (signals.list) {
      void this.browseDriver?.refresh();
    }
    if (this.mediaBlocks.includes("netusb")) {
      this.applyNetusbNotice(netusbNotice(event));
    }
    // The disc drive's state rides in the push itself (it is no playback-info change).
    const cd = (event as { cd?: { device_status?: unknown } } | null)?.cd;
    if (typeof cd?.device_status === "string" && this.mediaBlocks.includes("cd")) {
      this.emit("player.cd.deviceStatus", cd.device_status);
    }
  }

  /**
   * Poll every zone (which renews the push registration and refreshes state); the media
   * sources, lists, device-wide settings and distribution follow on every run without
   * working push, and on every PUSH_MODE_FULL_SWEEP_EVERY-th run with it. If every zone
   * poll fails for three consecutive failed runs in a row,
   * the device is judged gone and a drop is reported so the supervisor can flip
   * info.connection and reconnect.
   */
  private async keepalive(): Promise<void> {
    // The keepalive is an async handler on an adapter timer: a rejection here is an
    // UNHANDLED rejection, and js-controller turns those into an adapter stop. Every step
    // below catches for itself today, so the guard is what makes that a guarantee instead
    // of something the next change has to remember.
    try {
      const quiet = (): boolean => this.pushEvents === this.eventsAtLastKeepalive;
      // A source playing to a switched-on zone ticks its play time every second: an interval without one event
      // while it plays is judged too, not only the main zone's four fields — events taken by another client while
      // titles changed were never judged, and the titles stood up to 30 minutes old (review 2026-10-05, A17).
      const printsBefore = new Map((["netusb", "cd"] as const).map(block => [block, this.routing.printOf(block)]));
      // Zones in parallel: their writes are disjoint and one zone stuck in its timeout must
      // not delay the others (a four-zone receiver used to poll them strictly in series).
      const announced = ANNOUNCED_MAIN_FIELDS.map(id => this.deviceValues.get(id));
      const anyOk = (await Promise.all(this.zones.map(zone => this.refreshZone(zone)))).some(Boolean);
      // A main-zone field that changed while no event came since the previous keepalive: the
      // device told nobody. Only a field that HAD a value counts — one reported for the first time
      // is no change. An event during this keepalive moves the counter and judges nothing.
      const unannounced = ANNOUNCED_MAIN_FIELDS.some((id, i) => {
        const before = announced[i];
        return before !== undefined && this.deviceValues.get(id) !== before;
      });
      // Every request above already carried the subscription headers, so the push
      // registration is renewed either way. What still has to be polled depends on whether
      // push works: with push the device announces media, list and group changes itself, so
      // the full sweep only runs occasionally as a safety net (UDP can drop a packet);
      // without push it is the only way anything ever updates.
      // Judged after the zones answered: a zone that just left its source listens to it no more.
      const playing = this.pushWorking() ? this.routing.audible() : [];
      this.keepaliveRuns++;
      const fullSweep = !this.pushWorking() || this.keepaliveRuns % PUSH_MODE_FULL_SWEEP_EVERY === 0;
      if (fullSweep) {
        await this.refreshSystemStates();
        await this.refreshMedia();
        await this.refreshLists();
        if (this.hasDistribution) {
          await this.refreshDistribution();
        }
      } else if (playing.length > 0 && quiet()) {
        // Only the playing sources, and only while no event came: the read the judgement needs.
        await Promise.all(playing.map(block => this.refreshMediaSource(block)));
      }
      const mediaChanged = playing.some(block => this.routing.printOf(block) !== printsBefore.get(block));
      if ((unannounced || mediaChanged) && quiet()) {
        this.noteMiss();
      }
      this.eventsAtLastKeepalive = this.pushEvents;
      this.dropDetector.record(anyOk);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: keepalive poll failed: ${errText(e)}`);
    }
  }

  /**
   * Refresh the list-shaped surfaces: the netusb favourites and recently-played
   * lists, the tuner preset lists, and the clock/alarm settings. Each is
   * best-effort — a device without the feature answers with an error code and the
   * state simply stays.
   */
  private async refreshLists(): Promise<void> {
    if (this.mediaBlocks.includes("netusb")) {
      await this.refreshNetusbPresets();
      await this.refreshNetusbRecent();
      if (this.hasMcPlaylist) {
        await this.refreshPlaylists();
      }
      if (this.hasPlayQueue) {
        await this.refreshPlayQueue();
      }
    }
    if (this.mediaBlocks.includes("tuner")) {
      await this.refreshTunerPresets();
    }
    if (this.hasClock) {
      await this.refreshClock();
    }
    await this.refreshSignalInfo();
  }

  /**
   * Put a device list in the tree as slots — a channel per slot, a datapoint per field — beside its JSON
   * state (C30, `catalog/list-slots.ts`). The objects are built when the slot count grows (a declared
   * count once; a list whose length varies — playlists, linked devices — up to the longest seen, so an
   * entry that goes is cleared, not deleted and rebuilt).
   *
   * @param folder the list's folder id
   * @param folderName the folder's name
   * @param fields the fields of a slot
   * @param entries the entries by slot
   * @param declared the slot count the device declares, when it declares one
   * @param folderDesc the folder's explanation
   * @param folderArg the value of the folder name's placeholder, when it has one
   */
  private async publishSlots(
    folder: string,
    folderName: I18nKey,
    fields: readonly SlotField[],
    entries: readonly SlotEntry[],
    declared?: number,
    folderDesc?: I18nKey,
    folderArg?: string,
  ): Promise<void> {
    const built = this.slotCounts.get(folder) ?? 0;
    const count = Math.max(declared ?? 0, entries.length, built);
    if (count > built) {
      for (const object of slotListObjects(folder, folderName, count, fields, folderDesc, folderArg)) {
        await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
      }
      this.slotCounts.set(folder, count);
    }
    for (const { id, value } of slotListValues(folder, count, fields, entries)) {
      this.emit(id, value);
    }
  }

  /** Fetch the MusicCast playlist names and write the JSON list state and the playlist slots. */
  private async refreshPlaylists(): Promise<void> {
    try {
      const info = await this.deps.client.getMcPlaylistName();
      const update = parseYxcPlaylistNames(info);
      if (update) {
        this.emit(update.id, update.value);
      }
      const entries = playlistSlotEntries(info);
      if (entries) {
        await this.publishSlots("player.netPlayer.playlistNames", "musiccastPlaylists", PLAYLIST_SLOT_FIELDS, entries);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getMcPlaylistName failed: ${errText(e)}`);
    }
  }

  /** Fetch the network player's play queue and write the JSON state. */
  private async refreshPlayQueue(): Promise<void> {
    try {
      const info = await this.deps.client.getPlayQueue();
      const update = parseYxcPlayQueue(info);
      if (update) {
        this.emit(update.id, update.value);
      }
      for (const counter of playQueueCounters(info)) {
        this.emit(counter.id, counter.value);
      }
      // The tracks as single datapoints beside the JSON (fleet rule: a list only in addition).
      const entries = playQueueSlotEntries(info);
      if (entries) {
        await this.publishSlots(
          "player.netPlayer.queueTracks",
          "queueTracks",
          PLAYLIST_SLOT_FIELDS,
          entries,
          undefined,
          "descQueueTracks",
        );
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayQueue failed: ${errText(e)}`);
    }
  }

  /** Fetch each declaring zone's audio-signal info and write the signal states. */
  private async refreshSignalInfo(): Promise<void> {
    for (const zone of this.signalZones) {
      await this.refreshZoneSignal(zone);
    }
  }

  /**
   * Fetch one zone's audio-signal info and write its signal states.
   *
   * @param zone the zone
   */
  private async refreshZoneSignal(zone: string): Promise<void> {
    try {
      for (const update of parseYxcSignalInfo(await this.deps.client.getSignalInfo(zone), zone)) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getSignalInfo(${zone}) failed: ${errText(e)}`);
    }
  }

  /**
   * Read getNameText, or undefined when the device does not answer it (an older one).
   *
   * @returns the raw answer
   */
  private async readNameText(): Promise<unknown> {
    try {
      return await this.deps.client.getNameText();
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getNameText failed (${errText(e)})`);
      return undefined;
    }
  }

  /**
   * Re-read the names the user gave in the MusicCast app (`name_text_updated`, YXC Basic Rev 1.10
   * §11.3): the device's own name goes to its label, the input and sound-program names to the
   * dropdowns of every zone (C12/C24).
   */
  private async refreshDeviceName(): Promise<void> {
    try {
      const nameText = await this.readNameText();
      if (nameText === undefined) {
        return;
      }
      const name = zoneNameFrom(nameText);
      if (name) {
        this.deps.reportDeviceName?.(name);
      }
      if (!this.capabilities) {
        return;
      }
      this.capabilities = { ...this.capabilities, names: nameTextLabels(nameText) };
      for (const zone of this.zones) {
        const prefix = zonePrefix(zone);
        const current: Record<string, string> = {};
        for (const field of ["input", "soundProgram"]) {
          const value = this.deviceValues.get(`${prefix}${field}`);
          if (typeof value === "string") {
            current[field] = value;
          }
        }
        const defs = mapYxcToObjects(this.capabilities, { [zone]: current });
        for (const id of [`${prefix}input`, `${prefix}soundProgram`]) {
          const def = defs.find(object => object.id === id);
          if (def) {
            await this.deps.upsertObject(`${this.deviceId}.${id}`, def);
          }
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: re-reading the names failed (${errText(e)})`);
    }
  }

  /**
   * What the network player reports in a push itself: its playback error and message go to their
   * states, the verdict on a favourite this adapter recalled is said (audit 2026-09-24, C18).
   *
   * @param notice the network player's fields of the push
   */
  private applyNetusbNotice(notice: NetusbNotice): void {
    if (notice.playError !== undefined) {
      this.emit("player.netPlayer.playError", notice.playError);
      this.emit(
        "player.netPlayer.playErrorText",
        (notice.playErrorCodes ?? []).map(code => NETUSB_PLAY_ERRORS[code] ?? String(code)).join(", "),
      );
    }
    if (notice.playMessage !== undefined) {
      this.emit("player.netPlayer.playMessage", notice.playMessage);
    }
    const control = notice.presetControl;
    if (!control || control.result === "success") {
      return;
    }
    const recalled = this.lastPresetRecall;
    const ours =
      control.type === "recall" && recalled?.num === control.num && Date.now() - recalled.at < PRESET_VERDICT_MS;
    if (ours) {
      this.lastPresetRecall = undefined;
      this.deps.log.warn(`${this.deviceId}: favourite ${control.num} could not be recalled (${control.result})`);
    } else {
      this.deps.log.debug(`${this.deviceId}: preset ${control.type} ${control.num}: ${control.result}`);
    }
  }

  /**
   * Fetch the stored netusb favourites and write the JSON list state.
   *
   * @param via the client to ask through — the user-priority one for the read-back of a user write
   */
  private async refreshNetusbPresets(via: YxcClientLike = this.deps.client): Promise<void> {
    try {
      const info = await via.getPresetInfo();
      const update = parseYxcPresetList(info);
      if (update) {
        this.emit(update.id, update.value);
      }
      const entries = netusbSlotEntries((info as { preset_info?: unknown } | null)?.preset_info);
      if (entries) {
        await this.publishSlots(
          "player.netPlayer.favourites",
          "favourites",
          NETUSB_SLOT_FIELDS,
          entries,
          this.capabilities?.netusbSlots?.presets,
          "descFavourites",
        );
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPresetInfo failed: ${errText(e)}`);
    }
  }

  /** Fetch the recently-played list and write the JSON list state. */
  private async refreshNetusbRecent(): Promise<void> {
    try {
      const info = await this.deps.client.getRecentInfo();
      const update = parseYxcRecentList(info, this.cover);
      if (update) {
        this.emit(update.id, update.value);
      }
      const entries = netusbSlotEntries((info as { recent_info?: unknown } | null)?.recent_info);
      if (entries) {
        await this.publishSlots(
          "player.netPlayer.recentItems",
          "recentlyPlayed",
          NETUSB_SLOT_FIELDS,
          entries,
          this.capabilities?.netusbSlots?.recent,
        );
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getRecentInfo failed: ${errText(e)}`);
    }
  }

  /**
   * Fetch the tuner preset lists — the shared `common` list, or one per band on
   * devices with separate lists — and write the JSON state.
   *
   * @param via the client to ask through — the user-priority one for the read-back of a user write
   */
  private async refreshTunerPresets(via: YxcClientLike = this.deps.client): Promise<void> {
    try {
      const common = this.tunerFeatures?.presetType === "common";
      const bands = common ? ["common"] : (this.tunerFeatures?.bands ?? ["fm"]);
      const byBand: Record<string, unknown> = {};
      for (const band of bands) {
        try {
          byBand[band] = await via.getTunerPresetInfo(band);
        } catch (e) {
          this.deps.log.debug(`${this.deviceId}: getTunerPresetInfo(${band}) failed: ${errText(e)}`);
        }
      }
      const update = parseYxcTunerPresetLists(byBand);
      if (update) {
        this.emit(update.id, update.value);
      }
      // One slot folder per list: the shared list flat, a separate band's list in a folder of its own — the
      // folder above the band folders only once a band has a list to put in it (an empty folder stood in the
      // tree for good once the runtime no longer removes anything, 2026-10-02).
      for (const [band, info] of Object.entries(byBand)) {
        const entries = stationSlotEntries(info);
        if (entries && !common && !this.slotCounts.has("tuner.storedStations")) {
          await this.deps.upsertObject(`${this.deviceId}.tuner.storedStations`, {
            id: "tuner.storedStations",
            type: "channel",
            common: { name: tName("storedStations"), desc: tName("descStoredStations") },
          });
          this.slotCounts.set("tuner.storedStations", 0);
        }
        if (entries) {
          await this.publishSlots(
            common ? "tuner.storedStations" : `tuner.storedStations.${band}`,
            common ? "storedStations" : "storedStationsBand",
            STATION_SLOT_FIELDS,
            entries,
            this.tunerFeatures?.presetNum,
            common ? "descStoredStations" : undefined,
            common ? undefined : band.toUpperCase(),
          );
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: stored stations failed: ${errText(e)}`);
    }
  }

  /**
   * Fetch the clock/alarm settings and write the clock states.
   *
   * @param via the client to ask through — the user-priority one for the read-back of a user write
   */
  private async refreshClock(via: YxcClientLike = this.deps.client): Promise<void> {
    try {
      for (const update of parseYxcClock(await via.getClockSettings())) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getClockSettings failed: ${errText(e)}`);
    }
  }

  /**
   * Refresh every player source the device offers (network player, cd, tuner).
   *
   * @returns the sources that answered
   */
  private async refreshMedia(): Promise<Set<string>> {
    // The three sources (netusb/cd/tuner) write disjoint states — fetch them together.
    const answers = await Promise.all(this.mediaBlocks.map(block => this.refreshMediaSource(block)));
    return new Set(this.mediaBlocks.filter((_block, i) => answers[i]));
  }

  /**
   * Fetch one media source's play info and write the parsed states with ack. The
   * source picks the getPlayInfo argument and the parser: netusb and cd share the
   * play-info shape (different channel), the tuner has its own band/frequency/RDS.
   *
   * @param block the media block (`netusb`, `cd`, `tuner`)
   * @param via the client to ask through — the user-priority one for the read-back of a user write
   * @returns whether the device answered
   */
  private async refreshMediaSource(block: string, via: YxcClientLike = this.deps.client): Promise<boolean> {
    const arg = block === "netusb" ? undefined : block;
    try {
      const info = await via.getPlayInfo(arg);
      if (block === "tuner") {
        for (const update of parseYxcTunerInfo(info)) {
          this.emit(update.id, update.value);
          if (update.id === "tuner.band") {
            this.lastTunerBand = String(update.value);
          }
        }
        return true;
      }
      const source: "netusb" | "cd" = block === "cd" ? "cd" : "netusb";
      this.routing.notePlayInfo(source, info);
      this.routing.route(source, parseYxcPlayInfo(info, source, this.cover));
      return true;
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayInfo(${arg ?? ""}) failed: ${errText(e)}`);
      return false;
    }
  }

  /**
   * One scene.list JSON per scene-capable zone (v2.0.0): every recall slot the zone
   * declares (getFeatures scene_num), titled from the shared per-device memory where
   * another transport reported titles (XML Scene_Sel_Item / YNCA SCENExNAME). A
   * MusicCast-only device has no title source and lists its slots with empty titles —
   * the COUNT is what its getFeatures declares (review finding: the promised list was
   * missing entirely on devices whose only transport is MusicCast).
   *
   * The recall datapoint gets the same title dropdown YNCA and XML give it: the titles another transport
   * reported, the number where there is none — names the user gives in the receiver, so `liveLabels` (review
   * 2026-10-05, parity: MusicCast's recall carried no states).
   *
   * @param capabilities the device's parsed getFeatures capabilities
   * @param objects the objects built for the device, the zones' recall datapoints among them
   */
  private async setupSceneLists(capabilities: YxcCapabilities, objects: readonly ObjectDef[]): Promise<void> {
    for (const zone of capabilities.zones) {
      if (!zone.funcs.includes("scene") || zone.sceneNum === undefined || zone.sceneNum <= 0) {
        continue;
      }
      const titles = new Map(knownScenes(this.deps.probeMemory, zone.id).map(scene => [scene.num, scene.title]));
      const list = Array.from({ length: zone.sceneNum }, (_unused, i) => ({
        num: i + 1,
        title: titles.get(i + 1) ?? "",
      }));
      const recall = objects.find(object => object.id === `${zonePrefix(zone.id)}scene.recall`);
      if (recall) {
        await this.deps.upsertObject(`${this.deviceId}.${recall.id}`, {
          ...recall,
          common: { ...recall.common, states: sceneRecallStates(list) },
          liveLabels: true,
        });
      }
      const surface = sceneListSurface(`${zonePrefix(zone.id)}scene`, list);
      for (const object of surface.objects) {
        await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
      }
      for (const { id, value } of surface.values) {
        this.emit(id, value);
      }
    }
  }

  /**
   * Fetch the MusicCast-Link distribution info and write the parsed dist states with ack,
   * caching the role for the leave-group path.
   *
   * @param via the client to ask through — the user-priority one inside a user's group change
   */
  private async refreshDistribution(via: YxcClientLike = this.deps.client): Promise<void> {
    try {
      const info = await via.getDistributionInfo();
      this.dist = distributionSummary(info);
      for (const update of parseYxcDistribution(info)) {
        this.emit(update.id, update.value);
      }
      const clients = clientSlotEntries(info);
      if (clients) {
        await this.publishSlots("multiroom.group.clients", "linkedDevices", CLIENT_SLOT_FIELDS, clients);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDistributionInfo failed: ${errText(e)}`);
    }
  }

  /**
   * Run a refresh at most once at a time per key, and once more after it when asked meanwhile — never
   * more. A knob turned twenty detents sends twenty events (YXC Basic Rev 1.10 §11.3); each was one
   * `getStatus` in the gate's queue, nineteen of them answering a state already gone (audit 2026-09-29,
   * C45). The last request always gets a fresh answer: it is either the running one's successor or
   * folded into it.
   *
   * @param key what is refreshed (`zone:main`, `media:netusb`)
   * @param run the refresh — its own failures are its business (both refreshes catch them)
   */
  private coalesced(key: string, run: () => Promise<unknown>): void {
    const state = this.refreshes.get(key);
    if (state) {
      state.again = true;
      return;
    }
    const entry = { again: false };
    this.refreshes.set(key, entry);
    const loop = async (): Promise<void> => {
      try {
        do {
          entry.again = false;
          await run();
        } while (entry.again && !this.deps.gate.closed);
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: refresh ${key} failed: ${errText(e)}`);
      } finally {
        this.refreshes.delete(key);
      }
    };
    void loop();
  }

  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @param via the client to ask through — the user-priority one for the read-back of a user write
   * @returns true if the device answered (with its status, or refusing it — it is there), false if
   *   nothing answered
   */
  private async refreshZone(zone: string, via: YxcClientLike = this.deps.client): Promise<boolean> {
    const answer = await this.fetchZoneStatus(zone, via);
    if (answer.kind !== "ok") {
      return answer.kind === "refused";
    }
    try {
      await this.learnVolumeMode(zone, answer.status);
      this.applyZoneStatus(zone, answer.status);
    } catch (e) {
      // A push handler calls this without awaiting it, so a rejection here would have no
      // receiver at all — js-controller turns an unhandled rejection into an adapter stop.
      // The return value answers "did the DEVICE answer", and it did: writing its answer into
      // the tree failing says nothing about the connection, so this must not report a drop.
      this.deps.log.warn(`${this.deviceId}: could not apply the ${zone} status (${errText(e)})`);
    }
    return true;
  }

  /**
   * Learn a zone's display scale at the first status that reports one. The scale was decided only in `start`, so a
   * zone whose status did not answer then stayed without one until the next reconnect: its datapoint showed the
   * DISPLAYED value (40.5 on the numeric scale) while a write went out as the raw step count — writing 45 sent
   * `setVolume(45)`, 22.5 instead of 90 steps, and −40 on the decibel scale was refused (review 2026-10-05, A15).
   * Learned once and remembered with the others, never replaced (a read-in receiver keeps its scale, krobi
   * 2026-10-02); until a status reports one, both directions stay on the raw step count the zone reports. The zone's
   * volume datapoint follows the learned scale, as it would have at `start`.
   *
   * @param zone the zone the status belongs to
   * @param status the raw getStatus answer
   */
  private async learnVolumeMode(zone: string, status: unknown): Promise<void> {
    const mode = actualVolumeModeOf(status);
    if (mode === undefined || this.zoneVolumeMode.get(zone) !== undefined) {
      return;
    }
    this.zoneVolumeMode.set(zone, mode);
    const learned = this.deps.probeMemory.remembered<Record<string, string>>(VOLUME_MODE_KEY) ?? {};
    if (learned[zone] === undefined) {
      this.deps.probeMemory.set(VOLUME_MODE_KEY, { ...learned, [zone]: mode });
    }
    if (this.capabilities === undefined) {
      return;
    }
    const prefix = zonePrefix(zone);
    for (const def of mapYxcToObjects(this.capabilities, { [zone]: { actualVolumeMode: mode } })) {
      if (def.id === `${prefix}volume` || def.id === `${prefix}advanced.maxVolume`) {
        await this.deps.upsertObject(`${this.deviceId}.${def.id}`, def);
      }
    }
  }

  /**
   * Fetch a zone's status, swallowing the failure of an absent zone or an offline device.
   *
   * @param zone the zone to ask
   * @param via the client to ask through
   * @returns the answer: the raw status, the device's refusal, or none
   */
  private async fetchZoneStatus(zone: string, via: YxcClientLike = this.deps.client): Promise<ZoneAnswer> {
    try {
      return { kind: "ok", status: await via.getStatus(zone) };
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${zone}) failed: ${errText(e)}`);
      // An answer that says no — its `response_code`, or an HTTP error status of a booting web server — is
      // proof the device is there; only silence is unreachable.
      return answeredByDevice(e) ? { kind: "refused", reason: errText(e) } : { kind: "unreachable" };
    }
  }

  /**
   * Write a zone's amp states from an already-fetched status.
   *
   * @param zone the zone the status belongs to
   * @param status the raw getStatus answer
   */
  private applyZoneStatus(zone: string, status: unknown): void {
    const flags = (status as { disable_flags?: unknown } | null)?.disable_flags;
    this.disabledFlags.set(zone, typeof flags === "number" ? flags : 0);
    // The display scale decides the BOUNDS and the unit of the volume datapoint, so the object
    // has to carry the new scale BEFORE the new value is written. The status updates are emitted
    // in catalog order, which puts the value ahead of any mode information — reshaping from inside
    // that loop (and as a fire-and-forget promise) let a numeric value land in an object still
    // declaring decibels, which is the js-controller warning 2.7.2 set out to end. So the mode is
    // read from the RAW answer first and the reshape is awaited.
    // The datapoint keeps the scale it was read in on (see start); a status on the other scale — the display
    // was switched at the receiver — is converted from the raw step count instead of rebuilding the datapoint.
    const mode = actualVolumeModeOf(status);
    const learned = this.zoneVolumeMode.get(zone);
    const otherScale = mode !== undefined && learned !== undefined && mode !== learned;
    const asShown = this.displayedVolumeIn(zone, status, otherScale);
    const updates = parseYxcStatus(status, zone);
    for (const update of updates) {
      // A zone can declare a display scale and still answer a status without `actual_volume` —
      // the RX-A2070 declares decibels for all three zones and reports them for main only. The
      // catalog then falls back to the raw step count, which would put 66 into a datapoint
      // bounded -80.5…0.0 dB: the js-controller warning on every poll, one zone over. The zone's
      // own declared step says what 66 reads as on the scale it declares.
      if (asShown !== undefined && update.id === `${zonePrefix(zone)}volume`) {
        this.emit(update.id, asShown);
        continue;
      }
      // On the other scale and without a raw step count to convert from: no value rather than one in the
      // wrong unit.
      if (otherScale && update.id === `${zonePrefix(zone)}volume`) {
        continue;
      }
      // The maximum on the same scale as the volume it limits (audit 2026-09-29, C40).
      if (update.id === `${zonePrefix(zone)}advanced.maxVolume` && typeof update.value === "number") {
        const scale = this.volumeScale(zone);
        this.emit(update.id, scale ? shownVolumeFor(scale, update.value) : update.value);
        continue;
      }
      this.emit(update.id, update.value);
      // A zone in standby listens to nothing — a recall must not go there (review 2026-10-05, A45).
      if (update.id === `${zonePrefix(zone)}power` && typeof update.value === "boolean") {
        this.routing.notePower(zone, update.value);
      }
      // The EXACT id, not a suffix: this value decides which source a zone's player block
      // and its transport buttons follow. A future status field ending in "input" would
      // have bent that routing silently.
      if (update.id === `${zonePrefix(zone)}input` && typeof update.value === "string") {
        const previous = this.routing.noteInput(zone, update.value);
        if (previous === "mc_link" && update.value !== "mc_link" && this.dist.role === "client") {
          this.group.leaveAfterInputChange();
        }
        if (previous !== update.value) {
          // The zone changed its input — re-target its player block NOW. Media
          // pushes alone cannot cover this: a zone leaving a still-playing source
          // (or joining one another zone already plays) changes nothing about the
          // source itself, so no netusb/cd push ever arrives (2.0.0 review finding). The joined
          // source's play info is read right away, so the block fills now, not at the next sweep.
          const joined = this.routing.retarget(zone);
          if (joined !== undefined) {
            void this.refreshMediaSource(joined);
          }
        }
      }
    }
    this.cacheEqualizer(zone, updates);
  }

  /**
   * A zone's raw step count expressed on the scale it declares, for a status that omits
   * `actual_volume`.
   *
   * Only where the zone declares exactly ONE scale: a zone declaring both and reporting neither
   * is not on a settled scale, so its datapoint keeps the raw step count and the envelope bounds
   * that go with it.
   *
   * @param zone the zone the status belongs to
   * @param status the raw getStatus answer
   * @param otherScale the zone reports the scale its datapoint was NOT read in on — converted from the raw count
   * @returns the displayed value, or undefined when the device already reported one (its own word
   *   comes first) or no scale is settled
   */
  private displayedVolumeIn(zone: string, status: unknown, otherScale = false): number | undefined {
    if (typeof status !== "object" || status === null) {
      return undefined;
    }
    const answer = status as { volume?: unknown; actual_volume?: unknown };
    if (typeof answer.volume !== "number" || (typeof answer.actual_volume === "object" && !otherScale)) {
      return undefined;
    }
    const scale = this.volumeScale(zone);
    return scale ? shownVolumeFor(scale, answer.volume) : undefined;
  }

  /**
   * The scale a zone's volume datapoint is on right now.
   *
   * Read from the zone's own declarations, not measured: both ends and both steps stand in
   * `getFeatures`, and the relation between them is affine (see {@link volumeScaleOf}).
   *
   * @param zone the zone being read or written
   * @returns the scale, or undefined while the zone declares none the adapter can settle
   */
  private volumeScale(zone: string): VolumeScale | undefined {
    const declared = this.capabilities?.zones.find(z => z.id === zone);
    return declared ? volumeScaleOf(declared, this.zoneVolumeMode.get(zone)) : undefined;
  }

  /**
   * Cache a zone's equalizer bands from its status updates, so a later single-band
   * write can send setEqualizer with all three (the device sets them together).
   *
   * @param zone the zone the updates belong to
   * @param updates the parsed status updates for that zone
   */
  private cacheEqualizer(zone: string, updates: StateValue[]): void {
    // Same definition the status parser uses — see lib/yxc/zones.ts on why this must not
    // be spelled out a second time.
    const prefix = zonePrefix(zone);
    const band = (b: string): number | undefined => {
      const u = updates.find(x => x.id === `${prefix}sound.equalizer.${b}`);
      return typeof u?.value === "number" ? u.value : undefined;
    };
    const low = band("low");
    const mid = band("mid");
    const high = band("high");
    if (low === undefined && mid === undefined && high === undefined) {
      return;
    }
    const cur = this.lastEqualizer.get(zone);
    if (!cur) {
      // No cache yet: only a COMPLETE triple may seed it. Filling the gaps with 0 would hand
      // the write path exactly the invented 0/0/0 it refuses to send — that safeguard only
      // works if this cache never lies about a band.
      if (low === undefined || mid === undefined || high === undefined) {
        return;
      }
      this.lastEqualizer.set(zone, { low, mid, high });
      return;
    }
    this.lastEqualizer.set(zone, { low: low ?? cur.low, mid: mid ?? cur.mid, high: high ?? cur.high });
  }

  /**
   * Apply a mapped command: put it on the wire ({@link sendCommand}, which completes the
   * declarative kinds from controller-held state), then see that the datapoint shows what
   * the device did — confirmed by its event or read back, and read back after a refusal too.
   *
   * @param stateId the written state id, for the failure log line
   * @param command the YXC command to apply
   * @param written the value that was written, when the state mirrors a device value
   * @returns what the device made of the command
   */
  private async applyCommand(stateId: string, command: YxcCommand, written?: unknown): Promise<WriteOutcome> {
    // `sendCommand` answers every failure itself, so nothing rejects out of here (the outer guard that
    // stood here could not be reached — review 2026-10-05, G).
    const outcome = await this.sendCommand(stateId, command);
    // Confirmed behind the answer, so the caller learns at once what the device made of the command.
    void (async () => {
      try {
        if (outcome === "sent") {
          await this.confirmWrite(stateId, command, written);
        } else if (outcome === "refused") {
          // The device said no: the datapoint still shows the refused value, and no event will
          // correct it (nothing changed) — read what the device kept (audit 2026-09-24, C28).
          await this.readBackAfter(stateId, command);
        }
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: confirming the write to ${stateId} failed: ${errText(e)}`);
      }
    })();
    return outcome;
  }

  /**
   * Put one command on the wire.
   *
   * @param stateId the written state id, for the failure log line
   * @param command the YXC command to apply
   * @returns whether the device took it, refused it (an answer: its `response_code` or an HTTP error status),
   *   or it could not be sent — nobody answered, or this controller dropped it (a failure is logged here)
   */
  private async sendCommand(stateId: string, command: YxcCommand): Promise<WriteOutcome> {
    try {
      switch (command.kind) {
        case "run":
          await command.run(this.deps.client);
          break;
        case "equalizer": {
          // The device sets all three bands in one call, so the other two come from the
          // cache. Without a cached set we must NOT invent 0/0/0 — that would silently
          // flatten the user's other two bands. The cache fills from a zone status, so
          // fetch one first; only if even that fails is the write refused (with a warning).
          const { zone, band, value } = command;
          let current = this.lastEqualizer.get(zone);
          if (!current) {
            await this.refreshZone(zone, this.userClient);
            current = this.lastEqualizer.get(zone);
          }
          if (!current) {
            this.deps.log.warn(
              `${this.deviceId}: not writing ${stateId} — the device has not reported its equalizer bands yet`,
            );
            return "unavailable";
          }
          const next = { ...current, [band]: value };
          // Cache BEFORE the round-trip: a second band written straight afterwards
          // reads this cache at dispatch — caching after the await would make it
          // compute from the pre-write triple and undo this band on the device.
          this.lastEqualizer.set(zone, next);
          await this.deps.client.setEqualizer(next.low, next.mid, next.high, zone);
          break;
        }
        case "tunerBand":
          // Remember it BEFORE the round-trip: a frequency written straight afterwards
          // reads this cache synchronously at dispatch, while the band call may still
          // be in flight — and the poll that would report it back runs minutes later.
          this.lastTunerBand = command.band;
          await this.deps.client.setBand(command.band);
          break;
        case "tunerFreq":
          // setFreq knows only "am" and "fm" (YXC Basic §6.4): on DAB the write goes nowhere — the
          // datapoint gets the device's value back, and the service buttons choose a station (C17).
          if (this.lastTunerBand === "dab") {
            this.deps.log.debug(`${this.deviceId}: ${stateId} — DAB is tuned by service, not by frequency; not sent`);
            if (this.mediaBlocks.includes("tuner")) {
              await this.refreshMediaSource("tuner", this.userClient);
            }
            return "unavailable";
          }
          await this.deps.client.setFreq(this.lastTunerBand, command.value);
          break;
        case "tunerPreset": {
          // Shared-list devices recall on `common`; separate-list devices on the current band.
          const band = this.tunerFeatures?.presetType === "common" ? "common" : this.lastTunerBand;
          await this.deps.client.recallTunerPreset(band, command.value, this.routing.recallZone("tuner"));
          break;
        }
        case "tunerClear": {
          // A shared list is cleared on `common`, a separate one on the current band (Basic §6.8).
          const band = this.tunerFeatures?.presetType === "common" ? "common" : this.lastTunerBand;
          await this.deps.client.clearTunerPreset(band, command.value);
          break;
        }
        case "tunerSearch":
          // AM/FM search the next receivable frequency; DAB steps the service (Basic §6.4/§6.15).
          if (this.lastTunerBand === "dab") {
            await this.deps.client.setDabService(command.direction === "up" ? "next" : "previous");
          } else {
            await this.deps.client.searchTuner(
              this.lastTunerBand,
              command.direction === "up" ? "auto_up" : "auto_down",
            );
          }
          break;
        case "netusbPreset":
          this.lastPresetRecall = { num: command.value, at: Date.now() };
          await this.deps.client.recallPreset(command.value, this.routing.recallZone(this.routing.networkSource));
          break;
        case "netusbRecent":
          await this.deps.client.recallRecentItem(command.value, this.routing.recallZone(this.routing.networkSource));
          break;
        case "volume": {
          // A zone without a settled display scale carries the device's own step count already
          // (speakers, soundbars, and a receiver declaring both scales while reporting neither),
          // so the value goes out as it stands.
          const scale = this.volumeScale(command.zone);
          const raw = scale ? rawVolumeFor(scale, command.value) : command.value;
          await this.deps.client.setVolumeTo(raw, command.zone);
          break;
        }
        case "playerTransport":
        case "playerMode": {
          // The unified block's keys and modes act on whatever the ZONE is playing (v2.0.0).
          const call =
            command.kind === "playerTransport"
              ? this.routing.transport(command.zone, command.action)
              : this.routing.mode(command.zone, this.apiVersion, command);
          if ("notSent" in call) {
            this.deps.log.debug(`${this.deviceId}: ${stateId} not sent — ${call.notSent}`);
            return "unavailable";
          }
          await call.run(this.deps.client);
          break;
        }
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: write to ${stateId} failed: ${errText(e)}`);
      this.checkAliveAfter(e);
      return answeredByDevice(e) ? "refused" : "unavailable";
    }
    return "sent";
  }

  /** Whether events are to be relied on: the socket is bound and this device's events arrive. */
  private pushWorking(): boolean {
    return this.deps.pushActive?.() === true && this.deps.pushLiveness.state !== "dead";
  }

  /**
   * A change the device made without an event (see PushLiveness). Only counted while the socket is
   * bound — without it no event can come, and the poll covers everything anyway.
   */
  private noteMiss(): void {
    if (this.deps.pushActive?.() && this.deps.pushLiveness.noteMiss()) {
      this.deps.log.info(`${this.deviceId}: MusicCast events are not arriving — polling and reading writes back`);
    }
  }

  /**
   * See that the device's datapoint shows what a write did.
   *
   * Without working events, and for a zone 2–4 write (those events are "Reserved" in YXC Basic
   * Rev 1.00 §10.3, documented from Rev 1.10 §11.3 — firmware of either revision is in the field), the
   * written area is read back at once. A write of the value the device already
   * has is read back at once too: the device announces only a CHANGE, so no event would ever confirm
   * it. A changing write of a reported main-zone or tuner value waits for the event; when none comes,
   * the area is read back — and only if that shows the value changed did the device change it without
   * telling (a write it accepted and did not carry out, in standby say, changes nothing and judges
   * nothing; audit 2026-09-24, C1).
   *
   * @param stateId the written state id, relative to the device
   * @param command the command that was applied
   * @param written the written value, when the state mirrors a device value
   */
  private async confirmWrite(stateId: string, command: YxcCommand, written: unknown): Promise<void> {
    if (!this.pushWorking() || splitZone(stateId).zone !== "main") {
      await this.readBackAfter(stateId, command);
      return;
    }
    const before = this.deviceValues.get(stateId);
    if (written === undefined || before === undefined || !ANNOUNCED_KINDS.has(command.kind)) {
      return;
    }
    if (sameValue(before, written)) {
      await this.readBackAfter(stateId, command);
      return;
    }
    const gate = this.deps.gate;
    const events = this.pushEvents;
    await gate.delay(PUSH_EXPECT_MS);
    if (gate.closed || this.pushEvents !== events) {
      return;
    }
    await this.readBackAfter(stateId, command);
    if (this.pushEvents === events && this.deviceValues.get(stateId) !== before) {
      this.noteMiss();
    }
  }

  /**
   * Read the area a write touched back from the device (see {@link confirmWrite} for when).
   *
   * @param stateId the written state id, relative to the device (carries the zone prefix)
   * @param command the command that was just applied
   */
  private async readBackAfter(stateId: string, command: YxcCommand): Promise<void> {
    const via = this.userClient;
    switch (command.kind) {
      case "tunerFreq":
      case "tunerPreset":
      case "tunerBand":
      case "tunerSearch":
        if (this.mediaBlocks.includes("tuner")) {
          await this.refreshMediaSource("tuner", via);
        }
        return;
      case "tunerClear":
        await this.refreshTunerPresets(via);
        return;
      case "netusbPreset":
      case "netusbRecent":
        if (this.mediaBlocks.includes("netusb")) {
          await this.refreshMediaSource("netusb", via);
        }
        return;
      case "playerTransport":
      case "playerMode": {
        const block = this.routing.blockOf(command.zone);
        if (block !== undefined) {
          await this.refreshMediaSource(block, via);
        }
        return;
      }
      case "volume":
      case "equalizer":
        await this.refreshZone(command.zone, via);
        return;
      case "run": {
        if (command.source === "clock") {
          await this.refreshClock(via);
          return;
        }
        if (command.source === "favourites") {
          await this.refreshNetusbPresets(via);
          return;
        }
        if (command.source === "stations") {
          await this.refreshTunerPresets(via);
          return;
        }
        if (command.source !== undefined) {
          if (this.mediaBlocks.includes(command.source)) {
            await this.refreshMediaSource(command.source, via);
          }
          return;
        }
        const { zone } = splitZone(stateId);
        if (this.zones.includes(zone)) {
          await this.refreshZone(zone, via);
        }
        return;
      }
    }
  }
}

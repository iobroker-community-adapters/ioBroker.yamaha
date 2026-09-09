import { channelCommon, type ObjectDef } from "../catalog/types";
import { tName } from "../i18n";
import {
  isPermanentXmlRefusal,
  parseDescriptor,
  parseInputList,
  parseReturnCode,
  parseSceneList,
  parseTunerInfo,
  type BasicStatus,
  type XmlDescriptor,
  type XmlDialect,
  type XmlScene,
  type XmlSystemConfig,
} from "./protocol";
import { parseXmlStatus, stateToXml, type XmlCommand } from "./command-mapper";
import { XML_AMP_CATALOG } from "./catalog";
import type { ConnectionHandle, ControllerLog } from "../controller";
import { errorMessage } from "../util";
import { PollDropDetector } from "../lifecycle/poll-drop-detector";
import type { ProbeMemory } from "../lifecycle/probe-memory";
import type { CommandGate } from "../lifecycle/command-gate";
import type { BrowseEngine } from "../browse/browse-engine";
import { createBrowseSurface } from "../browse/surface";
import { XML_BROWSE_SOURCES, XML_CURSOR_WIRE, XML_MENU_WIRE, XmlBrowseDriver } from "../browse/xml-browse-driver";
import { wireFor } from "../browse/types";
import { decodeXmlText, escapeXmlText } from "./entities";

/** XML/YNC has no push channel, so the state is polled at this interval by default. */
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

interface XmlZone {
  /** Unified zone key (`main`, `zone2`, …). */
  key: string;
  /** XML zone element — also the key of its `Feature_Existence` flag in System/Config. */
  element: "Main_Zone" | "Zone_2" | "Zone_3" | "Zone_4";
  /** State-id prefix for the zone. */
  prefix: string;
}

/** The transport keys of `Play_Control,Playback` and their wire words (desc.xml, RX-V675 & co). */
const XML_TRANSPORT_WIRE: Record<string, string> = {
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  next: "Skip Fwd",
  prev: "Skip Rev",
};

/** The transport keys' display names (the player block's own keys). */
const XML_TRANSPORT_NAME_KEYS: Record<string, "play" | "pause" | "stop" | "next" | "previous"> = {
  play: "play",
  pause: "pause",
  stop: "stop",
  next: "next",
  prev: "previous",
};

const XML_ZONES: XmlZone[] = [
  { key: "main", element: "Main_Zone", prefix: "" },
  { key: "zone2", element: "Zone_2", prefix: "multiroom.zone2." },
  { key: "zone3", element: "Zone_3", prefix: "multiroom.zone3." },
  { key: "zone4", element: "Zone_4", prefix: "multiroom.zone4." },
];

/** The subset of the XML client the controller uses (so tests can inject a fake). */
export interface XmlClientLike {
  /** Read a zone's Basic_Status. */
  getStatus(zone: string): Promise<BasicStatus>;
  /** Read the device's declaration of itself (System > Config): model, identity, zones, sources, input names. */
  getSystemConfig(): Promise<XmlSystemConfig>;
  /** Read the raw device description (`desc.xml`); absent on older fakes → no description is read. */
  getDescriptor?(): Promise<string>;
  /** Send an inner command to a zone. */
  send(zone: string, inner: string): Promise<void>;
  /** Read an element's inner GET request and return the raw response body. */
  getXml(element: string, inner: string): Promise<string>;
}

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface XmlControllerDeps {
  /** The XML client for this device. */
  client: XmlClientLike;
  /** Schedule the keepalive poll; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter log. */
  log: ControllerLog;
  /**
   * The device's command gate: every request is paced through it, and its signal is the
   * connection's shutdown flag — a closed gate ends pending waits and stops state writes
   * from a poll that was already in flight. Absent in older tests → no browsing.
   */
  gate?: CommandGate;
  /** Per-device memory for answers that do not change while the device runs (see ProbeMemory). */
  probeMemory?: ProbeMemory;
}

/**
 * Drives one XML/YNC device: probe which zones answer, build the amp tree, seed
 * state, and route commands both ways. XML has no push, so state is refreshed by
 * a keepalive poll. Create-only.
 */
export class XmlDeviceController implements ConnectionHandle {
  private zones: XmlZone[] = [];
  private cancelKeepalive: (() => void) | undefined;
  private readonly dropDetector = new PollDropDetector();
  private browseEngine: BrowseEngine | undefined;
  /** The scenes each zone DECLARES (`Scene_Sel_Item`), for the recall write path. */
  private readonly scenesByZone = new Map<string, XmlScene[]>();
  /** Whether the device answers `<Tuner><Play_Info>` (the classic pre-2010 tuner). */
  private hasTuner = false;
  /** The amp state ids this controller actually created — the claim-with-proof gate for BOTH ways. */
  private readonly createdStates = new Set<string>();
  /** Channel ids already created — shared by the start-up build and the mid-session growth. */
  private readonly createdChannels = new Set<string>();
  /** The per-zone `Input_Sel_Item` lists and the device description, kept for a mid-session build. */
  private inputsByZone: ReadonlyMap<string, string[]> = new Map();
  private deviceDescriptor: XmlDescriptor = { programs: [], sleep: [], adaptiveDrc: [] };
  /**
   * The spelling this device answers its amplifier block with (see XmlDialect) — learned from
   * the first status that carries one, remembered as `xmlDialect` (a property of the model,
   * dropped with the XML identity), and put on every write. Undefined = classic.
   */
  private dialect: XmlDialect | undefined;
  /** Per zone: the Basic_Status fields this device is known to deliver (persisted union). */
  private readonly zoneFields = new Map<string, Set<string>>();
  /**
   * The zone commands desc.xml declares (zone elements): the zone-wide cursor pad and menu keys,
   * the transport keys. Read from the device description, so a receiver that declares none
   * (the 2012 entry class) offers none.
   */
  private zoneCommands: { cursor: Set<string>; menu: Set<string>; playback: Set<string> } = {
    cursor: new Set(),
    menu: new Set(),
    playback: new Set(),
  };

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   * @param pollIntervalMs how often to poll the device for state (default 60 s)
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: XmlControllerDeps,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  /**
   * Probe each zone, create the tree for the ones that answer, seed state, and
   * start the keepalive poll.
   *
   * @returns true if the main zone answered and the tree was created
   */
  public async start(): Promise<boolean> {
    // The receiver's own declaration of itself comes FIRST — one request the adapter used to
    // make for the model name alone. `Feature_Existence` says which zones exist (2012+), so
    // absent zones are not probed; System_ID + Version identify the unit, so a firmware update
    // re-reads what the memory holds. A failed read (transient, or the 2008 generation without
    // the block) falls back to probing every zone, exactly as before.
    let config: XmlSystemConfig = {};
    try {
      config = await this.deps.client.getSystemConfig();
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: System/Config failed (${errorMessage(e)})`);
    }
    // Freshness guard for the (persisted) probe memory: model + system id + firmware are the
    // identity this transport can read. A different (or updated) device behind the address
    // drops the remembered XML declarations (scenes, inputs, descriptor, tuner, browse
    // sources); a device that reports no model keeps them — the YNCA/YXC guards catch a swap.
    if (this.deps.probeMemory && config.model !== undefined) {
      const identity = `${config.model}|${config.systemId ?? ""}|${config.version ?? ""}`;
      if (this.deps.probeMemory.remembered("xmlIdentity") !== identity) {
        // Every XML-owned memory key carries the xml prefix (xmlBrowseSources, xmlScenes:*,
        // xmlInputs:*, xmlTuner, xmlConfig, xmlIdentity).
        this.deps.probeMemory.drop(key => key.startsWith("xml"));
        this.deps.probeMemory.set("xmlIdentity", identity);
      }
      if (config.zones || config.features || config.inputNames) {
        // Remembered for the other transports: the YNCA input list reads the source flags and
        // the input names as evidence (a flag 0 proves a source absent, a name adds an input).
        this.deps.probeMemory.set("xmlConfig", config);
      }
    }
    const rememberedDialect = this.deps.probeMemory?.remembered("xmlDialect");
    if (rememberedDialect === "classic" || rememberedDialect === "legacy") {
      this.dialect = rememberedDialect;
    }
    // Zones flagged 0 are not probed. Guards (advisor round 2026-09-09): a block that flags the
    // MAIN zone 0, or no block at all (2008 generation), probes every zone as before; a zone
    // flagged 1 whose Basic_Status then fails is simply absent — no contradiction to log.
    const declaredZones = config.zones;
    const candidates =
      declaredZones && declaredZones.Main_Zone !== false
        ? XML_ZONES.filter(zone => declaredZones[zone.element] !== false)
        : XML_ZONES;
    // Probe the candidate zones in parallel and keep each answering zone's status, so a zone
    // is fetched once (for the probe) and seeded from that same response — not twice.
    const probes = await Promise.all(
      candidates.map(async zone => ({ zone, status: await this.tryGetStatus(zone.element) })),
    );
    const answered = probes.filter(probe => probe.status && Object.keys(probe.status).length > 0);
    if (!answered.some(probe => probe.zone.key === "main")) {
      this.deps.log.debug(`${this.deviceId}: no XML main zone — creating no objects`);
      return false;
    }
    this.zones = answered.map(probe => probe.zone);
    const model = config.model;
    // The zone's own input list (`Input_Sel_Item`, per zone — Main and Zone 2 differ on
    // real hardware): the device says which inputs it accepts, so the input state gets a
    // dropdown instead of a free string. Constant per model — remembered per device.
    const inputsByZone = new Map<string, string[]>();
    for (const zone of this.zones) {
      const body = await this.probeXml(
        `xmlInputs:${zone.key}`,
        zone.element,
        "<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>",
      );
      inputsByZone.set(zone.key, parseInputList(body));
    }
    // The device description — the classic generation's own enumeration of programs, sleep
    // steps, Adaptive DRC values and the dialogue range (2012–2017; the 2020 generation has none).
    const descriptor = await this.probeDescriptor();
    this.zoneCommands = {
      cursor: new Set(descriptor.cursorZones ?? []),
      menu: new Set(descriptor.menuZones ?? []),
      playback: new Set(descriptor.playbackZones ?? []),
    };
    // Claim with proof, XML edition (2.0.1): only the states whose Basic_Status field
    // this device DELIVERS are created — a blind full-catalog rollout left valueless
    // objects (hdmi.out2, sound.direct, …) standing on devices without the feature.
    // The delivered field set is a model property, remembered per zone (union, so a
    // later standby start — which may report fewer fields — cannot shrink the tree).
    for (const { zone, status } of answered) {
      const key = `xmlStatusFields:${zone.key}`;
      const remembered = this.deps.probeMemory?.remembered<string[]>(key);
      const fields = new Set<string>(Array.isArray(remembered) ? remembered : []);
      for (const field of Object.keys(status ?? {})) {
        fields.add(field);
      }
      this.deps.probeMemory?.set(key, [...fields]);
      this.zoneFields.set(zone.key, fields);
    }
    // Every parent — the zone channels included — is created by the per-state loop below
    // and named from the shared channel table (a zone that answered has at least
    // its power state, so its channel always comes into being this way).
    this.inputsByZone = inputsByZone;
    this.deviceDescriptor = descriptor;
    const createdChannels = this.createdChannels;
    for (const zone of this.zones) {
      await this.createZoneStates(zone);
    }
    await this.setupScenes(createdChannels);
    await this.setupTuner(createdChannels);
    await this.setupTransportKeys(createdChannels);
    await this.setupZoneNames(createdChannels);
    // Seed from the statuses already fetched during the probe — no second round-trip.
    for (const { zone, status } of answered) {
      if (status) {
        this.seedZone(zone, status);
      }
    }
    // The model name (already read by the freshness guard) for the device-manager card.
    // Best-effort — a device that does not report it still connects, the line stays empty.
    if (model) {
      // The info channel and info.model already exist — the adapter creates them for
      // every device up front, so the card renders even while the device is offline.
      this.emit("info.model", model);
    }
    await this.setupBrowse();
    // The zone pads AFTER the browse surface: where a menu source exists the surface owns the
    // main zone's pad (zone-wide through the driver where declared), the controller adds the
    // zones' — and the main zone's on a receiver without a menu source.
    await this.setupZonePads();
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), this.pollIntervalMs);
    // The adapter logs one combined "ready" line across all transports; this stays at debug.
    this.deps.log.debug(`${this.deviceId}: Yamaha (XML) device ready (XML)`);
    return true;
  }

  /**
   * Read one element's list once per device: the answer is a property of the MODEL
   * (input lists, scene declarations), so reconnects reuse it via the probe memory.
   *
   * Only a DEFINITE answer is remembered: a body, or the model's own "no such node"
   * (bodyless HTTP 400 / return code 2, both captured on the RX-V6A) as "declares none".
   * A transient failure — timeout, connection error, HTTP 5xx, or a state-dependent
   * refusal (return code 3/4, "not now") — is NOT remembered: before this, one busy
   * moment during the first contact recorded "no scenes" for that device for good, until
   * the model changed. Now it is simply asked again on the next connect.
   *
   * @param key the probe-memory key
   * @param element the XML element to ask
   * @param inner the inner GET request
   * @returns the raw response body, or "" when the device (definitely or for now) has none
   */
  /**
   * The list the device declares for a state, if any: the zone's `Input_Sel_Item` inputs, the
   * description's programs (main zone — the classic generation runs one program), its sleep
   * steps (every zone, same words) and its Adaptive DRC values.
   *
   * @param state the unified state id (without the zone prefix)
   * @param zoneKey the zone (`main`, `zone2`, …)
   * @param inputsByZone the per-zone input lists read from `Input_Sel_Item`
   * @param descriptor the parsed device description
   * @returns the declared values, or undefined where the device declares none
   */
  private declaredListFor(
    state: string,
    zoneKey: string,
    inputsByZone: ReadonlyMap<string, string[]>,
    descriptor: XmlDescriptor,
  ): string[] | undefined {
    switch (state) {
      case "input":
        return inputsByZone.get(zoneKey);
      case "soundProgram":
        return zoneKey === "main" ? descriptor.programs : undefined;
      case "sleep":
        return descriptor.sleep;
      case "sound.adaptiveDrc":
        return descriptor.adaptiveDrc;
      default:
        return undefined;
    }
  }

  /**
   * Read the device description once per device — a model property, remembered like the
   * other declarations. A 404 (the 2020 generation) is the definite "declares none" and is
   * remembered as the empty declaration; a transient failure is not remembered, so the next
   * connect asks again. A client without the read (older fakes) declares none.
   *
   * @returns the parsed description (empty lists where the device carries none)
   */
  private async probeDescriptor(): Promise<XmlDescriptor> {
    const empty: XmlDescriptor = { programs: [], sleep: [], adaptiveDrc: [] };
    const client = this.deps.client;
    if (!client.getDescriptor) {
      return empty;
    }
    const probe = async (): Promise<XmlDescriptor> => {
      try {
        return parseDescriptor(await client.getDescriptor!());
      } catch (e) {
        if (isPermanentXmlRefusal(e)) {
          return empty; // this generation has no description — definite
        }
        throw e; // transient — not remembered
      }
    };
    try {
      return this.deps.probeMemory ? await this.deps.probeMemory.once("xmlDescriptor", probe) : await probe();
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: desc.xml probe failed, asking again on the next connect (${errorMessage(e)})`,
      );
      return empty;
    }
  }

  private async probeXml(key: string, element: string, inner: string): Promise<string> {
    const probe = async (): Promise<string> => {
      let body: string;
      try {
        body = await this.deps.client.getXml(element, inner);
      } catch (e) {
        if (isPermanentXmlRefusal(e)) {
          return ""; // the model has no such node — definite
        }
        throw e; // transient — not remembered
      }
      const rc = parseReturnCode(body);
      if (rc !== undefined && rc !== 0) {
        if (rc === 2) {
          return ""; // RC 2 = the node does not exist on this model — definite
        }
        throw new Error(`device refused ${element} probe (RC=${rc})`); // "not now" — not remembered
      }
      return body;
    };
    try {
      return this.deps.probeMemory ? await this.deps.probeMemory.once(key, probe) : await probe();
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: ${key} probe failed, asking again on the next connect (${errorMessage(e)})`,
      );
      return "";
    }
  }

  /**
   * Build the scene surface from the device's OWN declaration (#615): each zone's
   * `<Scene_Sel_Item>` names the scenes that exist, their titles and the write value
   * (`Scene N` via `<Scene_Sel>`). The predecessor blindly sent `Scene_Load` to a
   * fixed 1..12 main-zone state; the capture shows the device declaring `Scene_Sel`
   * instead — and declaring scenes for Zone 2 too.
   *
   * @param createdChannels the channel ids already created (extended here)
   */
  private async setupScenes(createdChannels: Set<string>): Promise<void> {
    for (const zone of this.zones) {
      const body = await this.probeXml(
        `xmlScenes:${zone.key}`,
        zone.element,
        "<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>",
      );
      const scenes = parseSceneList(body);
      if (scenes.length === 0) {
        continue;
      }
      this.scenesByZone.set(zone.key, scenes);
      const channelId = `${zone.prefix}scene`;
      if (!createdChannels.has(channelId)) {
        createdChannels.add(channelId);
        await this.deps.upsertObject(`${this.deviceId}.${channelId}`, {
          id: channelId,
          type: "channel",
          common: channelCommon("scene"),
        });
      }
      const max = Math.max(...scenes.map(scene => scene.num));
      await this.deps.upsertObject(`${this.deviceId}.${channelId}.recall`, {
        id: `${channelId}.recall`,
        type: "state",
        common: {
          name: tName("recallScene"),
          desc: tName("descRecallScene"),
          type: "number",
          role: "level",
          read: true,
          write: true,
          min: 1,
          max,
          step: 1,
          // The declared titles as the dropdown, so the picker shows "Movie Viewing",
          // not a bare number.
          states: Object.fromEntries(scenes.map(scene => [scene.num, scene.title])),
        },
      });
      // ONE list state instead of a name datapoint per scene (v2.0.0): visualizations
      // read titles as VALUES (button captions — the #613 reporter's setup), and a
      // dropdown's labels are not readable, so the list carries them.
      await this.deps.upsertObject(`${this.deviceId}.${channelId}.list`, {
        id: `${channelId}.list`,
        type: "state",
        common: {
          name: tName("scenesNumberTitle"),
          desc: tName("descScenesNumberTitle"),
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
      });
      this.emit(`${channelId}.list`, JSON.stringify(scenes));
    }
  }

  /**
   * Build the classic tuner surface (pre-2010 devices, where XML is the ONLY
   * transport — the predecessor served their tuner, the rewrite had dropped it).
   * Existence is probed once per device; the preset write is the openHAB-verified
   * `<Play_Control><Preset><Preset_Sel>`; frequency/RDS/tuned are read-only from
   * Play_Info. On newer devices YNCA/YXC own these ids via the owner policy.
   *
   * @param createdChannels the channel ids already created (extended here)
   */
  private async setupTuner(createdChannels: Set<string>): Promise<void> {
    const probe = await this.probeXml("xmlTuner", "Tuner", "<Play_Info>GetParam</Play_Info>");
    if (probe.length === 0) {
      return;
    }
    this.hasTuner = true;
    if (!createdChannels.has("tuner")) {
      createdChannels.add("tuner");
      await this.deps.upsertObject(`${this.deviceId}.tuner`, {
        id: "tuner",
        type: "channel",
        common: channelCommon("tuner"),
      });
    }
    const state = async (id: string, common: ObjectDef["common"]): Promise<void> => {
      await this.deps.upsertObject(`${this.deviceId}.tuner.${id}`, { id: `tuner.${id}`, type: "state", common });
    };
    await state("preset", {
      name: tName("presetRecallByNumber"),
      desc: tName("descPresetRecallByNumber"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      // Slot 1 upwards — `handleTunerWrite` drops a 0, so offering it as the lower bound
      // invited a write that goes nowhere.
      min: 1,
      max: 40,
      step: 1,
    });
    await state("frequency", {
      name: tName("frequency"),
      type: "number",
      role: "value",
      unit: "kHz",
      read: true,
      write: false,
    });
    await state("rdsService", {
      name: tName("rdsStation"),
      desc: tName("descRdsStation"),
      type: "string",
      role: "text",
      read: true,
      write: false,
    });
    await state("rdsText", {
      name: tName("rdsText"),
      desc: tName("descRdsText"),
      type: "string",
      role: "text",
      read: true,
      write: false,
    });
    await state("tuned", {
      name: tName("tunedToAStation"),
      desc: tName("descTunedToAStation"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    });
    await state("stereo", {
      name: tName("stereoReception"),
      desc: tName("descStereoReception"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    });
    // NOT `emitTunerInfo(probe)`: the probe body comes out of the PERSISTED memory on every
    // reconnect and restart, so seeding from it published a snapshot of an earlier session
    // — frequency, RDS station and text, "tuned" — as the CURRENT reading, until the first
    // poll up to a whole interval later. The existence verdict is a model property and stays
    // remembered; the values are read fresh. (Same class as the menu's resting shape, which
    // showed rows six days older than the connection until it was fixed.)
    await this.refreshTuner();
  }

  /**
   * Write the tuner states from a Play_Info response.
   *
   * @param xml the Play_Info response body
   */
  private emitTunerInfo(xml: string): void {
    const info = parseTunerInfo(xml);
    if (info.preset !== undefined) {
      this.emit("tuner.preset", info.preset);
    }
    if (info.frequency !== undefined) {
      // Unified kHz (v2.0.0): the device reports FM in MHz, AM in kHz — normalize.
      this.emit("tuner.frequency", Math.round(info.frequencyUnit === "MHz" ? info.frequency * 1000 : info.frequency));
    }
    if (info.rdsService !== undefined) {
      this.emit("tuner.rdsService", info.rdsService);
    }
    if (info.rdsText !== undefined) {
      this.emit("tuner.rdsText", info.rdsText);
    }
    if (info.tuned !== undefined) {
      this.emit("tuner.tuned", info.tuned);
    }
    if (info.stereo !== undefined) {
      this.emit("tuner.stereo", info.stereo);
    }
  }

  /**
   * Poll the tuner's Play_Info (keepalive) and write the states.
   */
  private async refreshTuner(): Promise<void> {
    try {
      this.emitTunerInfo(await this.deps.client.getXml("Tuner", "<Play_Info>GetParam</Play_Info>"));
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: tuner Play_Info failed: ${errorMessage(e)}`);
    }
  }

  /**
   * A user write to `tuner.preset` → the openHAB-verified preset recall.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was the tuner preset (handled here)
   */
  private handleTunerWrite(stateId: string, value: unknown): boolean {
    if (stateId !== "tuner.preset" || !this.hasTuner) {
      return stateId === "tuner.preset";
    }
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num < 1) {
      return true;
    }
    void this.applyCommand({
      zone: "Tuner",
      inner: `<Play_Control><Preset><Preset_Sel>${num}</Preset_Sel></Preset></Play_Control>`,
    });
    return true;
  }

  /**
   * A user write to a zone's `scene.recall` → the DECLARED write element
   * (`<Scene><Scene_Sel>Scene N</Scene_Sel></Scene>`). Only zones that declared
   * scenes accept the write; a refusal lands in the log via applyCommand.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a scene recall (handled here)
   */
  private handleSceneWrite(stateId: string, value: unknown): boolean {
    const match = /^(?:multiroom\.(zone[234])\.)?scene\.recall$/.exec(stateId);
    if (!match) {
      return false;
    }
    const zoneKey = match[1] ?? "main";
    const zone = this.zones.find(z => z.key === zoneKey);
    const scenes = this.scenesByZone.get(zoneKey);
    // A TITLE is as valid a write as a number ("Movie Viewing" → Scene 1).
    const byTitle =
      typeof value === "string" && !/^\d+$/.test(value.trim())
        ? scenes?.find(scene => scene.title.toLowerCase() === value.trim().toLowerCase())?.num
        : undefined;
    const num = byTitle ?? Math.round(Number(value));
    if (!zone || !scenes || !scenes.some(scene => scene.num === num)) {
      return true;
    }
    void this.applyCommand({ zone: zone.element, inner: `<Scene><Scene_Sel>Scene ${num}</Scene_Sel></Scene>` });
    return true;
  }

  /**
   * Create the browsing surface (#613) when at least one source answers a List_Info
   * probe (NET_RADIO/SERVER/USB — the menus the predecessor adapter's users drove
   * via `Realtime.*.LINE1TXT` + `xmlCommand`). Skipped without a delay dep (older tests).
   */
  private async setupBrowse(): Promise<void> {
    const gate = this.deps.gate;
    if (!gate) {
      return;
    }
    const delay = (ms: number): Promise<void> => gate.delay(ms);
    // Which sources have a menu is a property of the MODEL, not of this connection — ask
    // once per device instead of costing three extra requests (up to five seconds on a
    // receiver that has no menus at all) on every single reconnect.
    const probe = async (): Promise<string[]> => {
      const probes = await Promise.all(
        XML_BROWSE_SOURCES.map(async source => {
          try {
            const body = await this.deps.client.getXml(source.element, "<List_Info>GetParam</List_Info>");
            return body.includes("<Menu_Status>") ? source.key : undefined;
          } catch (e) {
            if (isPermanentXmlRefusal(e)) {
              return undefined; // this model has no menu for that source (bodyless HTTP 400)
            }
            throw e; // transient — "no menus" must not be remembered for good
          }
        }),
      );
      return probes.filter((key): key is string => key !== undefined);
    };
    let available: Set<string>;
    try {
      available = new Set(
        this.deps.probeMemory ? await this.deps.probeMemory.once("xmlBrowseSources", probe) : await probe(),
      );
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: browse probe failed, asking again on the next connect (${errorMessage(e)})`,
      );
      return;
    }
    if (available.size === 0) {
      return;
    }
    const driver = new XmlBrowseDriver(this.deps.client, available, delay, this.deps.log, {
      cursor: this.zoneCommands.cursor.has("Main_Zone"),
      menu: this.zoneCommands.menu.has("Main_Zone"),
    });
    this.browseEngine = await createBrowseSurface(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.emit(id, value),
      log: this.deps.log,
      delay,
    });
  }

  /**
   * Write a device-originated value — but never after the connection was closed. A poll
   * that was already in flight when the adapter stopped would otherwise still write into
   * a tree that is being torn down.
   *
   * @param relativeId the state id relative to the device
   * @param value the value to write
   */
  private emit(relativeId: string, value: boolean | number | string): void {
    if (this.deps.gate?.closed) {
      return;
    }
    this.deps.setStateAck(`${this.deviceId}.${relativeId}`, value);
  }

  /**
   * Handle a state change: a user write (ack false) becomes an XML command; an
   * acked change (the device's own echo) is ignored.
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  public handleStateChange(fullStateId: string, ack: boolean, value: unknown): void {
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const stateId = fullStateId.slice(prefix.length);
    if (stateId.startsWith("remote.") && this.browseEngine) {
      this.browseEngine.handleRemoteWrite(stateId, value);
      return;
    }
    if (this.handleZoneCommandWrite(stateId, value)) {
      return;
    }
    if (stateId.startsWith("player.browse.")) {
      this.browseEngine?.handleWrite(stateId, value);
      return;
    }
    // Scenes and the classic tuner are device-declared (not in the static catalog).
    if (this.handleSceneWrite(stateId, value)) {
      return;
    }
    if (this.handleTunerWrite(stateId, value)) {
      return;
    }
    // Claim with proof, on the WRITE way too. Object creation has been proof-gated since
    // 2.0.1 (only fields this device's Basic_Status really delivers), but the write path was
    // not — the comment on `createdStates` claimed otherwise while it guarded the read side
    // alone. XML was the last transport without it: YNCA writes only through its per-device
    // write map, MusicCast only through device-declared endpoints. It bites on a datapoint an
    // adapter version before 2.0.1 created and that once carried a value, so no sweep removes
    // it: writing it put a blind command on the wire that the device answers with a refusal.
    if (!this.createdStates.has(stateId)) {
      this.deps.log.debug(`${this.deviceId}: ${stateId} was not reported by this device — write dropped`);
      return;
    }
    const command = stateToXml(stateId, value, this.dialect);
    if (command) {
      void this.applyCommand(command);
    }
  }

  /**
   * Register the supervisor's drop handler. XML has no push/socket-drop event, so a
   * drop is inferred from a run of failed polls (see keepalive).
   *
   * @param cb invoked once when the device is judged gone
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.dropDetector.onDrop(cb);
  }

  /** Cancel the keepalive poll. Synchronous — safe to call from onUnload. */
  public close(): void {
    this.browseEngine?.close();
    // Closing the gate empties its queue and aborts its signal: queued requests are
    // dropped and every pending wait ends, so nothing writes after the teardown.
    this.deps.gate?.close();
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
  }

  /**
   * Poll every live zone. If every zone fails for three consecutive failed polls in a
   * row, the device is judged gone and a drop is reported so the supervisor reconnects.
   */
  private async keepalive(): Promise<void> {
    // The keepalive is an async handler on an adapter timer: a rejection here is an
    // UNHANDLED rejection, and js-controller turns those into an adapter stop. Every step
    // below catches for itself today, so the guard is what makes that a guarantee instead
    // of something the next change has to remember.
    try {
      let anyOk = false;
      for (const zone of this.zones) {
        if (await this.refreshZone(zone)) {
          anyOk = true;
        }
      }
      if (this.hasTuner) {
        await this.refreshTuner();
      }
      this.dropDetector.record(anyOk);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: keepalive poll failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @returns true if the status was fetched, false if the request failed
   */
  private async refreshZone(zone: XmlZone): Promise<boolean> {
    const status = await this.tryGetStatus(zone.element);
    if (!status) {
      return false;
    }
    this.seedZone(zone, status);
    return true;
  }

  /**
   * Create (or update) one zone's amp states from what this device's status has DELIVERED so far
   * (`zoneFields`). Runs at start and again when a poll carries a field for the first time —
   * 2.7.0: the object appears in the SAME session instead of one start later. Idempotent: an
   * unchanged definition is written again at most once per new field, and nothing is removed here.
   *
   * @param zone the zone to build
   */
  private async createZoneStates(zone: XmlZone): Promise<void> {
    const createdChannels = this.createdChannels;
    const inputsByZone = this.inputsByZone;
    const descriptor = this.deviceDescriptor;
    for (const entry of XML_AMP_CATALOG) {
      // Main/system-wide features (scenes, HDMI outputs, party) exist only on the main zone;
      // the pre-out level mode only on the zones.
      if ((entry.mainOnly && zone.key !== "main") || (entry.zonesOnly && zone.key === "main")) {
        continue;
      }
      // Claim with proof: skip what this device's status never delivered.
      if (entry.statusField !== undefined && !this.zoneFields.get(zone.key)?.has(entry.statusField)) {
        continue;
      }
      const stateId = `${zone.prefix}${entry.state}`;
      // A dotted state (e.g. scene.recall) needs its parent channel created first.
      const segments = stateId.split(".");
      for (let i = 1; i < segments.length; i++) {
        const channelId = segments.slice(0, i).join(".");
        if (!createdChannels.has(channelId)) {
          createdChannels.add(channelId);
          await this.deps.upsertObject(`${this.deviceId}.${channelId}`, {
            id: channelId,
            type: "channel",
            // Name AND explanation from the one shared table, so the same folder cannot end
            // up called "sound" here and "Sound" there depending on which transport owns it.
            common: channelCommon(segments[i - 1]),
          });
        }
      }
      const { nameKey, descKey, ...rest } = entry.common;
      const common: ObjectDef["common"] = {
        ...rest,
        name: tName(nameKey),
        // An absent key means the datapoint explains itself — the fleet standard wants the
        // field empty there rather than filled with invented prose.
        ...(descKey ? { desc: tName(descKey) } : {}),
      };
      // The device's own lists become the dropdowns — DECLARED, so the coordinator puts them on
      // the YNCA-owned datapoint too (#619): the zone's `Input_Sel_Item` list, and from the
      // device description the sound programs (main zone), the sleep steps and the Adaptive
      // DRC values. Until 2026-09-09 the comment here said the YNCA union would win where YNCA
      // is present; that is exactly what the reporter saw.
      const declaredList = this.declaredListFor(entry.state, zone.key, inputsByZone, descriptor);
      const declared = declaredList !== undefined && declaredList.length > 0;
      if (declared) {
        common.states = Object.fromEntries(declaredList.map(value => [value, value]));
      }
      if (entry.state === "sound.dialogueLevel" && descriptor.dialogueLevel) {
        common.min = descriptor.dialogueLevel.min;
        common.max = descriptor.dialogueLevel.max;
        common.step = descriptor.dialogueLevel.step;
      }
      await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
        id: stateId,
        type: "state",
        common,
        ...(declared ? { declaredStates: true } : {}),
      });
      this.createdStates.add(stateId);
    }
  }

  /**
   * Write a zone's amp states from an already-fetched Basic_Status (used to seed
   * from the start-up probe without a second round-trip).
   *
   * @param zone the zone the status belongs to
   * @param status the parsed Basic_Status
   */
  private seedZone(zone: XmlZone, status: BasicStatus): void {
    if (status.dialect !== undefined && status.dialect !== this.dialect) {
      this.dialect = status.dialect;
      this.deps.probeMemory?.set("xmlDialect", status.dialect);
    }
    // A field the device delivers for the FIRST time mid-run has no object yet
    // (claim-with-proof creates only proven fields at start): remember it — the next
    // start creates it — and skip the write, so no state lands without an object.
    const known = this.zoneFields.get(zone.key);
    if (known) {
      let grew = false;
      for (const field of Object.keys(status)) {
        if (!known.has(field)) {
          known.add(field);
          grew = true;
        }
      }
      if (grew) {
        this.deps.probeMemory?.set(`xmlStatusFields:${zone.key}`, [...known]);
        // 2.7.0: the objects for the new fields are built NOW and their values written right
        // after, instead of appearing one start later. The transport adapter signals the handle,
        // which re-coordinates the unified tree. A field that VANISHES from a later poll removes
        // nothing — `zoneFields` is a union, shrinking stays a start-time decision.
        void this.createZoneStates(zone)
          .then(() => {
            for (const update of parseXmlStatus(status, zone.key)) {
              if (this.createdStates.has(update.id)) {
                this.emit(update.id, update.value);
              }
            }
          })
          .catch((e: unknown) => {
            this.deps.log.debug(`${this.deviceId}: could not create the new status fields: ${errorMessage(e)}`);
          });
      }
    }
    for (const update of parseXmlStatus(status, zone.key)) {
      if (this.createdStates.has(update.id)) {
        this.emit(update.id, update.value);
      }
    }
  }

  /**
   * Read a zone's status, swallowing errors (an absent zone or an offline device).
   *
   * @param element the XML zone element
   * @returns the parsed status, or undefined on failure
   */
  private async tryGetStatus(element: string): Promise<BasicStatus | undefined> {
    try {
      return await this.deps.client.getStatus(element);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${element}) failed: ${errorMessage(e)}`);
      return undefined;
    }
  }

  /**
   * Send a mapped command to the device.
   *
   * @param command the XML command to apply
   */
  /**
   * The zone-wide pads desc.xml declares: `remote.cursor` / `remote.menu` under every zone whose
   * `Cmd_List` defines `Cursor_Control,Cursor` / `Menu_Control` — the main zone's only when no
   * browse surface owns it already (then the surface's pad goes zone-wide through the driver).
   */
  private async setupZonePads(): Promise<void> {
    for (const zone of this.zones) {
      if (zone.key === "main" && this.browseEngine) {
        continue;
      }
      const cursor = this.zoneCommands.cursor.has(zone.element);
      const menu = this.zoneCommands.menu.has(zone.element);
      if (!cursor && !menu) {
        continue;
      }
      await this.deps.upsertObject(`${this.deviceId}.${zone.prefix}remote`, {
        id: `${zone.prefix}remote`,
        type: "channel",
        common: channelCommon("remote"),
      });
      const pads: Array<[string, string, readonly string[]]> = [];
      if (cursor) {
        pads.push(["cursor", "cursorPad", Object.keys(XML_CURSOR_WIRE)]);
      }
      if (menu) {
        pads.push(["menu", "menuKey", Object.keys(XML_MENU_WIRE)]);
      }
      for (const [suffix, nameKey, words] of pads) {
        const stateId = `${zone.prefix}remote.${suffix}`;
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: {
            name: tName(nameKey === "cursorPad" ? "cursorPad" : "menuKey"),
            desc: tName(nameKey === "cursorPad" ? "descCursorPad" : "descMenuKey"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: Object.fromEntries(words.map(word => [word, word])),
          },
        });
        this.createdStates.add(stateId);
      }
    }
  }

  /**
   * The transport keys desc.xml declares per zone (`Play_Control,Playback`: Play, Pause, Stop,
   * Skip Fwd, Skip Rev — 8 of the 10 captured descriptors, per zone on the 2013+ models): five
   * keys on the flat player block of the zone, the same ids YNCA and MusicCast use, so on a
   * receiver with a richer transport the owner policy hands them over.
   *
   * @param createdChannels the channels created so far (parents once)
   */
  private async setupTransportKeys(createdChannels: Set<string>): Promise<void> {
    for (const zone of this.zones) {
      if (!this.zoneCommands.playback.has(zone.element)) {
        continue;
      }
      const channelId = `${zone.prefix}player`;
      if (!createdChannels.has(channelId)) {
        createdChannels.add(channelId);
        await this.deps.upsertObject(`${this.deviceId}.${channelId}`, {
          id: channelId,
          type: "channel",
          common: channelCommon("player"),
        });
      }
      for (const [key, nameKey] of Object.entries(XML_TRANSPORT_NAME_KEYS)) {
        const stateId = `${zone.prefix}player.${key}`;
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: { name: tName(nameKey), type: "boolean", role: "button", read: false, write: true },
        });
        this.createdStates.add(stateId);
      }
    }
  }

  /**
   * Every zone's own name from `<Config><Name><Zone>` (desc.xml `Config,Name,Zone`, 5+4+1+1
   * zones over the captured descriptors) — a property of the model, asked once per device and
   * remembered as `xmlZoneName:<zone>`; a zone that declares none gets no datapoint. Same id as
   * YNCA's ZONENAME, so an XML-only receiver finally shows the names its owner gave the zones.
   *
   * @param createdChannels the channels created so far (parents once)
   */
  private async setupZoneNames(createdChannels: Set<string>): Promise<void> {
    for (const zone of this.zones) {
      const name = await this.probeZoneName(zone);
      if (!name) {
        continue;
      }
      const stateId = `${zone.prefix}zoneName`;
      const channelId = zone.prefix.replace(/\.$/, "");
      if (channelId && !createdChannels.has(channelId)) {
        // Cannot happen for a zone that answered its status (its channel exists), kept for
        // the zone whose only answer is its name.
        createdChannels.add(channelId);
        await this.deps.upsertObject(`${this.deviceId}.${channelId}`, {
          id: channelId,
          type: "channel",
          common: channelCommon(channelId.split(".").pop() ?? channelId),
        });
      }
      await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
        id: stateId,
        type: "state",
        common: {
          name: tName("zoneName"),
          desc: tName("descZoneName"),
          type: "string",
          role: "text",
          read: true,
          write: true,
        },
      });
      this.createdStates.add(stateId);
      this.emit(stateId, name);
    }
  }

  /**
   * A zone's name from its Config, remembered per device. Only a definite answer is
   * remembered (a name, or the model's own "no such node" as none); a transient failure asks
   * again on the next connect.
   *
   * @param zone the zone
   * @returns the name, or "" when the zone declares none
   */
  private async probeZoneName(zone: XmlZone): Promise<string> {
    const probe = async (): Promise<string> => {
      let body: string;
      try {
        body = await this.deps.client.getXml(zone.element, "<Config>GetParam</Config>");
      } catch (e) {
        if (isPermanentXmlRefusal(e)) {
          return "";
        }
        throw e;
      }
      const rc = parseReturnCode(body);
      if (rc !== undefined && rc !== 0) {
        if (rc === 2) {
          return "";
        }
        throw new Error(`device refused ${zone.element} Config probe (RC=${rc})`);
      }
      const name = /<Name>\s*<Zone>([^<]*)<\/Zone>/.exec(body);
      return name ? decodeXmlText(name[1]).trim() : "";
    };
    try {
      return this.deps.probeMemory ? await this.deps.probeMemory.once(`xmlZoneName:${zone.key}`, probe) : await probe();
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: ${zone.element} name probe failed (${errorMessage(e)})`);
      return "";
    }
  }

  /**
   * A write to one of the zone commands desc.xml declares — a pad key, a transport key or the
   * zone name — goes out on the zone element in the declared form. Only for datapoints this
   * connect created (the declaration is the proof); an unknown word sends nothing and says so.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a zone command (handled here, sent or refused)
   */
  private handleZoneCommandWrite(stateId: string, value: unknown): boolean {
    const match =
      /^(?:multiroom\.(zone[234])\.)?(remote\.(?:cursor|menu)|player\.(?:play|pause|stop|next|prev)|zoneName)$/.exec(
        stateId,
      );
    if (!match || !this.createdStates.has(stateId)) {
      return false;
    }
    const zone = this.zones.find(candidate => candidate.key === (match[1] ?? "main"));
    if (!zone) {
      return false;
    }
    const command = match[2];
    let inner: string | undefined;
    if (command === "remote.cursor" || command === "remote.menu") {
      const word = typeof value === "string" ? value : "";
      const wire = command === "remote.cursor" ? wireFor(XML_CURSOR_WIRE, word) : wireFor(XML_MENU_WIRE, word);
      if (wire === undefined) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} "${word}" is no key this receiver declares — write dropped`);
        return true;
      }
      inner =
        command === "remote.cursor"
          ? `<Cursor_Control><Cursor>${wire}</Cursor></Cursor_Control>`
          : `<Cursor_Control><Menu_Control>${wire}</Menu_Control></Cursor_Control>`;
    } else if (command === "zoneName") {
      if (typeof value !== "string") {
        return true;
      }
      inner = `<Config><Name><Zone>${escapeXmlText(value)}</Zone></Name></Config>`;
    } else {
      const word = XML_TRANSPORT_WIRE[command.slice("player.".length)];
      inner = `<Play_Control><Playback>${word}</Playback></Play_Control>`;
    }
    void this.applyCommand({ zone: zone.element, inner });
    return true;
  }

  private async applyCommand(command: XmlCommand): Promise<void> {
    try {
      await this.deps.client.send(command.zone, command.inner);
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${errorMessage(e)}`);
    }
  }
}

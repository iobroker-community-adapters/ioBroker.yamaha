import { keyedCommon, parentChannels, zoneRole, type ObjectDef } from "../catalog/types";
import { coerceBool, textWriteProblem, writableNumber } from "../catalog/value-coerce";
import { tName } from "../i18n";
import {
  definiteXmlBody,
  isPermanentXmlRefusal,
  parseDescriptor,
  parseInputList,
  parseInputLabels,
  parseSceneList,
  parsePlayInfo,
  parsePresetList,
  parseInputSources,
  parseTunerInfo,
  type BasicStatus,
  type XmlDescriptor,
  type XmlDialect,
  type XmlScene,
  type XmlSystemConfig,
  type XmlPlayInfo,
  type XmlPresetSlot,
  type XmlTunerInfo,
  type XmlZoneForm,
} from "./protocol";
import { parseXmlStatus, stateToXml, type XmlCommand } from "./command-mapper";
import { XML_AMP_CATALOG } from "./catalog";
import type { ControllerLog } from "../controller";
import { errorMessage } from "../util";
import { PollDropDetector } from "../lifecycle/poll-drop-detector";
import type { ProbeMemory } from "../lifecycle/probe-memory";
import type { CommandGate } from "../lifecycle/command-gate";
import type { BrowseEngine } from "../browse/browse-engine";
import { createBrowseSurface } from "../browse/surface";
import { provesMenu, XML_BROWSE_SOURCES, XmlBrowseDriver } from "../browse/xml-browse-driver";
import { MENU_WIRE, RETURN_CURSOR_WIRE, wireFor } from "../browse/types";
import { sceneListSurface, sceneNumber } from "../catalog/scene-titles";
import { splitZone } from "../catalog/zones";
import { XML_ZONES, type XmlZone } from "./zones";
import { MEDIA_STATE, TRANSPORT_KEYS } from "../catalog/media-state";
import { remoteObjectDefs } from "../browse/objects";
import { PLAYER_DISPLAY_STATES, PLAYER_STATION_STATE } from "../catalog/player-block";
import { absoluteDeviceUrl, withAlbumArtId } from "../yxc/command-mapper";
import { decodeXmlText, escapeXmlText } from "./entities";

/** XML/YNC has no push channel, so the state is polled at this interval by default. */
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

/** The transport keys of `Play_Control,Playback` and their wire words (desc.xml, RX-V675 & co). */
const XML_TRANSPORT_WIRE: Record<string, string> = {
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  next: "Skip Fwd",
  prev: "Skip Rev",
};

/** The tuner's declared preset slots (`Tuner,Play_Control,Preset,Preset_Sel_Item`, desc.xml `G3`). */
const PRESET_LIST_GET = "<Play_Control><Preset><Preset_Sel_Item>GetParam</Preset_Sel_Item></Preset></Play_Control>";

/** The 2008 generation's zone name (`Rename,Rename_Latin_1`, RX-V3900 desc.xml P6/G3 — D15). */
const RENAME_PATH = "Rename,Rename_Latin_1";
const RENAME_GET = "<Rename><Rename_Latin_1>GetParam</Rename_Latin_1></Rename>";

/** A zone's contents display (`Cursor_Control,Contents_Display`, desc.xml G9 — D15). */
const CONTENTS_DISPLAY_GET = "<Cursor_Control><Contents_Display>GetParam</Contents_Display></Cursor_Control>";

/** The all-zones power read (`System,Power_Control,Power`; RX-V6A capture `xml-system-power.xml`). */
const SYSTEM_POWER_GET = "<Power_Control><Power>GetParam</Power></Power_Control>";

/**
 * The all-zones power from its answer.
 *
 * @param xml the response body
 * @returns true for On, false for Standby, undefined when the answer carries neither
 */
function parseSystemPower(xml: string): boolean | undefined {
  const power = /<Power_Control>\s*<Power>(On|Standby)<\/Power>/.exec(xml)?.[1];
  return power === undefined ? undefined : power === "On";
}

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
  setStateAck(id: string, value: boolean | number | string | null): void;
  /** Adapter log. */
  log: ControllerLog;
  /**
   * The device's command gate: every request is paced through it, and its signal is the
   * connection's shutdown flag — a closed gate ends pending waits and stops state writes
   * from a poll that was already in flight.
   */
  gate: CommandGate;
  /** Per-device memory for answers that do not change while the device runs (see ProbeMemory). */
  probeMemory: ProbeMemory;
  /** The device's address, for the cover a source reports as a path on the device (D3). */
  host?: string;
}

/**
 * Drives one XML/YNC device: probe which zones answer, build the amp tree, seed
 * state, and route commands both ways. XML has no push, so state is refreshed by
 * a keepalive poll. Create-only.
 */
export class XmlDeviceController {
  private zones: XmlZone[] = [];
  private cancelKeepalive: (() => void) | undefined;
  private readonly dropDetector = new PollDropDetector();
  /** The liveness probe in flight, so concurrent askers share one question. */
  private aliveCheck: Promise<void> | undefined;
  private browseEngine: BrowseEngine | undefined;
  /** The scenes each zone DECLARES (`Scene_Sel_Item`), for the recall write path. */
  private readonly scenesByZone = new Map<string, XmlScene[]>();
  /** Whether the device answers `<Tuner><Play_Info>` (the classic pre-2010 tuner). */
  private hasTuner = false;
  /** Each zone's input as its last status reported it — which source its player block shows (D3). */
  private readonly zoneInput = new Map<string, string>();
  /** Per zone: input → the source element the device declares for it (`Src_Name`, D3). */
  private readonly inputSources = new Map<string, Record<string, string>>();
  /** The player-block states built so far, per zone (built as a source first reports the field). */
  private readonly playerStates = new Set<string>();
  /** The slots the tuner declares (`Preset_Sel_Item`) — the values a recall takes (D2). */
  private presetSlots: XmlPresetSlot[] = [];
  /** The band the tuner last reported, and how its frequency is spelled (D6). */
  private tunerBand: string | undefined;
  private freqForm: "band" | "flat" = "band";
  /** Whether the device answered `System,Power_Control,Power` (the all-zones power; D4). */
  private hasSystemPower = false;
  /** The amp state ids this controller actually created — the claim-with-proof gate for BOTH ways. */
  private readonly createdStates = new Set<string>();
  /** Channel ids already created — shared by the start-up build and the mid-session growth. */
  private readonly createdChannels = new Set<string>();
  /** The per-zone `Input_Sel_Item` lists and the device description, kept for a mid-session build. */
  private inputsByZone: ReadonlyMap<string, string[]> = new Map();
  /**
   * Per zone: the label the device carries for each input value (`<Title>`, e.g. HDMI1 → "Apple
   * TV"). The dropdown shows these, the value written to the device stays the protocol's own.
   */
  private inputLabelsByZone: ReadonlyMap<string, Record<string, string>> = new Map();
  private deviceDescriptor: XmlDescriptor = { programs: [], sleep: [], adaptiveDrc: [] };
  /**
   * The spelling this device answers its amplifier block with (see XmlDialect) — learned from
   * the first status that carries one, remembered as `xmlDialect` (a property of the model,
   * dropped with the XML identity), and put on every write. Undefined = classic.
   */
  private dialect: XmlDialect | undefined;
  /** Per zone: the Basic_Status fields this device is known to deliver (persisted union). */
  private readonly zoneFields = new Map<string, Set<string>>();
  /** Per zone element, the command form it uses where that differs from the main zone's (D6). */
  private readonly zoneForms = new Map<string, XmlZoneForm>();
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
  /** The states built read-only because the device description declares no write for them (D11). */
  private readonly readOnlyStates = new Set<string>();
  /** The zones whose contents display answered (D15). */
  private readonly contentsDisplayZones = new Set<string>();

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
    if (config.model !== undefined) {
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
    const rememberedDialect = this.deps.probeMemory.remembered("xmlDialect");
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
    // dropdown instead of a free string. The labels are the user's names — asked on every connection,
    // the memory is only the fallback (D8).
    const inputsByZone = new Map<string, string[]>();
    const inputLabels = new Map<string, Record<string, string>>();
    for (const zone of this.zones) {
      const body = await this.probeXml(
        `xmlInputs:${zone.key}`,
        zone.element,
        "<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>",
        true, // the labels are the user's names for the inputs
      );
      inputsByZone.set(zone.key, parseInputList(body));
      inputLabels.set(zone.key, parseInputLabels(body));
      this.inputSources.set(zone.key, parseInputSources(body));
    }
    // The device description — the classic generation's own enumeration of programs, sleep
    // steps, Adaptive DRC values and the dialogue range (2012–2017; the 2020 generation has none).
    const descriptor = await this.probeDescriptor();
    this.zoneCommands = {
      cursor: new Set(descriptor.cursorZones ?? []),
      menu: new Set(descriptor.menuZones ?? []),
      playback: new Set(descriptor.playbackZones ?? []),
    };
    for (const element of descriptor.toneManualZones ?? []) {
      this.zoneForms.set(element, { ...this.zoneForms.get(element), toneManual: true });
    }
    for (const element of descriptor.enhancerCurrentZones ?? []) {
      this.zoneForms.set(element, { ...this.zoneForms.get(element), enhancerCurrent: true });
    }
    // Claim with proof, XML edition (2.0.1): only the states whose Basic_Status field
    // this device DELIVERS are created — a blind full-catalog rollout left valueless
    // objects (hdmi.out2, sound.direct, …) standing on devices without the feature.
    // The delivered field set is a model property, remembered per zone (union, so a
    // later standby start — which may report fewer fields — cannot shrink the tree).
    for (const { zone, status } of answered) {
      const key = `xmlStatusFields:${zone.key}`;
      const remembered = this.deps.probeMemory.remembered<string[]>(key);
      const fields = new Set<string>(Array.isArray(remembered) ? remembered : []);
      for (const field of Object.keys(status ?? {})) {
        fields.add(field);
      }
      this.deps.probeMemory.set(key, [...fields]);
      this.zoneFields.set(zone.key, fields);
    }
    // Every parent — the zone channels included — is created by the per-state loop below
    // and named from the shared channel table (a zone that answered has at least
    // its power state, so its channel always comes into being this way).
    this.inputsByZone = inputsByZone;
    this.inputLabelsByZone = inputLabels;
    this.deviceDescriptor = descriptor;
    for (const zone of this.zones) {
      await this.createZoneStates(zone);
    }
    await this.setupScenes();
    await this.setupTuner();
    await this.setupSystemPower();
    await this.setupTransportKeys();
    await this.setupZoneNames();
    await this.setupContentsDisplay();
    await this.setupPartyVolume();
    // Seed from the statuses already fetched during the probe — no second round-trip.
    for (const { zone, status } of answered) {
      if (status) {
        this.seedZone(zone, status);
      }
    }
    // What each zone's source plays — after the seed, which tells the zone's input (D3).
    await this.refreshPlayers();
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
      // `:v3` since the parse carries every declared write command (2026-09-29, D18) — an older parse lacks them.
      return await this.deps.probeMemory.once("xmlDescriptor:v3", probe);
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: desc.xml probe failed, asking again on the next connect (${errorMessage(e)})`,
      );
      return empty;
    }
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
   * @param fresh ask again on every connection (a name the user can change — D8), the memory only
   *   the fallback
   * @returns the raw response body, or "" when the device (definitely or for now) has none
   */
  private async probeXml(key: string, element: string, inner: string, fresh = false): Promise<string> {
    const probe = (): Promise<string> =>
      definiteXmlBody(() => this.deps.client.getXml(element, inner), `${element} probe`);
    const memory = this.deps.probeMemory;
    try {
      return fresh ? await memory.refresh(key, probe) : await memory.once(key, probe);
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
   */
  private async setupScenes(): Promise<void> {
    for (const zone of this.zones) {
      const body = await this.probeXml(
        `xmlScenes:${zone.key}`,
        zone.element,
        "<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>",
        true, // the titles are the user's names for the scenes
      );
      const scenes = parseSceneList(body);
      if (scenes.length === 0) {
        continue;
      }
      this.scenesByZone.set(zone.key, scenes);
      const channelId = `${zone.prefix}scene`;
      await this.ensureChannels(`${channelId}.recall`);
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
      // Visualizations read titles as VALUES (button captions — the #613 reporter's setup), and a
      // dropdown's labels are not readable: the list for widgets, a title datapoint per scene for
      // everything else (D8).
      const surface = sceneListSurface(channelId, scenes);
      for (const object of surface.objects) {
        await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
      }
      for (const { id, value } of surface.values) {
        this.emit(id, value);
      }
    }
  }

  /**
   * Build the classic tuner surface (pre-2010 devices, where XML is the ONLY
   * transport — the predecessor served their tuner, the rewrite had dropped it).
   * Existence is probed once per device; the preset write is the openHAB-verified
   * `<Play_Control><Preset><Preset_Sel>`; frequency/RDS/tuned are read-only from
   * Play_Info. On newer devices YNCA/YXC own these ids via the owner policy.
   */
  private async setupTuner(): Promise<void> {
    const probe = await this.probeXml("xmlTuner", "Tuner", "<Play_Info>GetParam</Play_Info>");
    if (probe.length === 0) {
      return;
    }
    this.hasTuner = true;
    await this.ensureChannels("tuner.preset");
    // Only the fields this device's Play_Info carries become datapoints — the remembered probe is the
    // proof of existence, never the source of a value (D7: an RX-V675 has no RDS block and carried
    // three RDS datapoints that never got a value).
    const carried = parseTunerInfo(probe);
    this.freqForm = carried.freqForm ?? "band";
    const state = async (id: keyof XmlTunerInfo, common: ObjectDef["common"]): Promise<void> => {
      if (carried[id] === undefined && !(id === "preset" && /<Preset[>_]/.test(probe))) {
        return;
      }
      await this.deps.upsertObject(`${this.deviceId}.tuner.${id}`, { id: `tuner.${id}`, type: "state", common });
    };
    // The slots the device declares (`Preset_Sel_Item`, desc.xml `Indirect G3`) — the 2008 generation
    // names them `A1…E8`; 0 is "no preset", as on YNCA and MusicCast (audit 2026-09-29, D2).
    this.presetSlots = parsePresetList(await this.probeXml("xmlTunerPresets", "Tuner", PRESET_LIST_GET));
    const slots = this.presetSlots;
    await state("preset", {
      name: tName("presetRecallByNumber"),
      desc: tName("descPresetRecallByNumber"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
      max: slots.length > 0 ? Math.max(...slots.map(slot => slot.num)) : 40,
      step: 1,
      ...(slots.length > 0 ? { states: Object.fromEntries(slots.map(slot => [slot.num, slot.title])) } : {}),
    });
    // The band and the frequency are written too — the XML-only generation had no way to tune (D6).
    await state("band", {
      name: tName("band"),
      type: "string",
      role: "state",
      read: true,
      write: true,
      states: { AM: "AM", FM: "FM" },
    });
    await state("frequency", {
      name: tName("frequency"),
      type: "number",
      role: "level",
      unit: "kHz",
      read: true,
      write: true,
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
    await state("rdsTextB", {
      name: tName("rdsTextB"),
      desc: tName("descRdsTextB"),
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
    if (info.band !== undefined) {
      this.tunerBand = info.band;
      this.emit("tuner.band", info.band);
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
    if (info.rdsTextB !== undefined) {
      this.emit("tuner.rdsTextB", info.rdsTextB);
    }
    if (info.tuned !== undefined) {
      this.emit("tuner.tuned", info.tuned);
    }
    if (info.stereo !== undefined) {
      this.emit("tuner.stereo", info.stereo);
    }
  }

  /**
   * A write to `tuner.band` or `tuner.frequency` (`Tuner,Play_Control,Tuning`, 9 of 10 descriptors):
   * the band as AM/FM, the frequency in kHz on the current band, snapped to the grid the device
   * declares (`Tuning,Freq` ranges — 9 kHz/50 kHz in Europe, 10 kHz/200 kHz in the US) and written in
   * the device's own spelling — `Freq,FM|AM` from 2009, `Freq` alone on the 2008 generation (D6).
   *
   * @param stateId `tuner.band` or `tuner.frequency`
   * @param value the written value
   * @returns true (the id is handled here)
   */
  private handleTuningWrite(stateId: string, value: unknown): boolean {
    if (!this.hasTuner) {
      return true;
    }
    if (stateId === "tuner.band") {
      if (value !== "AM" && value !== "FM") {
        return true;
      }
      void this.applyCommand(
        { zone: "Tuner", inner: `<Play_Control><Tuning><Band>${value}</Band></Tuning></Play_Control>` },
        () => this.refreshTuner(),
      );
      return true;
    }
    const khz = writableNumber(value);
    const band = this.tunerBand === "AM" ? "AM" : this.tunerBand === "FM" ? "FM" : undefined;
    if (khz === undefined || band === undefined) {
      this.deps.log.debug(`${this.deviceId}: tuner.frequency not written — the band is not known yet`);
      return true;
    }
    const grid = this.deviceDescriptor?.tunerGrid?.[band];
    const snapped = grid ? grid.min + Math.round((khz - grid.min) / grid.step) * grid.step : Math.round(khz);
    const bounded = grid ? Math.min(grid.max, Math.max(grid.min, snapped)) : snapped;
    const wire =
      band === "FM"
        ? `<Val>${Math.round(bounded / 10)}</Val><Exp>2</Exp><Unit>MHz</Unit>`
        : `<Val>${bounded}</Val><Exp>0</Exp><Unit>kHz</Unit>`;
    const freq = this.freqForm === "flat" ? `<Freq>${wire}</Freq>` : `<Freq><${band}>${wire}</${band}></Freq>`;
    void this.applyCommand({ zone: "Tuner", inner: `<Play_Control><Tuning>${freq}</Tuning></Play_Control>` }, () =>
      this.refreshTuner(),
    );
    return true;
  }

  /**
   * The all-zones power: every desc.xml declares `System,Power_Control,Power` (10 of 10, the 2008
   * RX-V3900 included) and the predecessor switched it; the id is YNCA's `multiroom.masterPower`, so a
   * receiver without YNCA keeps the switch (audit 2026-09-29, D4). Proven by the device's answer.
   */
  private async setupSystemPower(): Promise<void> {
    const probe = await this.probeXml("xmlSystemPower", "System", SYSTEM_POWER_GET);
    const power = parseSystemPower(probe);
    if (power === undefined) {
      return;
    }
    this.hasSystemPower = true;
    await this.ensureChannels("multiroom.masterPower");
    await this.deps.upsertObject(`${this.deviceId}.multiroom.masterPower`, {
      id: "multiroom.masterPower",
      type: "state",
      common: {
        name: tName("masterPowerAllZones"),
        desc: tName("descMasterPowerAllZones"),
        type: "boolean",
        role: "switch.power",
        read: true,
        write: true,
      },
    });
    this.createdStates.add("multiroom.masterPower");
    await this.refreshSystemPower();
  }

  /** Read the all-zones power and write it (poll and read-back). */
  private async refreshSystemPower(): Promise<void> {
    try {
      const power = parseSystemPower(await this.deps.client.getXml("System", SYSTEM_POWER_GET));
      if (power !== undefined) {
        this.emit("multiroom.masterPower", power);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: system power failed: ${errorMessage(e)}`);
    }
  }

  /**
   * A write to `multiroom.masterPower` → `System,Power_Control,Power` On/Standby.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was the all-zones power (handled here)
   */
  private handleSystemPowerWrite(stateId: string, value: unknown): boolean {
    if (stateId !== "multiroom.masterPower") {
      return false;
    }
    const on = coerceBool(value);
    if (!this.hasSystemPower || on === undefined) {
      return true;
    }
    void this.applyCommand(
      { zone: "System", inner: `<Power_Control><Power>${on ? "On" : "Standby"}</Power></Power_Control>` },
      () => this.refreshSystemPower(),
    );
    return true;
  }

  /**
   * Whether the device description declares a write command for an element.
   *
   * @param element the element (`Main_Zone`, `System`)
   * @param path the command path after it
   * @returns true when declared
   */
  private declares(element: string, path: string): boolean {
    return this.deviceDescriptor.puts?.[element]?.[path] !== undefined;
  }

  /**
   * Whether the device description declares a command list at all — where it does, it decides what is
   * writable (D11); where it does not (the 2020 generation), the catalog rule stands.
   *
   * @returns true when a command list is declared
   */
  private hasCommandList(): boolean {
    return Object.keys(this.deviceDescriptor.puts ?? {}).length > 0;
  }

  /**
   * The contents display of every zone that declares it (`Cursor_Control,Contents_Display`, GET and
   * PUT On/Off, six desc.xml) — the id is YNCA's `sound.contentsDisplay` (audit 2026-09-29, D15).
   * Proven by the zone's answer.
   */
  private async setupContentsDisplay(): Promise<void> {
    for (const zone of this.zones) {
      if (!this.declares(zone.element, "Cursor_Control,Contents_Display")) {
        continue;
      }
      const on = await this.readContentsDisplay(zone);
      if (on === undefined) {
        continue;
      }
      const stateId = `${zone.prefix}sound.contentsDisplay`;
      await this.ensureChannels(stateId);
      await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
        id: stateId,
        type: "state",
        common: {
          name: tName("contentsDisplay"),
          desc: tName("descContentsDisplay"),
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
        },
      });
      this.createdStates.add(stateId);
      this.contentsDisplayZones.add(zone.key);
      this.emit(stateId, on);
    }
  }

  /**
   * Read one zone's contents display.
   *
   * @param zone the zone
   * @returns On as true, Off as false, undefined when the zone does not answer it
   */
  private async readContentsDisplay(zone: XmlZone): Promise<boolean | undefined> {
    try {
      const body = await this.deps.client.getXml(zone.element, CONTENTS_DISPLAY_GET);
      const word = /<Contents_Display>\s*(On|Off)\s*<\/Contents_Display>/.exec(body)?.[1];
      return word === undefined ? undefined : word === "On";
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: ${zone.element} contents display failed: ${errorMessage(e)}`);
      return undefined;
    }
  }

  /** Read the contents display of every zone that has one (poll and read-back). */
  private async refreshContentsDisplay(): Promise<void> {
    for (const zone of this.zones) {
      if (!this.contentsDisplayZones.has(zone.key)) {
        continue;
      }
      const on = await this.readContentsDisplay(zone);
      if (on !== undefined) {
        this.emit(`${zone.prefix}sound.contentsDisplay`, on);
      }
    }
  }

  /**
   * A write to a zone's `sound.contentsDisplay` → `Cursor_Control,Contents_Display` On/Off.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a contents display (handled here)
   */
  private handleContentsDisplayWrite(stateId: string, value: unknown): boolean {
    const { zone: zoneKey, name } = splitZone(stateId);
    if (name !== "sound.contentsDisplay") {
      return false;
    }
    const zone = this.zones.find(candidate => candidate.key === zoneKey);
    const on = coerceBool(value);
    if (!zone || !this.contentsDisplayZones.has(zone.key) || on === undefined) {
      return true;
    }
    void this.applyCommand(
      {
        zone: zone.element,
        inner: `<Cursor_Control><Contents_Display>${on ? "On" : "Off"}</Contents_Display></Cursor_Control>`,
      },
      () => this.refreshContentsDisplay(),
    );
    return true;
  }

  /**
   * The party-mode volume keys where the description declares them (`System,Party_Mode,Volume,Lvl`
   * Up/Down — RX-A2060, RX-S601D, RX-V775): YNCA's `multiroom.partyVolumeUp`/`Down` buttons (D15). The
   * party mute is declared as a write only — no description declares a read, so a switch could never
   * show the device's state; it stays with YNCA, which every one of these models has.
   */
  private async setupPartyVolume(): Promise<void> {
    if (!this.declares("System", "Party_Mode,Volume,Lvl")) {
      return;
    }
    for (const [state, nameKey, descKey] of [
      ["multiroom.partyVolumeUp", "partyVolumeUp", "descPartyVolumeUp"],
      ["multiroom.partyVolumeDown", "partyVolumeDown", "descPartyVolumeDown"],
    ] as const) {
      await this.ensureChannels(state);
      await this.deps.upsertObject(`${this.deviceId}.${state}`, {
        id: state,
        type: "state",
        common: {
          name: tName(nameKey),
          desc: tName(descKey),
          type: "boolean",
          role: "button",
          read: false,
          write: true,
        },
      });
      this.createdStates.add(state);
    }
  }

  /**
   * A press of a party-mode volume key → `System,Party_Mode,Volume,Lvl` Up/Down.
   *
   * @param stateId the state id relative to the device
   * @returns true when the id was a party volume key (handled here)
   */
  private handlePartyVolumeWrite(stateId: string): boolean {
    if (stateId !== "multiroom.partyVolumeUp" && stateId !== "multiroom.partyVolumeDown") {
      return false;
    }
    if (this.createdStates.has(stateId)) {
      const word = stateId === "multiroom.partyVolumeUp" ? "Up" : "Down";
      void this.applyCommand({ zone: "System", inner: `<Party_Mode><Volume><Lvl>${word}</Lvl></Volume></Party_Mode>` });
    }
    return true;
  }

  /**
   * The "now playing" block of every zone listening to a media source: the source's `Play_Info`
   * (2009+ one element per source, 2008 `NET_USB`/`iPod`) — artist, album, track, station, status,
   * repeat, shuffle and cover, under the same `player.*` ids YNCA and MusicCast fill. XML read none of
   * it, so the 2008 generation had no playback information at all (audit 2026-09-29, D3). A state is
   * built when a source first reports its field; a zone that leaves its source is cleared.
   */
  private async refreshPlayers(): Promise<void> {
    const answers = new Map<string, XmlPlayInfo | undefined>();
    for (const zone of this.zones) {
      const input = this.zoneInput.get(zone.key);
      const source = input === undefined ? undefined : this.inputSources.get(zone.key)?.[input];
      const prefix = `${zone.prefix}player`;
      if (source === undefined) {
        if (this.playerStates.has(`${prefix}.playback`)) {
          this.clearPlayer(prefix);
        }
        continue;
      }
      if (!answers.has(source)) {
        try {
          answers.set(source, parsePlayInfo(await this.deps.client.getXml(source, "<Play_Info>GetParam</Play_Info>")));
        } catch (e) {
          answers.set(source, undefined);
          this.deps.log.debug(`${this.deviceId}: ${source} Play_Info failed: ${errorMessage(e)}`);
        }
      }
      const info = answers.get(source);
      if (info === undefined || info.playback === undefined) {
        continue;
      }
      const values: Record<string, boolean | number | string> = { source: input ?? "", ...info };
      if (typeof info.albumArt === "string") {
        values.albumArt = withAlbumArtId(absoluteDeviceUrl(info.albumArt, this.deps.host), info.albumArtId);
      }
      for (const [state, value] of Object.entries(values)) {
        const def = [...PLAYER_DISPLAY_STATES, PLAYER_STATION_STATE].find(entry => entry.state === state);
        if (!def) {
          continue;
        }
        const id = `${prefix}.${state}`;
        if (!this.playerStates.has(id)) {
          await this.ensureChannels(id);
          await this.deps.upsertObject(`${this.deviceId}.${id}`, {
            id,
            type: "state",
            common: keyedCommon(def.common),
          });
          this.playerStates.add(id);
          this.createdStates.add(id);
        }
        this.emit(id, value);
      }
    }
  }

  /**
   * Clear a player block whose zone left its media source — its old track must not linger.
   *
   * @param prefix the block's id prefix (`player`, `multiroom.zone2.player`)
   */
  private clearPlayer(prefix: string): void {
    const cleared: Record<string, boolean | number | string> = {
      source: "",
      playback: MEDIA_STATE.stop,
      artist: "",
      album: "",
      track: "",
      station: "",
      repeat: 0,
      shuffle: false,
      albumArt: "",
    };
    for (const [state, value] of Object.entries(cleared)) {
      if (this.playerStates.has(`${prefix}.${state}`)) {
        this.emit(`${prefix}.${state}`, value);
      }
    }
  }

  /** Poll the tuner's Play_Info (keepalive, read-back) and write the states. */
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
    if (stateId === "tuner.band" || stateId === "tuner.frequency") {
      return this.handleTuningWrite(stateId, value);
    }
    if (stateId !== "tuner.preset" || !this.hasTuner) {
      return stateId === "tuner.preset";
    }
    // Number(true) is 1 — a switch bound here by mistake recalled preset 1 (audit 2026-09-24, D20).
    const num = Math.round(writableNumber(value) ?? Number.NaN);
    if (!Number.isFinite(num) || num < 1) {
      return true;
    }
    // The device's own spelling of the slot (`A1` on the 2008 generation); a slot it does not
    // declare is not sent (D2).
    const code = this.presetSlots.length > 0 ? this.presetSlots.find(slot => slot.num === num)?.code : String(num);
    if (code === undefined) {
      this.deps.log.debug(`${this.deviceId}: tuner preset ${num} is not a slot this device declares — not sent`);
      return true;
    }
    void this.applyCommand(
      { zone: "Tuner", inner: `<Play_Control><Preset><Preset_Sel>${code}</Preset_Sel></Preset></Play_Control>` },
      () => this.refreshTuner(),
    );
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
    const { zone: zoneKey, name } = splitZone(stateId);
    if (name !== "scene.recall") {
      return false;
    }
    const zone = this.zones.find(z => z.key === zoneKey);
    const scenes = this.scenesByZone.get(zoneKey);
    // A TITLE is as valid a write as a number ("Movie Viewing" → Scene 1) — the one resolver (D16).
    const num = sceneNumber(value, scenes ?? []);
    if (!zone || !scenes || !scenes.some(scene => scene.num === num)) {
      return true;
    }
    void this.applyCommand({ zone: zone.element, inner: `<Scene><Scene_Sel>Scene ${num}</Scene_Sel></Scene>` }, () =>
      this.refreshZone(zone),
    );
    return true;
  }

  /**
   * Create the browsing surface (#613) when at least one source answers a List_Info
   * probe (NET_RADIO/SERVER/USB — the menus the predecessor adapter's users drove
   * via `Realtime.*.LINE1TXT` + `xmlCommand`).
   */
  private async setupBrowse(): Promise<void> {
    const gate = this.deps.gate;
    const delay = (ms: number): Promise<void> => gate.delay(ms);
    // Which sources have a menu is a property of the MODEL, not of this connection — ask
    // once per device instead of costing three extra requests (up to five seconds on a
    // receiver that has no menus at all) on every single reconnect.
    // One request per menu element — the 2008 generation's three network inputs share one NET_USB
    // menu (D5). The proven sources are remembered by id.
    const probe = async (): Promise<string[]> => {
      const menus = [
        ...new Map(XML_BROWSE_SOURCES.map(source => [`${source.element}|${source.list}`, source])).values(),
      ];
      const proven = new Set<string>();
      await Promise.all(
        menus.map(async menu => {
          // RC 3/4 or a transport error throws — "no menus" must not be remembered for good.
          const body = await definiteXmlBody(
            () => this.deps.client.getXml(menu.element, `<${menu.list}>GetParam</${menu.list}>`),
            `${menu.element} ${menu.list} probe`,
          );
          if (provesMenu(menu, body)) {
            proven.add(`${menu.element}|${menu.list}`);
          }
        }),
      );
      return XML_BROWSE_SOURCES.filter(source => proven.has(`${source.element}|${source.list}`)).map(
        source => source.id,
      );
    };
    let available: Set<string>;
    try {
      available = new Set(
        // `:v2` since the answers are source ids (2026-09-24, D5) — the old key held keys.
        await this.deps.probeMemory.once("xmlBrowseSources:v2", probe),
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
  private emit(relativeId: string, value: boolean | number | string | null): void {
    if (this.deps.gate.closed) {
      return;
    }
    this.deps.setStateAck(`${this.deviceId}.${relativeId}`, value);
  }

  /**
   * A user write to one of this controller's states, under the controller's own id relative to the
   * device — it becomes a XML command. The multi-transport handle has already dropped acked
   * echoes and routed only the owner's ids here (audit 2026-09-29, A32: each controller re-checked
   * both, a path production never took).
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   */
  public handleWrite(stateId: string, value: unknown): void {
    if (this.readOnlyStates.has(stateId)) {
      this.deps.log.debug(`${this.deviceId}: ${stateId} — this device declares no write for it, write dropped`);
      return;
    }
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
    if (this.handleSystemPowerWrite(stateId, value)) {
      return;
    }
    if (this.handleContentsDisplayWrite(stateId, value) || this.handlePartyVolumeWrite(stateId)) {
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
    const { zone: zoneKey } = splitZone(stateId);
    const element = this.zones.find(candidate => candidate.key === zoneKey)?.element ?? "Main_Zone";
    const command = stateToXml(stateId, value, this.dialect, this.zoneForms.get(element));
    if (command) {
      // The zone to read back afterwards: the command's own element, or the main zone for a
      // command that goes out on the System element (HDMI outputs, party mode).
      const zone = this.zones.find(candidate => candidate.element === command.zone) ?? this.zones[0];
      // A new input changes which source the zone's player block shows (D3).
      const players = /(^|\.)input$/.test(stateId);
      void this.applyCommand(command, async () => {
        await this.refreshZone(zone);
        if (players) {
          await this.refreshPlayers();
        }
      });
    } else {
      this.deps.log.debug(`${this.deviceId}: ${stateId} is not writable on this device — write dropped`);
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
    this.deps.gate.close();
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
  }

  /**
   * Ask the device once, now: the first zone's status. No answer is a drop — reported at once.
   * Called by the multi-transport handle when another transport of the device dropped: three
   * missed minute-polls are the right bar for a busy receiver, not for one that just went
   * silent on its socket. One probe for concurrent askers.
   */
  public verifyAlive(): Promise<void> {
    this.aliveCheck ??= this.probeAlive().finally(() => {
      this.aliveCheck = undefined;
    });
    return this.aliveCheck;
  }

  private async probeAlive(): Promise<void> {
    const zone = this.zones[0];
    if (!zone) {
      return; // never started — nothing to ask, nothing to judge
    }
    try {
      if (!(await this.refreshZone(zone))) {
        this.dropDetector.report("liveness check unanswered");
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: liveness probe failed: ${errorMessage(e)}`);
      this.dropDetector.report("liveness check unanswered");
    }
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
      if (this.hasSystemPower) {
        await this.refreshSystemPower();
      }
      await this.refreshContentsDisplay();
      await this.refreshPlayers();
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
    try {
      this.seedZone(zone, status);
    } catch (e) {
      // The read-back after a user write reaches this without an awaiting caller (see
      // applyCommand), so a throw would be an unhandled rejection — and that stops the
      // instance. Like the MusicCast twin, the answer stays "the device answered".
      this.deps.log.warn(`${this.deviceId}: could not apply the ${zone.key} status (${errorMessage(e)})`);
    }
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
      // A dotted state (e.g. scene.recall) needs its parent channel created first — named AND
      // explained from the one shared table, so the same folder cannot end up called "sound" here
      // and "Sound" there depending on which transport owns it.
      await this.ensureChannels(stateId);
      // An absent explanation key means the datapoint explains itself — the fleet standard wants
      // the field empty there rather than filled with invented prose.
      const keyed = keyedCommon(entry.common);
      const common: ObjectDef["common"] = { ...keyed, role: zoneRole(keyed.role, zone.prefix) };
      // The device's own lists become the dropdowns — DECLARED, so the coordinator puts them on
      // the YNCA-owned datapoint too (#619): the zone's `Input_Sel_Item` list, and from the
      // device description the sound programs (main zone), the sleep steps and the Adaptive
      // DRC values. Until 2026-09-09 the comment here said the YNCA union would win where YNCA
      // is present; that is exactly what the reporter saw.
      const declaredList = this.declaredListFor(entry.state, zone.key, inputsByZone, descriptor);
      const declared = declaredList !== undefined && declaredList.length > 0;
      if (declared) {
        // The device's label where it carries one — the key stays the value that switches.
        const labels = entry.state === "input" ? this.inputLabelsByZone.get(zone.key) : undefined;
        common.states = Object.fromEntries(declaredList.map(value => [value, labels?.[value] ?? value]));
      }
      // Where the device description declares a command list, it decides: writable exactly where it
      // declares one of the entry's write paths for this zone (or the System element the entry writes
      // to), with the bounds declared there — the step also the grid a written value snaps to
      // (D16/D10). Before, only the dialogue level asked; everything else was writable because its
      // status carried it (D11, D18). Without a description the catalog rule stands.
      const puts = descriptor.puts ?? {};
      if (entry.putPaths && Object.keys(puts).length > 0) {
        const declaredPut = entry.putPaths
          .map(path => puts[entry.writeZone ?? zone.element]?.[path])
          .find(put => put !== undefined);
        common.write = declaredPut !== undefined;
        if (declaredPut?.range) {
          common.min = declaredPut.range.min;
          common.max = declaredPut.range.max;
          common.step = declaredPut.range.step;
          const form = this.zoneForms.get(zone.element) ?? {};
          this.zoneForms.set(zone.element, {
            ...form,
            steps: { ...form.steps, [entry.state]: declaredPut.range.step },
          });
        }
        if (declaredPut?.words && !common.states) {
          common.states = Object.fromEntries(declaredPut.words.map(word => [word, word]));
        }
      }
      // A number the user sets is a level, one the device only reports a value.
      if (common.role === "value" && common.write) {
        common.role = "level";
      } else if (common.role === "level" && !common.write) {
        common.role = "value";
      }
      if (common.write) {
        this.readOnlyStates.delete(stateId);
      } else {
        this.readOnlyStates.add(stateId);
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
   * Create the channels an id still lacks above it, parents first, each once — named from the one
   * channel table (audit 2026-09-29, D19: the loop stood five times in this controller).
   *
   * @param id the state (or channel) id
   */
  private async ensureChannels(id: string): Promise<void> {
    for (const parent of parentChannels(id, this.createdChannels)) {
      await this.deps.upsertObject(`${this.deviceId}.${parent.id}`, parent);
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
    if (status.input !== undefined) {
      this.zoneInput.set(zone.key, status.input);
    }
    // Where no desc.xml declares the zone's form, its own status shows it (the 2020 generation, D6).
    if (status.zoneForm) {
      this.zoneForms.set(zone.element, { ...this.zoneForms.get(zone.element), ...status.zoneForm });
    }
    if (status.dialect !== undefined && status.dialect !== this.dialect) {
      this.dialect = status.dialect;
      this.deps.probeMemory.set("xmlDialect", status.dialect);
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
        this.deps.probeMemory.set(`xmlStatusFields:${zone.key}`, [...known]);
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
      await this.ensureChannels(`${zone.prefix}remote.cursor`);
      const defs = remoteObjectDefs(
        cursor ? Object.keys(RETURN_CURSOR_WIRE) : undefined,
        menu ? Object.keys(MENU_WIRE) : undefined,
        zone.prefix,
      );
      for (const def of defs.filter(object => object.type === "state")) {
        await this.deps.upsertObject(`${this.deviceId}.${def.id}`, def);
        this.createdStates.add(def.id);
      }
    }
  }

  /**
   * The transport keys desc.xml declares per zone (`Play_Control,Playback`: Play, Pause, Stop,
   * Skip Fwd, Skip Rev — 8 of the 10 captured descriptors, per zone on the 2013+ models): five
   * keys on the flat player block of the zone, the same ids YNCA and MusicCast use, so on a
   * receiver with a richer transport the owner policy hands them over.
   */
  private async setupTransportKeys(): Promise<void> {
    for (const zone of this.zones) {
      if (!this.zoneCommands.playback.has(zone.element)) {
        continue;
      }
      await this.ensureChannels(`${zone.prefix}player.play`);
      for (const [key, { nameKey, role }] of Object.entries(TRANSPORT_KEYS)) {
        const stateId = `${zone.prefix}player.${key}`;
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: { name: tName(nameKey), type: "boolean", role, read: false, write: true },
        });
        this.createdStates.add(stateId);
      }
    }
  }

  /**
   * Every zone's own name from `<Config><Name><Zone>` (desc.xml `Config,Name,Zone`, 5+4+1+1
   * zones over the captured descriptors) — read on every connection (the user can rename a zone at
   * the device, D8) with `xmlZoneName:<zone>` as the fallback; a zone that declares none gets no datapoint. Same id as
   * YNCA's ZONENAME, so an XML-only receiver finally shows the names its owner gave the zones.
   */
  private async setupZoneNames(): Promise<void> {
    for (const zone of this.zones) {
      const names = await this.probeZoneNames(zone);
      if (names.zone) {
        const stateId = `${zone.prefix}zoneName`;
        const write =
          !this.hasCommandList() ||
          this.declares(zone.element, "Config,Name,Zone") ||
          this.declares(zone.element, RENAME_PATH);
        await this.ensureChannels(stateId);
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: {
            name: tName("zoneName"),
            desc: tName("descZoneName"),
            type: "string",
            role: "text",
            read: true,
            write,
          },
        });
        this.markWritable(stateId, write);
        this.emit(stateId, names.zone);
      }
      // The Zone B name rides in the main zone's Config (`Config,Name,Zone_B`, HTR-4069, RX-V579,
      // TSR-5810) — YNCA's ZONEBNAME under the same id (audit 2026-09-29, D15).
      if (zone.key === "main" && names.zoneB) {
        const stateId = "multiroom.zoneB.name";
        const write = !this.hasCommandList() || this.declares(zone.element, "Config,Name,Zone_B");
        await this.ensureChannels(stateId);
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: {
            name: tName("zoneBName"),
            desc: tName("descZoneName"),
            type: "string",
            role: "text",
            read: true,
            write,
          },
        });
        this.markWritable(stateId, write);
        this.emit(stateId, names.zoneB);
      }
    }
  }

  /**
   * Record a state as created, and as read-only where it is not writable.
   *
   * @param stateId the state id
   * @param write whether it is writable
   */
  private markWritable(stateId: string, write: boolean): void {
    this.createdStates.add(stateId);
    if (write) {
      this.readOnlyStates.delete(stateId);
    } else {
      this.readOnlyStates.add(stateId);
    }
  }

  /**
   * A zone's names, remembered per device: its own from its Config (`Name,Zone`) — or, on the 2008
   * generation, from `Rename,Rename_Latin_1`, the path its description declares instead (RX-V3900, D15)
   * — and the Zone B name the main zone's Config carries next to it. Only a definite answer is
   * remembered (a name, or the model's own "no such node" as none); a transient failure asks again on
   * the next connect.
   *
   * @param zone the zone
   * @returns the names, "" where the zone declares none
   */
  private async probeZoneNames(zone: XmlZone): Promise<{ zone: string; zoneB: string }> {
    const rename = this.declares(zone.element, RENAME_PATH);
    const probe = async (): Promise<{ zone: string; zoneB: string }> => {
      const body = await definiteXmlBody(
        () => this.deps.client.getXml(zone.element, rename ? RENAME_GET : "<Config>GetParam</Config>"),
        `${zone.element} name probe`,
      );
      const text = (pattern: RegExp): string => {
        const match = pattern.exec(body);
        return match ? decodeXmlText(match[1]).trim() : "";
      };
      return rename
        ? { zone: text(/<Rename_Latin_1>([^<]*)<\/Rename_Latin_1>/), zoneB: "" }
        : { zone: text(/<Name>[\s\S]*?<Zone>([^<]*)<\/Zone>/), zoneB: text(/<Name>[\s\S]*?<Zone_B>([^<]*)<\/Zone_B>/) };
    };
    try {
      // Fresh on every connection — the names are the user's (D8).
      return this.deps.probeMemory
        ? await this.deps.probeMemory.refresh(`xmlZoneNames:${zone.key}`, probe)
        : await probe();
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: ${zone.element} name probe failed (${errorMessage(e)})`);
      return { zone: "", zoneB: "" };
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
    const { zone: zoneKey, name: command } = splitZone(stateId);
    if (
      !/^(remote\.(?:cursor|menu)|player\.(?:play|pause|stop|next|prev)|zoneName|multiroom\.zoneB\.name)$/.test(
        command,
      ) ||
      !this.createdStates.has(stateId)
    ) {
      return false;
    }
    const zone = this.zones.find(candidate => candidate.key === zoneKey);
    if (!zone) {
      return false;
    }
    let inner: string | undefined;
    if (command === "remote.cursor" || command === "remote.menu") {
      const word = typeof value === "string" ? value : "";
      const wire = command === "remote.cursor" ? wireFor(RETURN_CURSOR_WIRE, word) : wireFor(MENU_WIRE, word);
      if (wire === undefined) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} "${word}" is no key this receiver declares — write dropped`);
        return true;
      }
      inner =
        command === "remote.cursor"
          ? `<Cursor_Control><Cursor>${wire}</Cursor></Cursor_Control>`
          : `<Cursor_Control><Menu_Control>${wire}</Menu_Control></Cursor_Control>`;
    } else if (command === "zoneName" || command === "multiroom.zoneB.name") {
      if (typeof value !== "string") {
        return true;
      }
      // desc.xml declares the name as `Text 1,9,Latin-1` (7 descriptors) — the same rule as YNCA's
      // ZONENAME: a control character, a tenth character or one Latin-1 cannot carry is not sent
      // (audit 2026-09-24, D18).
      const problem = textWriteProblem(value, { maxLength: 9, charset: "latin1" });
      if (problem !== undefined) {
        this.deps.log.debug(`${this.deviceId}: ${stateId} "${value}" not sent — ${problem}`);
        return true;
      }
      // The name is not part of the zone status: read it back from the zone's Config — the fresh
      // probe also updates the memory, which otherwise brings the OLD name back on the next start.
      // A refused name is read back the same way, so the datapoint shows the device's name again.
      const escaped = escapeXmlText(value);
      const nameInner =
        command === "multiroom.zoneB.name"
          ? `<Config><Name><Zone_B>${escaped}</Zone_B></Name></Config>`
          : this.declares(zone.element, RENAME_PATH)
            ? `<Rename><Rename_Latin_1>${escaped}</Rename_Latin_1></Rename>`
            : `<Config><Name><Zone>${escaped}</Zone></Name></Config>`;
      void this.applyCommand({ zone: zone.element, inner: nameInner }, async () => {
        const names = await this.probeZoneNames(zone);
        const name = command === "multiroom.zoneB.name" ? names.zoneB : names.zone;
        if (name) {
          this.emit(stateId, name);
        }
      });
      return true;
    } else {
      const word = XML_TRANSPORT_WIRE[command.slice("player.".length)];
      inner = `<Play_Control><Playback>${word}</Playback></Play_Control>`;
      // A transport key changes what the player block shows — read it back with the zone (D3).
      void this.applyCommand({ zone: zone.element, inner }, async () => {
        await this.refreshZone(zone);
        await this.refreshPlayers();
      });
      return true;
    }
    void this.applyCommand({ zone: zone.element, inner }, () => this.refreshZone(zone));
    return true;
  }

  /**
   * Send a command and read what it touched back at once — an older receiver reports nothing by
   * itself, and the next poll is up to a minute away. A refused command is read back too: nothing
   * else would put the device's value back over the one the user wrote (audit 2026-09-24). Called
   * without an awaiting caller, so the whole body is one try/catch.
   *
   * @param command the zone element and the inner XML to send
   * @param readBack reads the zone, the tuner or the name the command touched
   */
  private async applyCommand(command: XmlCommand, readBack?: () => Promise<unknown>): Promise<void> {
    try {
      await this.sendCommand(command);
      await readBack?.();
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: reading back after an XML command failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Send one command; a refusal or a transport error is logged, never thrown.
   *
   * @param command the zone element and the inner XML to send
   */
  private async sendCommand(command: XmlCommand): Promise<void> {
    try {
      await this.deps.client.send(command.zone, command.inner);
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${errorMessage(e)}`);
    }
  }
}

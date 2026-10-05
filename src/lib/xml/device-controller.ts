import { catalogToObjects } from "../catalog/build-objects";
import type { CommandPriority } from "../lifecycle/command-gate";
import { INFO_ENTRIES } from "../catalog/info-objects";
import { keyedCommon, parentChannels, zoneRole, type ObjectDef } from "../catalog/types";
import { selfMap } from "../catalog/value-coerce";
import { tName } from "../i18n";
import {
  definiteXmlBody,
  isPermanentXmlRefusal,
  parseDescriptor,
  parseInputList,
  parseInputLabels,
  parseSceneList,
  parseInputSources,
  parseReadOnlyInputs,
  XmlRefusalError,
  type BasicStatus,
  type XmlDescriptor,
  type XmlDialect,
  type XmlScene,
  type XmlSystemConfig,
  type XmlZoneForm,
} from "./protocol";
import { parseXmlStatus, stateToXml, type XmlCommand } from "./command-mapper";
import { XML_AMP_CATALOG } from "./catalog";
import { errText } from "../err-text";
import { PollDropDetector } from "../lifecycle/poll-drop-detector";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";
import type { BrowseEngine } from "../browse/browse-engine";
import { createBrowseSurface } from "../browse/surface";
import { XmlBrowseDriver } from "../browse/xml-browse-driver";
import { decideBrowseSources } from "./browse-probe";
import { sceneListSurface, sceneNumber, sceneRecallStates } from "../catalog/scene-titles";
import { splitZone } from "../catalog/zones";
import { XML_ZONES, type XmlZone } from "./zones";
import { MEMORY_KEY, xmlInputsKey, xmlScenesKey, xmlStatusFieldsKey } from "../lifecycle/memory-keys";
import { HttpStatusError } from "../util";
import type { XmlControllerContext, XmlControllerDeps, XmlWriteRoute } from "./controller-context";
import { XmlTuner } from "./tuner";
import { XmlPlayerBlocks } from "./player-blocks";
import { XmlDeclaredCommands } from "./declared-commands";

/** Probe-memory key: the zones this receiver answered on — a zone stays when one Basic_Status fails. */
const ZONES_KEY = MEMORY_KEY.xmlZones;

/** XML/YNC has no push channel, so the state is polled at this interval by default. */
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

/**
 * Drives one XML/YNC device: probe which zones answer, build the amp tree, seed
 * state, and route commands both ways. XML has no push, so state is refreshed by
 * a keepalive poll. Create-only.
 *
 * The tuner surface, the player blocks and the commands desc.xml declares beyond the status catalog are parts of
 * their own ({@link XmlTuner}, {@link XmlPlayerBlocks}, {@link XmlDeclaredCommands}) that share this controller's
 * context; a user write takes the first of the write routes that serves its id.
 */
export class XmlDeviceController {
  private zones: XmlZone[] = [];
  /** The firmware (`System>Config` version) read on this connection. */
  private firmwareRead: string | undefined;
  private cancelKeepalive: (() => void) | undefined;
  private readonly dropDetector = new PollDropDetector();
  private browseEngine: BrowseEngine | undefined;
  /** The scenes each zone DECLARES (`Scene_Sel_Item`), for the recall write path. */
  private readonly scenesByZone = new Map<string, XmlScene[]>();
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
  /** Per zone: the inputs its list declares read-only (`RW` = `R`) — reported, never switched to (A51). */
  private readonly readOnlyInputs = new Map<string, ReadonlySet<string>>();
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
  /** The states built read-only because the device description declares no write for them (D11). */
  private readonly readOnlyStates = new Set<string>();
  /** What the parts share with this controller. */
  private readonly context: XmlControllerContext;
  /** The classic tuner surface. */
  private readonly tuner: XmlTuner;
  /** The "now playing" block of every zone. */
  private readonly players: XmlPlayerBlocks;
  /** The commands desc.xml declares beyond the status catalog. */
  private readonly commands: XmlDeclaredCommands;
  /** The ways a user write can take, asked in order — the first that serves the id takes it. */
  private readonly routes: readonly XmlWriteRoute[];

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   * @param pollIntervalMs how often to poll the device for state (default 60 s)
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: XmlControllerDeps,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.context = {
      deviceId,
      deps,
      emit: (id, value) => this.emit(id, value),
      ensureChannels: id => this.ensureChannels(id),
      probeXml: (key, element, inner, fresh) => this.probeXml(key, element, inner, fresh),
      applyCommand: (command, readBack) => this.applyCommand(command, readBack),
      dropWrite: (stateId, value, reason) => this.dropWrite(stateId, value, reason),
      markWritable: (stateId, write) => this.markWritable(stateId, write),
      descriptor: () => this.deviceDescriptor,
      declares: (element, path) => this.declares(element, path),
      hasCommandList: () => this.hasCommandList(),
      refreshZone: (zone, priority) => this.refreshZone(zone, priority),
      refreshPlayers: priority => this.players.refresh(this.zones, priority),
    };
    this.tuner = new XmlTuner(this.context);
    this.players = new XmlPlayerBlocks(this.context);
    this.commands = new XmlDeclaredCommands(this.context, () => this.zones);
    const declared = this.commands.routes();
    this.routes = [
      {
        serves: stateId => this.readOnlyStates.has(stateId),
        write: (stateId, value) => this.dropWrite(stateId, value, "this device declares no write for it"),
      },
      // The main zone's remote and the menu go to the browse engine, which says what became of each write (a drop as
      // "unavailable", an operation it started as "unclear" — a menu step sent twice would act twice).
      {
        serves: stateId => stateId.startsWith("remote.") && this.browseEngine !== undefined,
        write: (stateId, value) => this.browseEngine!.handleRemoteWrite(stateId, value),
      },
      declared.zoneCommands,
      {
        serves: stateId => stateId.startsWith("player.browse."),
        write: (stateId, value) =>
          this.browseEngine
            ? this.browseEngine.handleWrite(stateId, value)
            : this.dropWrite(stateId, value, "this device proved no menu"),
      },
      // Scenes and the classic tuner are device-declared (not in the static catalog).
      {
        serves: stateId => splitZone(stateId).name === "scene.recall",
        write: (id, value) => this.writeScene(id, value),
      },
      this.tuner,
      declared.systemPower,
      declared.contentsAndParty,
    ];
  }

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
      this.deps.log.debug(`${this.deviceId}: System/Config failed (${errText(e)})`);
    }
    // Freshness guard for the (persisted) probe memory: model + system id + firmware are the
    // identity this transport can read. A different (or updated) device behind the address
    // drops the remembered XML declarations (scenes, inputs, descriptor, tuner, browse
    // sources); a device that reports no model keeps them — the YNCA/YXC guards catch a swap.
    this.firmwareRead = config.version || undefined;
    if (config.model !== undefined) {
      const identity = `${config.model}|${config.systemId ?? ""}|${config.version ?? ""}`;
      if (this.deps.probeMemory.remembered(MEMORY_KEY.xmlIdentity) !== identity) {
        // Every XML-owned memory key carries the xml prefix (xmlBrowseSources, xmlScenes:*,
        // xmlInputs:*, xmlTuner, xmlConfig, xmlIdentity).
        this.deps.probeMemory.drop(key => key.startsWith("xml"));
        this.deps.probeMemory.set(MEMORY_KEY.xmlIdentity, identity);
      }
      if (config.zones || config.features || config.inputNames) {
        // Remembered for the other transports: the YNCA input list reads the source flags and
        // the input names as evidence (a flag 0 proves a source absent, a name adds an input).
        // Laid over what this receiver declared before, never in its place: an answer that lacks a
        // block (or a name) takes nothing away (2026-10-02 — a read-in receiver keeps its tree).
        const before = this.deps.probeMemory.remembered<typeof config>(MEMORY_KEY.xmlConfig);
        this.deps.probeMemory.set(MEMORY_KEY.xmlConfig, {
          ...before,
          ...config,
          ...(before?.zones || config.zones ? { zones: { ...before?.zones, ...config.zones } } : {}),
          ...(before?.features || config.features ? { features: { ...before?.features, ...config.features } } : {}),
          ...(before?.inputNames || config.inputNames
            ? { inputNames: { ...before?.inputNames, ...config.inputNames } }
            : {}),
        });
      }
    }
    const rememberedDialect = this.deps.probeMemory.remembered(MEMORY_KEY.xmlDialect);
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
    // A zone this receiver answered before stays, also when its Basic_Status failed this once — one
    // missed answer is no proof the zone is gone (2026-10-02). Its states keep the fields it delivered.
    const knownZones = this.deps.probeMemory.union(
      ZONES_KEY,
      answered.map(probe => probe.zone.key),
    );
    this.zones = XML_ZONES.filter(zone => knownZones.has(zone.key));
    const model = config.model;
    // The zone's own input list (`Input_Sel_Item`, per zone — Main and Zone 2 differ on
    // real hardware): the device says which inputs it accepts, so the input state gets a
    // dropdown instead of a free string. The labels are the user's names — asked on every connection,
    // the memory is only the fallback (D8).
    const inputsByZone = new Map<string, string[]>();
    const inputLabels = new Map<string, Record<string, string>>();
    for (const zone of this.zones) {
      const body = await this.probeXml(
        xmlInputsKey(zone.key),
        zone.element,
        "<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>",
        true, // the labels are the user's names for the inputs
      );
      inputsByZone.set(zone.key, parseInputList(body));
      inputLabels.set(zone.key, parseInputLabels(body));
      this.players.setSources(zone.key, parseInputSources(body));
      this.readOnlyInputs.set(zone.key, new Set(parseReadOnlyInputs(body)));
    }
    // The device description — the classic generation's own enumeration of programs, sleep
    // steps, Adaptive DRC values and the declared write commands (2008–2017; the 2020 generation has none).
    const descriptor = await this.probeDescriptor();
    this.commands.declare(descriptor);
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
    for (const zone of this.zones) {
      const status = answered.find(probe => probe.zone.key === zone.key)?.status;
      this.zoneFields.set(
        zone.key,
        this.deps.probeMemory.union(xmlStatusFieldsKey(zone.key), Object.keys(status ?? {})),
      );
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
    await this.tuner.setup();
    await this.commands.setupSystemPower();
    await this.commands.setupTransportKeys();
    await this.commands.setupZoneNames();
    await this.commands.setupContentsDisplay();
    await this.commands.setupPartyVolume();
    // Seed from the statuses already fetched during the probe — no second round-trip.
    for (const { zone, status } of answered) {
      if (status) {
        this.seedZone(zone, status);
      }
    }
    // What each zone's source plays — after the seed, which tells the zone's input (D3).
    await this.players.refresh(this.zones);
    await this.setupInfo(model);
    await this.setupBrowse();
    // The zone pads AFTER the browse surface: where a menu source exists the surface owns the
    // main zone's pad (zone-wide through the driver where declared), the controller adds the
    // zones' — and the main zone's on a receiver without a menu source.
    await this.commands.setupZonePads(this.browseEngine !== undefined);
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), this.pollIntervalMs);
    // The adapter logs one combined "ready" line across all transports; this stays at debug.
    this.deps.log.debug(`${this.deviceId}: Yamaha (XML) device ready (XML)`);
    return true;
  }

  /**
   * The model and the firmware (already read from System>Config by the freshness guard) as datapoints, built from the
   * one definition every protocol uses (`INFO_ENTRIES`) — where the device reports them. XML reported the model but
   * built no object for it, so the transport adapter dropped the value: on an XML-only receiver (the 2008 RX-V3900)
   * the device card showed no model, the device icon and the remembered model never followed, and `info.firmware`
   * never existed (review 2026-10-05, A5).
   *
   * @param model the model the device reported, if any
   */
  private async setupInfo(model: string | undefined): Promise<void> {
    const values: Record<string, string | undefined> = { "info.model": model, "info.firmware": this.firmwareRead };
    for (const object of catalogToObjects(INFO_ENTRIES.filter(entry => values[entry.id]))) {
      if (object.type === "state") {
        await this.ensureChannels(object.id);
        await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
        this.markWritable(object.id, false);
        this.emit(object.id, values[object.id]!);
      }
    }
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
      default:
        return undefined;
    }
  }

  /**
   * Read the device description once per device — a model property, remembered like the
   * other declarations. A 404 (the 2020 generation) is the definite "declares none" and is
   * remembered as the empty declaration; a transient failure is not remembered, so the next
   * connect asks again.
   *
   * @returns the parsed description (empty lists where the device carries none)
   */
  private async probeDescriptor(): Promise<XmlDescriptor> {
    const empty: XmlDescriptor = { programs: [], sleep: [], adaptiveDrc: [] };
    const client = this.deps.client;
    const probe = async (): Promise<XmlDescriptor> => {
      try {
        return parseDescriptor(await client.getDescriptor());
      } catch (e) {
        if (isPermanentXmlRefusal(e)) {
          return empty; // this generation has no description — definite
        }
        throw e; // transient — not remembered
      }
    };
    try {
      // `:v3` since the parse carries every declared write command (2026-09-29, D18) — an older parse lacks them.
      return await this.deps.probeMemory.once(MEMORY_KEY.xmlDescriptor, probe);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: desc.xml probe failed, asking again on the next connect (${errText(e)})`);
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
      this.deps.log.debug(`${this.deviceId}: ${key} probe failed, asking again on the next connect (${errText(e)})`);
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
        xmlScenesKey(zone.key),
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
        // The titles are the names the user gives the scenes in the receiver: they follow it while the adapter runs.
        liveLabels: true,
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
          // The declared titles as the dropdown, so the picker shows "Movie Viewing", not a bare number — and a
          // scene without a title shows its number, never an empty label (review 2026-10-05, A23).
          states: sceneRecallStates(scenes),
        },
      });
      // Visualizations read titles as VALUES (button captions — the #613 reporter's setup), and a
      // dropdown's labels are not readable: the list for widgets, a title datapoint per scene for
      // everything else (D8). Every declared scene stays — a blank title is just no title: the list names
      // the scene, and no empty title datapoint is built for it (A23, `sceneListSurface`).
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
   * A user write to a zone's `scene.recall` → the DECLARED write element
   * (`<Scene><Scene_Sel>Scene N</Scene_Sel></Scene>`). Only zones that declared
   * scenes accept the write; a refusal lands in the log via applyCommand.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  private writeScene(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    const zoneKey = splitZone(stateId).zone;
    const zone = this.zones.find(z => z.key === zoneKey);
    const scenes = this.scenesByZone.get(zoneKey);
    if (!zone || !scenes) {
      return this.dropWrite(stateId, value, "this zone declares no scenes");
    }
    // A TITLE is as valid a write as a number ("Movie Viewing" → Scene 1) — the one resolver (D16).
    const num = sceneNumber(value, scenes);
    if (!scenes.some(scene => scene.num === num)) {
      return this.dropWrite(stateId, value, "it names no scene this zone declares");
    }
    return this.applyCommand({ zone: zone.element, inner: `<Scene><Scene_Sel>Scene ${num}</Scene_Sel></Scene>` }, () =>
      this.refreshZone(zone, "user"),
    );
  }

  /**
   * Create the browsing surface (#613) when at least one source's menu answers its probe
   * (`List_Info`, or the 2008 `List_Info_2` — see XML_BROWSE_SOURCES; the menus the
   * predecessor adapter's users drove via `Realtime.*.LINE1TXT` + `xmlCommand`).
   */
  private async setupBrowse(): Promise<void> {
    const gate = this.deps.gate;
    const delay = (ms: number): Promise<void> => gate.delay(ms);
    // One verdict per source, remembered — a "not now" from one service no longer hides every other menu (A21).
    const available = await decideBrowseSources({
      deviceId: this.deviceId,
      getXml: (element, inner) => this.deps.client.getXml(element, inner),
      probeMemory: this.deps.probeMemory,
      log: this.deps.log,
    });
    if (available.size === 0) {
      return;
    }
    const log = this.deps.log;
    const driver = new XmlBrowseDriver(this.deps.client, available, delay, {
      // The driver's lines name the device, like every other line of this controller.
      log: {
        debug: message => log.debug(`${this.deviceId}: ${message}`),
        info: message => log.info(`${this.deviceId}: ${message}`),
        warn: message => log.warn(`${this.deviceId}: ${message}`),
      },
      zoneWide: this.commands.mainZonePad(),
      mainZone: {
        input: () => this.players.inputOf("main"),
        readOnly: input => this.readOnlyInputs.get("main")?.has(input) === true,
      },
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
   * both, a path production never took). The first write route that serves the id takes it.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  public handleWrite(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    const route = this.routes.find(candidate => candidate.serves(stateId));
    return route ? route.write(stateId, value) : this.writeCatalogState(stateId, value);
  }

  /**
   * A write to a state of the status catalog: claim with proof on the write way too, then the catalog's command.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  private writeCatalogState(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    // Claim with proof, on the WRITE way too. Object creation has been proof-gated since
    // 2.0.1 (only fields this device's Basic_Status really delivers), but the write path was
    // not — the comment on `createdStates` claimed otherwise while it guarded the read side
    // alone. XML was the last transport without it: YNCA writes only through its per-device
    // write map, MusicCast only through device-declared endpoints. It bites on a datapoint an
    // adapter version before 2.0.1 created and that once carried a value, so no sweep removes
    // it: writing it put a blind command on the wire that the device answers with a refusal.
    if (!this.createdStates.has(stateId)) {
      return this.dropWrite(stateId, value, "this device did not report it");
    }
    const { zone: zoneKey } = splitZone(stateId);
    const element = this.zones.find(candidate => candidate.key === zoneKey)?.element ?? "Main_Zone";
    const command = stateToXml(stateId, value, this.dialect, this.zoneForms.get(element));
    if (!command) {
      // The datapoint exists on this device and takes writes, so it is the value that names no command.
      return this.dropWrite(stateId, value, "it is no value this datapoint takes");
    }
    // The zone to read back afterwards: the command's own element, or the main zone for a
    // command that goes out on the System element (HDMI outputs, party mode).
    const zone = this.zones.find(candidate => candidate.element === command.zone) ?? this.zones[0];
    // A new input changes which source the zone's player block shows (D3).
    const players = /(^|\.)input$/.test(stateId);
    return this.applyCommand(command, async () => {
      await this.refreshZone(zone, "user");
      if (players) {
        await this.players.refresh(this.zones, "user");
      }
    });
  }

  /**
   * Drop a write that cannot go out, with its trace: one debug line naming the device, the datapoint, the value and
   * the reason (#615: a dead button leaves a trace; review 2026-10-05, A56).
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @param reason why it is not sent
   * @returns `unavailable` — this transport could not send it, so the handle may try the next protocol (Y-04)
   */
  private dropWrite(stateId: string, value: unknown, reason: string): WriteOutcome {
    const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
    this.deps.log.debug(`${this.deviceId}: ${stateId} = ${shown} not sent — ${reason}`);
    return "unavailable";
  }

  /** @returns the firmware (`System>Config` version) read on this connection, if any */
  public firmware(): string | undefined {
    return this.firmwareRead;
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
    const zone = this.zones[0];
    if (!zone) {
      return Promise.resolve(); // never started — nothing to ask, nothing to judge
    }
    return this.dropDetector.verify(() =>
      this.refreshZone(zone).catch((e: unknown) => {
        this.deps.log.debug(`${this.deviceId}: liveness probe failed: ${errText(e)}`);
        return false;
      }),
    );
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
      if (this.tuner.exists) {
        await this.tuner.refresh();
      }
      await this.commands.refresh();
      await this.players.refresh(this.zones);
      this.dropDetector.record(anyOk);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: keepalive poll failed: ${errText(e)}`);
    }
  }

  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @param priority the gate priority — `user` for the read-back of a user's write (A58)
   * @returns true if the status was fetched, false if the request failed
   */
  private async refreshZone(zone: XmlZone, priority: CommandPriority = "background"): Promise<boolean> {
    const status = await this.tryGetStatus(zone.element, priority);
    if (!status) {
      return false;
    }
    try {
      this.seedZone(zone, status);
    } catch (e) {
      // The read-back after a user write reaches this without an awaiting caller (see
      // applyCommand), so a throw would be an unhandled rejection — and that stops the
      // instance. Like the MusicCast twin, the answer stays "the device answered".
      this.deps.log.warn(`${this.deviceId}: could not apply the ${zone.key} status (${errText(e)})`);
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
      // Main/system-wide features (HDMI outputs, party, speaker terminals, Zone B) exist only on the main zone;
      // the pre-out level mode only on the zones.
      if ((entry.mainOnly && zone.key !== "main") || (entry.zonesOnly && zone.key === "main")) {
        continue;
      }
      // Claim with proof: skip what this device's status never delivered.
      if (entry.statusField !== undefined && !this.zoneFields.get(zone.key)?.has(entry.statusField)) {
        continue;
      }
      const stateId = `${zone.prefix}${entry.state}`;
      // A dotted state (e.g. sound.bass) needs its parent channel created first — named AND
      // explained from the one shared table, so the same folder cannot end up called "sound" here
      // and "Sound" there depending on which transport owns it.
      await this.ensureChannels(stateId);
      // An absent explanation key means the datapoint explains itself — the fleet standard wants
      // the field empty there rather than filled with invented prose.
      const keyed = keyedCommon(entry.common);
      // The role of the zone folder the datapoint sits in: a zone's, or Zone B's — which XML addresses through the
      // main zone but the tree shows as a zone like any other (review 2026-10-05, A27).
      const common: ObjectDef["common"] = { ...keyed, role: zoneRole(keyed.role, stateId) };
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
        // The declared words are the values of a TEXT datapoint (the tone mode's Auto/Bypass/Manual). A switch is a
        // boolean: its `On`/`Standby` words are the wire spelling of true/false, not values it takes. As a dropdown
        // they offered "Standby", which sends nothing, were lent to the YNCA-owned boolean power and mute, and kept
        // `keepsForm`/`canCarryWrite` from ever matching a switch another protocol builds (review 2026-10-05, A19).
        if (declaredPut?.words && !common.states && common.type === "string") {
          common.states = selfMap(declaredPut.words);
        }
      }
      // A number the user sets is a level, one the device only reports a value.
      if (common.role === "value" && common.write) {
        common.role = "level";
      } else if (common.role === "level" && !common.write) {
        common.role = "value";
      }
      await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
        id: stateId,
        type: "state",
        common,
        ...(declared ? { declaredStates: true } : {}),
        // The input labels are the names the user gives the sockets in the receiver (`Input_Sel_Item` titles, read on
        // every connection): they follow it while the adapter runs, as on YNCA and MusicCast (Y-25).
        ...(declared && entry.state === "input" ? { liveLabels: true } : {}),
      });
      this.markWritable(stateId, common.write === true);
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
      this.players.noteInput(zone.key, status.input);
    }
    // Where no desc.xml declares the zone's form, its own status shows it (the 2020 generation, D6).
    if (status.zoneForm) {
      this.zoneForms.set(zone.element, { ...this.zoneForms.get(zone.element), ...status.zoneForm });
    }
    if (status.dialect !== undefined && status.dialect !== this.dialect) {
      this.dialect = status.dialect;
      this.deps.probeMemory.set(MEMORY_KEY.xmlDialect, status.dialect);
    }
    // A field the device delivers for the FIRST time mid-run has no object yet
    // (claim-with-proof creates only proven fields at start): remember it, build its object
    // now and write it once the object exists — the write below skips it, so no state lands
    // without an object.
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
        this.deps.probeMemory.set(xmlStatusFieldsKey(zone.key), [...known]);
        // 2.7.0: the objects for the new fields are built NOW and their values written right
        // after, instead of appearing one start later. The transport adapter signals the handle,
        // which adds them to the tree. A field that VANISHES from a later poll removes nothing —
        // `zoneFields` is a union, and only the completion of a read-in may shrink the tree.
        void this.createZoneStates(zone)
          .then(() => {
            for (const update of parseXmlStatus(status, zone.key)) {
              if (this.createdStates.has(update.id)) {
                this.emit(update.id, update.value);
              }
            }
          })
          .catch((e: unknown) => {
            this.deps.log.debug(`${this.deviceId}: could not create the new status fields: ${errText(e)}`);
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
   * @param priority the gate priority
   * @returns the parsed status, or undefined on failure
   */
  private async tryGetStatus(
    element: string,
    priority: CommandPriority = "background",
  ): Promise<BasicStatus | undefined> {
    try {
      return await this.deps.client.getStatus(element, priority);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${element}) failed: ${errText(e)}`);
      return undefined;
    }
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
   * Record a state as created, and as read-only where it is not writable.
   *
   * @param stateId the state id
   * @param write whether it is writable
   */
  private markWritable(stateId: string, write = true): void {
    this.createdStates.add(stateId);
    if (write) {
      this.readOnlyStates.delete(stateId);
    } else {
      this.readOnlyStates.add(stateId);
    }
  }

  /**
   * Send a command and read what it touched back at once — an older receiver reports nothing by
   * itself, and the next poll is up to a minute away. A refused command is read back too: nothing
   * else would put the device's value back over the one the user wrote (audit 2026-09-24). Called
   * without an awaiting caller, so the whole body is one try/catch. The read-back runs at `user` priority (A58).
   *
   * A command nobody answered asks at once whether the device is still there — only MusicCast did: a powerless XML
   * receiver stayed "connected" for up to three poll minutes while every write merely warned (review 2026-10-05,
   * A55). Its read-back is the liveness question's answer.
   *
   * @param command the zone element and the inner XML to send
   * @param readBack reads the zone, the tuner or the name the command touched
   * @returns what became of the command
   */
  private async applyCommand(command: XmlCommand, readBack?: () => Promise<unknown>): Promise<WriteOutcome> {
    const outcome = await this.sendCommand(command);
    if (outcome === "unavailable") {
      void this.verifyAlive();
      return outcome;
    }
    // Read back behind the answer, so the caller learns at once what the device made of the command.
    void (async () => {
      try {
        await readBack?.();
      } catch (e) {
        this.deps.log.warn(`${this.deviceId}: reading back after an XML command failed: ${errText(e)}`);
      }
    })();
    return outcome;
  }

  /**
   * Send one command; a refusal or a transport error is logged, never thrown.
   *
   * @param command the zone element and the inner XML to send
   * @returns `sent`, `refused` (a return code, an empty answer, an HTTP 400) or `unavailable` (no answer)
   */
  private async sendCommand(command: XmlCommand): Promise<WriteOutcome> {
    try {
      await this.deps.client.send(command.zone, command.inner);
      return "sent";
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${errText(e)}`);
      // An answer that says no — a return code, or an HTTP status outside 2xx — is a refusal; only a request
      // nobody answered is "unavailable" (review 2026-10-05, E: the message text decided before).
      return e instanceof XmlRefusalError || e instanceof HttpStatusError ? "refused" : "unavailable";
    }
  }
}

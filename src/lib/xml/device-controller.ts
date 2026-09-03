import { CHANNEL_NAME_KEYS, type ObjectDef } from "../catalog/types";
import { tName } from "../i18n";
import {
  isPermanentXmlRefusal,
  parseInputList,
  parseReturnCode,
  parseSceneList,
  parseTunerInfo,
  type BasicStatus,
  type XmlScene,
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
import { XML_BROWSE_SOURCES, XmlBrowseDriver } from "../browse/xml-browse-driver";

/** XML/YNC has no push channel, so the state is polled at this interval by default. */
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

interface XmlZone {
  /** Unified zone key (`main`, `zone2`, …). */
  key: string;
  /** XML zone element (`Main_Zone`, `Zone_2`, …). */
  element: string;
  /** State-id prefix for the zone. */
  prefix: string;
}

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
  /** Read the device's model name (System > Config). */
  getModelName(): Promise<string | undefined>;
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
  /** Per zone: the Basic_Status fields this device is known to deliver (persisted union). */
  private readonly zoneFields = new Map<string, Set<string>>();

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
    // Probe all zones in parallel and keep each answering zone's status, so a zone is
    // fetched once (for the probe) and seeded from that same response — not twice.
    const probes = await Promise.all(
      XML_ZONES.map(async zone => ({ zone, status: await this.tryGetStatus(zone.element) })),
    );
    const answered = probes.filter(probe => probe.status && Object.keys(probe.status).length > 0);
    if (!answered.some(probe => probe.zone.key === "main")) {
      this.deps.log.debug(`${this.deviceId}: no XML main zone — creating no objects`);
      return false;
    }
    this.zones = answered.map(probe => probe.zone);
    // Freshness guard for the (persisted) probe memory: the model name is the identity
    // this transport can read. A different device behind the address drops the
    // remembered XML declarations (scenes, inputs, tuner, browse sources); a device
    // that reports no model keeps them — the YNCA/YXC guards catch a swap there.
    let model: string | undefined;
    try {
      model = await this.deps.client.getModelName();
      if (model !== undefined && this.deps.probeMemory) {
        if (this.deps.probeMemory.remembered("xmlModel") !== model) {
          // Every XML-owned memory key carries the xml prefix (xmlBrowseSources,
          // xmlScenes:*, xmlInputs:*, xmlTuner, xmlModel).
          this.deps.probeMemory.drop(key => key.startsWith("xml"));
          this.deps.probeMemory.set("xmlModel", model);
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getModelName failed (${errorMessage(e)})`);
    }
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
    // and named from the shared CHANNEL_NAME_KEYS table (a zone that answered has at least
    // its power state, so its channel always comes into being this way).
    const createdChannels = new Set<string>();
    for (const zone of this.zones) {
      for (const entry of XML_AMP_CATALOG) {
        // Main/system-wide features (scenes, HDMI outputs, party) exist only on the main zone.
        if (entry.mainOnly && zone.key !== "main") {
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
              common: {
                // Capitalised like the catalog path does it, so the same folder cannot end up
                // called "sound" here and "Sound" there depending on which transport owns it.
                name: CHANNEL_NAME_KEYS[segments[i - 1]]
                  ? tName(CHANNEL_NAME_KEYS[segments[i - 1]])
                  : segments[i - 1].charAt(0).toUpperCase() + segments[i - 1].slice(1),
              },
            });
          }
        }
        const { nameKey, ...rest } = entry.common;
        const common: ObjectDef["common"] = { ...rest, name: tName(nameKey) };
        // The device's own input list becomes the dropdown (XML-owned devices only —
        // where YNCA is present its dropdown wins via the owner policy).
        const inputs = entry.state === "input" ? inputsByZone.get(zone.key) : undefined;
        if (inputs && inputs.length > 0) {
          common.states = Object.fromEntries(inputs.map(input => [input, input]));
        }
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common,
        });
        this.createdStates.add(stateId);
      }
    }
    await this.setupScenes(createdChannels);
    await this.setupTuner(createdChannels);
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
          common: { name: tName(CHANNEL_NAME_KEYS.scene ?? "Scenes") },
        });
      }
      const max = Math.max(...scenes.map(scene => scene.num));
      await this.deps.upsertObject(`${this.deviceId}.${channelId}.recall`, {
        id: `${channelId}.recall`,
        type: "state",
        common: {
          name: tName("Recall scene"),
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
        common: { name: tName("Scenes (number + title)"), type: "string", role: "json", read: true, write: false },
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
        common: { name: tName(CHANNEL_NAME_KEYS.tuner ?? "Tuner") },
      });
    }
    const state = async (id: string, common: ObjectDef["common"]): Promise<void> => {
      await this.deps.upsertObject(`${this.deviceId}.tuner.${id}`, { id: `tuner.${id}`, type: "state", common });
    };
    await state("preset", {
      name: tName("Preset (recall by number)"),
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
      name: tName("Frequency"),
      type: "number",
      role: "value",
      unit: "kHz",
      read: true,
      write: false,
    });
    await state("rdsService", { name: tName("RDS station"), type: "string", role: "text", read: true, write: false });
    await state("rdsText", { name: tName("RDS text"), type: "string", role: "text", read: true, write: false });
    await state("tuned", {
      name: tName("Tuned to a station"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    });
    await state("stereo", {
      name: tName("Stereo reception"),
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
    const driver = new XmlBrowseDriver(this.deps.client, available, delay);
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
    const command = stateToXml(stateId, value);
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
   * Write a zone's amp states from an already-fetched Basic_Status (used to seed
   * from the start-up probe without a second round-trip).
   *
   * @param zone the zone the status belongs to
   * @param status the parsed Basic_Status
   */
  private seedZone(zone: XmlZone, status: BasicStatus): void {
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
  private async applyCommand(command: XmlCommand): Promise<void> {
    try {
      await this.deps.client.send(command.zone, command.inner);
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${errorMessage(e)}`);
    }
  }
}

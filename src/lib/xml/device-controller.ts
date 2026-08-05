import type { ObjectDef } from "../catalog/types";
import type { BasicStatus } from "./protocol";
import { parseXmlStatus, stateToXml, type XmlCommand } from "./command-mapper";
import { XML_AMP_CATALOG } from "./catalog";
import type { ConnectionHandle, ControllerLog } from "../controller";
import { errorMessage } from "../util";

/** XML/YNC has no push channel, so the state is polled at this interval. */
const KEEPALIVE_MS = 60 * 1000;

/**
 * Report a drop after this many consecutive polls in which every zone failed. XML
 * has neither push nor a socket-drop event, so a run of failed polls is the only
 * signal that the device is gone — letting the supervisor reconnect.
 */
const MAX_KEEPALIVE_FAILURES = 3;

interface XmlZone {
  /** Unified zone key (`main`, `zone2`, …). */
  key: string;
  /** XML zone element (`Main_Zone`, `Zone_2`, …). */
  element: string;
  /** State-id prefix for the zone. */
  prefix: string;
  /** Channel id for a non-main zone. */
  channel?: string;
  /** Channel display name. */
  channelName?: string;
}

const XML_ZONES: XmlZone[] = [
  { key: "main", element: "Main_Zone", prefix: "" },
  { key: "zone2", element: "Zone_2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { key: "zone3", element: "Zone_3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { key: "zone4", element: "Zone_4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" },
];

/** The subset of the XML client the controller uses (so tests can inject a fake). */
export interface XmlClientLike {
  /** Read a zone's Basic_Status. */
  getStatus(zone: string): Promise<BasicStatus>;
  /** Send an inner command to a zone. */
  send(zone: string, inner: string): Promise<void>;
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
}

/**
 * Drives one XML/YNC device: probe which zones answer, build the amp tree, seed
 * state, and route commands both ways. XML has no push, so state is refreshed by
 * a keepalive poll. Create-only.
 */
export class XmlDeviceController implements ConnectionHandle {
  private zones: XmlZone[] = [];
  private cancelKeepalive: (() => void) | undefined;
  private dropHandler: ((reason?: Error) => void) | undefined;
  private failedKeepalives = 0;
  private dropped = false;

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: XmlControllerDeps,
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
    for (const zone of this.zones) {
      if (zone.channel) {
        await this.deps.upsertObject(`${this.deviceId}.${zone.channel}`, {
          id: zone.channel,
          type: "channel",
          common: { name: zone.channelName ?? zone.channel },
        });
      }
      for (const entry of XML_AMP_CATALOG) {
        await this.deps.upsertObject(`${this.deviceId}.${zone.prefix}${entry.state}`, {
          id: `${zone.prefix}${entry.state}`,
          type: "state",
          common: { ...entry.common },
        });
      }
    }
    // Seed from the statuses already fetched during the probe — no second round-trip.
    for (const { zone, status } of answered) {
      if (status) {
        this.seedZone(zone, status);
      }
    }
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    this.deps.log.info(`${this.deviceId}: Yamaha (XML) device ready`);
    return true;
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
    const command = stateToXml(fullStateId.slice(prefix.length), value);
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
    this.dropHandler = cb;
  }

  /** Cancel the keepalive poll. Synchronous — safe to call from onUnload. */
  public close(): void {
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
  }

  /**
   * Poll every live zone. If every zone fails for MAX_KEEPALIVE_FAILURES polls in a
   * row, the device is judged gone and a drop is reported so the supervisor reconnects.
   */
  private async keepalive(): Promise<void> {
    let anyOk = false;
    for (const zone of this.zones) {
      if (await this.refreshZone(zone)) {
        anyOk = true;
      }
    }
    if (anyOk) {
      this.failedKeepalives = 0;
    } else if (++this.failedKeepalives >= MAX_KEEPALIVE_FAILURES) {
      this.reportDrop();
    }
  }

  /** Report a drop once — the supervisor then closes this controller and reconnects. */
  private reportDrop(): void {
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    this.dropHandler?.(new Error(`${MAX_KEEPALIVE_FAILURES} polls failed`));
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
    for (const update of parseXmlStatus(status, zone.key)) {
      this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
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

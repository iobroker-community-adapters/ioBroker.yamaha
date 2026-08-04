import type { ObjectDef } from "../catalog/types";
import type { BasicStatus } from "./protocol";
import { parseXmlStatus, stateToXml, type XmlCommand } from "./command-mapper";

/** XML/YNC has no push channel, so the state is polled at this interval. */
const KEEPALIVE_MS = 60 * 1000;

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

/** The amplifier states an XML zone exposes (Basic_Status fields). */
const XML_AMP_STATES: Array<{ state: string; common: ObjectDef["common"] }> = [
  { state: "power", common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true } },
  {
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true, unit: "dB" },
  },
  { state: "mute", common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true } },
  { state: "input", common: { name: "Input", type: "string", role: "media.input", read: true, write: true } },
];

/** The subset of the XML client the controller uses (so tests can inject a fake). */
export interface XmlClientLike {
  /** Read a zone's Basic_Status. */
  getStatus(zone: string): Promise<BasicStatus>;
  /** Send an inner command to a zone. */
  send(zone: string, inner: string): Promise<void>;
}

/** Log surface the controller needs. */
export interface XmlControllerLog {
  /** Routine detail. */
  debug(message: string): void;
  /** Relevant events. */
  info(message: string): void;
  /** Warnings. */
  warn(message: string): void;
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
  log: XmlControllerLog;
}

/**
 * Drives one XML/YNC device: probe which zones answer, build the amp tree, seed
 * state, and route commands both ways. XML has no push, so state is refreshed by
 * a keepalive poll. Create-only.
 */
export class XmlDeviceController {
  private zones: XmlZone[] = [];
  private cancelKeepalive: (() => void) | undefined;

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
    for (const zone of XML_ZONES) {
      const status = await this.tryGetStatus(zone.element);
      if (status && Object.keys(status).length > 0) {
        this.zones.push(zone);
      } else if (zone.key === "main") {
        this.deps.log.debug(`${this.deviceId}: no XML main zone — creating no objects`);
        return false;
      }
    }
    if (this.zones.length === 0) {
      return false;
    }
    for (const zone of this.zones) {
      if (zone.channel) {
        await this.deps.upsertObject(`${this.deviceId}.${zone.channel}`, {
          id: zone.channel,
          type: "channel",
          common: { name: zone.channelName ?? zone.channel },
        });
      }
      for (const state of XML_AMP_STATES) {
        await this.deps.upsertObject(`${this.deviceId}.${zone.prefix}${state.state}`, {
          id: `${zone.prefix}${state.state}`,
          type: "state",
          common: { ...state.common },
        });
      }
    }
    for (const zone of this.zones) {
      await this.refreshZone(zone);
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

  /** Cancel the keepalive poll. Synchronous — safe to call from onUnload. */
  public close(): void {
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
  }

  /** Poll every live zone's status. */
  private async keepalive(): Promise<void> {
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
  }

  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   */
  private async refreshZone(zone: XmlZone): Promise<void> {
    const status = await this.tryGetStatus(zone.element);
    if (!status) {
      return;
    }
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
      this.deps.log.debug(
        `${this.deviceId}: getStatus(${element}) failed: ${e instanceof Error ? e.message : String(e)}`,
      );
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
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

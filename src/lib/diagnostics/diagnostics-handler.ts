import type { DeviceIdentity } from "../device-identity";
import { errText } from "../err-text";
import type { HandleCapture } from "./types";
import type { LogRing } from "./log-ring";
import type { TrafficSnapshot } from "./traffic-recorder";
import {
  diagnosticsExport,
  type EnvironmentSnapshot,
  type InstanceInfo,
  type MusiccastStatus,
  type ObjectTreeEntry,
} from "./report";

/** The protocol flags a device carries under `info.transports`. */
const TRANSPORTS = ["ynca", "yxc", "xml"] as const;

/** Shortest gap after a finished report before the next one of the same device — a double click is not two sweeps. */
export const DIAGNOSTICS_COOLDOWN_MS = 2_000;

/** One device as the admin's diagnostics card lists it. */
export interface DiagnosticsDevice {
  /** The device id (the object id below the instance). */
  value: string;
  /** What the card shows. */
  label: string;
  /** Whether it is connected — an unconnected device still gets a report, without the live read. */
  connected: boolean;
}

/** A finished report: the file name and the JSON text. */
export interface DiagnosticsReport {
  /** The name to save it under. */
  fileName: string;
  /** The report JSON. */
  content: string;
}

/** One running device, as the adapter knows it. */
export interface DiagnosticsDeviceState {
  /** The device id. */
  id: string;
  /** Its address (or host name). */
  ip: string;
  /** How it came into the list. */
  source?: string;
  /** Its model, as remembered. */
  model?: string;
  /** Its display name. */
  label?: string;
  /** Its serial/MAC. */
  identity?: DeviceIdentity;
  /** Whether it is connected. */
  connected: boolean;
  /** Whether its volume reads 0–100 %. */
  volumeAsPercent?: boolean;
  /** Whether its MusicCast events arrive: `unknown`, `alive`, `dead`. */
  pushEvents?: string;
  /** Read the device through its running connection; undefined when it is not connected. */
  capture(): Promise<HandleCapture | undefined>;
  /** What the device's diagnostics trail holds right now (traffic, commands, connection history, last owners). */
  trail?(): TrafficSnapshot | undefined;
}

/** What the handler reads from the running adapter. */
export interface DiagnosticsHost {
  /** The instance, e.g. `yamaha.0`. */
  readonly namespace: string;
  /** The adapter version. */
  readonly version: string;
  /** The host this instance runs on. */
  readonly hostName: string;
  /** The system language. */
  readonly systemLanguage?: string;
  /** When this run started (ms). */
  readonly startedAt: number;
  /** The instance settings, without anything that names an address. */
  readonly config: Record<string, unknown>;
  /** The adapter's recent log lines. */
  readonly logRing: LogRing;
  /** The shared MusicCast event port: bound, or held by another program. */
  pushPort(): { listening: boolean; blocked: boolean };
  /** The devices this instance runs right now. */
  devices(): DiagnosticsDeviceState[];
  /** Read one object. */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Read one state. */
  getForeignStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  /**
   * Read every state a pattern (or a list of ids) names, in one round trip. Optional: without it the
   * handler reads state by state.
   */
  getForeignStatesAsync?(pattern: string | string[]): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Read a range of objects. */
  getObjectViewAsync(
    design: "system",
    search: "state" | "instance",
    params: { startkey: string; endkey: string },
  ): Promise<{ rows: Array<{ id: string; value: ioBroker.Object | null }> } | null | undefined>;
  /** The adapter log. */
  log: { info(message: string): void; warn(message: string): void; debug(message: string): void };
}

/**
 * Answers the admin's `diagnostics` message: `list` names the devices, `export` reads one device and
 * hands back the report as a file (name + JSON). Nothing is stored in the instance — the answer is the
 * only copy, the admin offers it as a download (govee-smart 2.37.0, the same path).
 */
export class DiagnosticsHandler {
  /** The devices a report is being made for right now — one read at a time per device. */
  private readonly running = new Set<string>();
  /** When the last report per device finished. */
  private readonly finished = new Map<string, number>();

  /**
   * @param host the running adapter
   * @param now the clock (injectable for tests)
   */
  public constructor(
    private readonly host: DiagnosticsHost,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Answer one message.
   *
   * @param payload the message's payload: `{ action: "list" }` or `{ action: "export", device }`
   * @returns the answer for the admin
   */
  public async handle(payload: unknown): Promise<unknown> {
    const { action, device } = (typeof payload === "object" && payload !== null ? payload : {}) as {
      action?: unknown;
      device?: unknown;
    };
    if (action === "list") {
      return { devices: this.list() };
    }
    if (action === "export") {
      return this.export(typeof device === "string" ? device : "");
    }
    return { error: `unknown diagnostics action '${String(action)}'` };
  }

  /**
   * The devices the card lists — every running one, connected or not: a report is wanted exactly when
   * a device misbehaves.
   *
   * @returns the devices, by label
   */
  public list(): DiagnosticsDevice[] {
    return this.host
      .devices()
      .map(device => ({
        value: device.id,
        label: device.label && device.label !== device.id ? `${device.label} (${device.id})` : device.id,
        connected: device.connected,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Read one device and build its report.
   *
   * @param deviceId the device id
   * @returns the report, or the reason there is none
   */
  public async export(deviceId: string): Promise<DiagnosticsReport | { error: string }> {
    const devices = this.host.devices();
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
      return { error: `unknown device '${deviceId}'` };
    }
    const now = this.now();
    if (
      this.running.has(deviceId) ||
      now - (this.finished.get(deviceId) ?? Number.NEGATIVE_INFINITY) < DIAGNOSTICS_COOLDOWN_MS
    ) {
      return { error: "a report for this device is being made right now — try again in a moment" };
    }
    this.running.add(deviceId);
    try {
      this.host.log.info(`${deviceId}: reading the device for a diagnostics report — this takes up to a minute`);
      // The trail first: the live read below goes through the same clients and would push the history out of the
      // rings it is meant to stand beside (plan „Diagnosebericht“).
      const trail = device.trail?.();
      let connection: HandleCapture | undefined;
      let connectionNote: string | undefined;
      try {
        // Not connected: the report says so itself (its default note).
        connection = await device.capture();
      } catch (e) {
        connectionNote = `live read failed: ${errText(e)}`;
      }
      const prefix = `${this.host.namespace}.${deviceId}`;
      const [environment, deviceObject, { objectTree, transports }] = await Promise.all([
        this.environment(devices),
        this.host.getForeignObjectAsync(prefix).catch(() => null),
        this.deviceTree(prefix),
      ]);
      const others = devices.filter(d => d.id !== deviceId).flatMap(d => [d.id, d.ip]);
      const report = diagnosticsExport({
        adapterVersion: this.host.version,
        now: new Date(this.now()),
        environment,
        device: {
          id: device.id,
          ip: device.ip,
          source: device.source,
          model: device.model,
          label: device.label,
          identity: device.identity,
          connected: device.connected,
          transports,
          volumeAsPercent: device.volumeAsPercent,
          pushEvents: device.pushEvents,
        },
        profile: (deviceObject?.native as Record<string, unknown> | undefined) ?? undefined,
        connection,
        connectionNote,
        trail,
        objectTree,
        logs: this.host.logRing.about([device.id, device.ip], others),
      });
      this.host.log.info(`${deviceId}: diagnostics report ready (${report.fileName})`);
      return report;
    } catch (e) {
      this.host.log.warn(`${deviceId}: diagnostics report failed: ${errText(e)}`);
      return { error: `report failed: ${errText(e)}` };
    } finally {
      this.running.delete(deviceId);
      this.finished.set(deviceId, this.now());
    }
  }

  /**
   * The installation around the adapter — every field here used to be a follow-up question on an issue.
   *
   * @param devices the running devices
   * @returns the snapshot
   */
  private async environment(devices: readonly DiagnosticsDeviceState[]): Promise<EnvironmentSnapshot> {
    const [host, musiccast] = await Promise.all([
      this.host.getForeignObjectAsync(`system.host.${this.host.hostName}`).catch(() => null),
      this.musiccast(),
    ]);
    const port = this.host.pushPort();
    return {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      jsController: (host?.common as { installedVersion?: string } | undefined)?.installedVersion,
      systemLanguage: this.host.systemLanguage,
      musiccast,
      musiccastClient: { pushPortBlocked: port.blocked, pushPortListening: port.listening },
      config: this.host.config,
      devices: { running: devices.length, connected: devices.filter(d => d.connected).length },
      startedAt: new Date(this.host.startedAt).toISOString(),
    };
  }

  /**
   * Whether the musiccast adapter is installed, and its instances — read straight from the objects
   * js-controller keeps for every installed adapter (`system.adapter.musiccast`) and every instance
   * (`system.adapter.musiccast.<n>`, its `alive` state). READ ONLY: nothing of it is written, started,
   * stopped or removed (Y-11 — the documentation tells the user to remove it).
   *
   * @returns its status, version and instances
   */
  private async musiccast(): Promise<EnvironmentSnapshot["musiccast"]> {
    const adapter = await this.host.getForeignObjectAsync("system.adapter.musiccast").catch(() => null);
    const start = "system.adapter.musiccast.";
    const view = await this.host
      .getObjectViewAsync("system", "instance", { startkey: start, endkey: `${start}\u9999` })
      .catch(() => null);
    const rows = (view?.rows ?? []).filter(row => /^\d+$/.test(row.id.slice(start.length)));
    const aliveIds = rows.map(row => `${row.id}.alive`);
    const alive = aliveIds.length > 0 ? await this.readStates(aliveIds, aliveIds) : {};
    const instances: InstanceInfo[] = rows.map(row => ({
      instance: `musiccast.${row.id.slice(start.length)}`,
      enabled: (row.value?.common as { enabled?: unknown } | undefined)?.enabled === true,
      alive: alive[`${row.id}.alive`]?.val === true,
    }));
    const installed = Boolean(adapter) || instances.length > 0;
    return {
      status: musiccastStatus(installed, instances),
      installed,
      version: (adapter?.common as { version?: string } | undefined)?.version,
      instances,
    };
  }

  /**
   * The device's datapoints as they really exist — type, role, unit, limits, value list and value: the
   * answer to "this datapoint is missing / has the wrong list", which no in-memory view gives — and its
   * protocol flags (`info.transports.*`) as the card shows them. ONE device's subtree, never the whole
   * instance, its values in ONE read.
   *
   * @param prefix the device's full id
   * @returns one entry per datapoint, and transport → connected
   */
  private async deviceTree(
    prefix: string,
  ): Promise<{ objectTree: ObjectTreeEntry[]; transports: Record<string, boolean> }> {
    const start = `${prefix}.`;
    const view = await this.host
      .getObjectViewAsync("system", "state", { startkey: start, endkey: `${start}\u9999` })
      .catch(() => null);
    const rows = view?.rows ?? [];
    const flags = TRANSPORTS.map(transport => `${start}info.transports.${transport}`);
    const states = await this.readStates(`${start}*`, [...rows.map(row => row.id), ...flags]);
    const objectTree = rows.map(row => {
      const common = (row.value?.common ?? {}) as Partial<ioBroker.StateCommon>;
      const state = states[row.id];
      return {
        id: row.id.slice(start.length),
        type: common.type,
        role: common.role,
        unit: common.unit,
        read: common.read,
        write: common.write,
        min: common.min,
        max: common.max,
        step: common.step,
        states: common.states,
        val: state?.val,
        ack: state?.ack,
      };
    });
    const transports = Object.fromEntries(
      TRANSPORTS.map((transport, index) => [transport, states[flags[index]]?.val === true]),
    );
    return { objectTree, transports };
  }

  /**
   * Read states: in one round trip where the host offers a bulk read, one by one where it does not — a
   * receiver with 900 datapoints cost 900 reads per report (review 2026-10-05, B8).
   *
   * @param pattern what the bulk read is asked for (a pattern or the ids)
   * @param ids the ids the caller needs — what the one-by-one read asks
   * @returns id → state
   */
  private async readStates(
    pattern: string | string[],
    ids: readonly string[],
  ): Promise<Record<string, ioBroker.State | null | undefined>> {
    if (this.host.getForeignStatesAsync) {
      return (await this.host.getForeignStatesAsync(pattern).catch(() => null)) ?? {};
    }
    const out: Record<string, ioBroker.State | null | undefined> = {};
    for (const id of ids) {
      out[id] = await this.host.getForeignStateAsync(id).catch(() => null);
    }
    return out;
  }
}

/**
 * The musiccast adapter in one word: whether it is there at all, and whether it is merely installed,
 * switched off, switched on but not running, or running — only a RUNNING one competes for the receiver's
 * events and polls it next to this adapter.
 *
 * @param installed whether the adapter object exists
 * @param instances its instances
 * @returns the status
 */
export function musiccastStatus(installed: boolean, instances: readonly InstanceInfo[]): MusiccastStatus {
  if (!installed) {
    return "not installed";
  }
  if (instances.length === 0) {
    return "installed, no instance";
  }
  if (instances.some(instance => instance.alive)) {
    return "running";
  }
  if (instances.some(instance => instance.enabled)) {
    return "switched on, not running";
  }
  return "installed, switched off";
}

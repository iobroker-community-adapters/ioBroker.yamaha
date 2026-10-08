import type { DeviceIdentity } from "../device-identity";
import type { HandleCapture, TransportCapture } from "./types";
import type { LogRing } from "./log-ring";
import type { TrafficSnapshot } from "./traffic-recorder";
import type { ReportBody, ReportSource, ReportSourceDevice } from "./report-jobs";
import {
  buildReportBody,
  type EnvironmentSnapshot,
  type InstanceInfo,
  type MusiccastStatus,
  type ObjectTreeEntry,
} from "./report";

/** The protocol flags a device carries under `info.transports`. */
const TRANSPORTS = ["ynca", "yxc", "xml"] as const;

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
 * yamaha's side of the fleet master `ReportJobs` (page "Diagnosebericht — Flottenstandard"): its devices, the live read
 * of a connected receiver over every protocol it speaks (read only, through the running clients), and the report body.
 * The trail (traffic, commands, connection history) is taken BEFORE the live read — that read goes through the same
 * clients and would push the history out of the rings it is meant to stand beside (plan „Diagnosebericht“).
 */
export class YamahaReportSource implements ReportSource<HandleCapture | undefined> {
  public readonly adapter = "yamaha";
  /** The trail per device, taken at the start of its live read and used by its body. */
  private readonly trails = new Map<string, TrafficSnapshot | undefined>();

  /**
   * @param host the running adapter
   */
  public constructor(private readonly host: DiagnosticsHost) {}

  /** @returns the adapter version */
  public get version(): string {
    return this.host.version;
  }

  /** @returns the adapter log */
  public get log(): { info(message: string): void; warn(message: string): void } {
    return this.host.log;
  }

  /** @returns every running device, connected or not — a report is wanted exactly when a device misbehaves */
  public devices(): ReportSourceDevice[] {
    return this.host.devices().map(device => ({ id: device.id, label: device.label, connected: device.connected }));
  }

  /**
   * Read one connected receiver live.
   *
   * @param id the device id
   * @returns what the running connection read; undefined when it lost the connection meanwhile
   */
  public async readLive(id: string): Promise<HandleCapture | undefined> {
    const device = this.device(id);
    this.trails.set(id, device.trail?.());
    this.host.log.info(`${id}: reading the device for a diagnostics report — this takes up to a minute`);
    const live = await device.capture();
    // A read nobody answered is a failed read, never `read` (round 104, DB-02): no transport got a single answer.
    if (!live?.captures.some(answeredSomething)) {
      throw new Error(live ? "the device answered nothing" : "the connection was lost during the read");
    }
    return live;
  }

  /**
   * Build one device's report body.
   *
   * @param id the device id
   * @param live what the live read returned (undefined when not connected or it failed)
   * @param liveError why the live read failed
   * @returns the body and the device id as the report shows it
   */
  public async build(id: string, live: HandleCapture | undefined, liveError: string | undefined): Promise<ReportBody> {
    const devices = this.host.devices();
    const device = this.device(id);
    const trail = this.trails.has(id) ? this.trails.get(id) : device.trail?.();
    this.trails.delete(id);
    const prefix = `${this.host.namespace}.${id}`;
    const [environment, deviceObject, { objectTree, transports, offlineSince }] = await Promise.all([
      this.environment(devices),
      this.host.getForeignObjectAsync(prefix).catch(() => null),
      this.deviceTree(prefix),
    ]);
    const others = devices.filter(d => d.id !== id).flatMap(d => [d.id, d.ip]);
    return buildReportBody({
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
      connection: live,
      connectionNote: liveError !== undefined ? `live read failed: ${liveError}` : undefined,
      trail,
      offlineSince,
      objectTree,
      logs: this.host.logRing.about([device.id, device.ip], others),
    });
  }

  /**
   * One running device.
   *
   * @param id the device id
   * @returns the device
   */
  private device(id: string): DiagnosticsDeviceState {
    const device = this.host.devices().find(d => d.id === id);
    if (!device) {
      throw new Error(`unknown device '${id}'`);
    }
    return device;
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
   * @returns one entry per datapoint, transport → connected, and when `info.connection` last turned false
   */
  private async deviceTree(
    prefix: string,
  ): Promise<{ objectTree: ObjectTreeEntry[]; transports: Record<string, boolean>; offlineSince?: string }> {
    const start = `${prefix}.`;
    const view = await this.host
      .getObjectViewAsync("system", "state", { startkey: start, endkey: `${start}\u9999` })
      .catch(() => null);
    const rows = view?.rows ?? [];
    const flags = TRANSPORTS.map(transport => `${start}info.transports.${transport}`);
    const connectionId = `${start}info.connection`;
    const states = await this.readStates(`${start}*`, [...rows.map(row => row.id), ...flags, connectionId]);
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
    const connection = states[connectionId];
    const offlineSince =
      connection?.val === false && typeof connection.lc === "number"
        ? new Date(connection.lc).toISOString()
        : undefined;
    return { objectTree, transports, offlineSince };
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

/**
 * Whether one protocol's live read got at least one answer from the device — a line, a body, a refusal or a
 * description. A transport failure (`{ error }`) is no answer.
 *
 * @param capture the read
 * @returns true when the device answered something
 */
export function answeredSomething(capture: TransportCapture): boolean {
  if ((capture.lines?.length ?? 0) > 0 || (capture.descriptor !== undefined && capture.descriptor !== null)) {
    return true;
  }
  return Object.values(capture.answers).some(
    answer => !(typeof answer === "object" && answer !== null && Object.keys(answer).length === 1 && "error" in answer),
  );
}

import type { DeviceIdentity } from "../device-identity";
import type { HandleCapture, TransportCapture } from "./types";
import type { LogLine } from "./log-ring";
import { Pseudonymiser } from "./pseudonymiser";

/** One instance of the musiccast adapter. */
export interface InstanceInfo {
  /** The instance, e.g. `musiccast.<n>`. */
  instance: string;
  /** Whether it is switched on. */
  enabled: boolean;
  /** Whether it runs right now (its `alive` state). */
  alive: boolean;
}

/** The musiccast adapter in one word — see `musiccastStatus`. */
export type MusiccastStatus =
  "not installed" | "installed, no instance" | "installed, switched off" | "switched on, not running" | "running";

/** The installation around the adapter. */
export interface EnvironmentSnapshot {
  /** Node.js version. */
  node: string;
  /** Operating system and architecture. */
  platform: string;
  /** js-controller version on this host. */
  jsController?: string;
  /** The system language the datapoint labels are written in. */
  systemLanguage?: string;
  /**
   * What tells of a second MusicCast client on this host — in practice the old musiccast adapter, which
   * speaks to the same receivers (Y-11: the documentation says to remove it; this adapter never touches
   * another adapter, so it is seen by its effect, not by reading its objects).
   */
  musiccast: {
    /** Installed or not, switched off, switched on but not running, or running. */
    status: MusiccastStatus;
    /** Whether the musiccast adapter is installed (its adapter object exists). */
    installed: boolean;
    /** Its installed version. */
    version?: string;
    /** Its instances, switched on or not, running or not. */
    instances: InstanceInfo[];
  };
  /** What the MusicCast event port shows of a second MusicCast client on this host. */
  musiccastClient: {
    /** :41100 could not be bound — another program holds the MusicCast event port. */
    pushPortBlocked: boolean;
    /** The event port is bound and listening. */
    pushPortListening: boolean;
  };
  /** The instance settings that change behaviour (no addresses). */
  config: Record<string, unknown>;
  /** How many devices this instance runs, and how many are connected. */
  devices: { running: number; connected: number };
  /** When this instance started. */
  startedAt: string;
}

/** One datapoint as the object tree holds it. */
export interface ObjectTreeEntry {
  /** Id relative to the device. */
  id: string;
  /** The datapoint type. */
  type?: string;
  /** Its role. */
  role?: string;
  /** Its unit. */
  unit?: string;
  /** Whether it is readable. */
  read?: boolean;
  /** Whether it is writable. */
  write?: boolean;
  /** Its lower limit. */
  min?: number;
  /** Its upper limit. */
  max?: number;
  /** Its step. */
  step?: number;
  /** The value list, when the datapoint has one. */
  states?: unknown;
  /** Its current value. */
  val?: unknown;
  /** Whether the value is acknowledged by the device. */
  ack?: boolean;
}

/** Everything a report is made of. */
export interface ReportInput {
  /** The adapter version making the report. */
  adapterVersion: string;
  /** The time of the report. */
  now: Date;
  /** The installation around the adapter. */
  environment: EnvironmentSnapshot;
  /** The device as the adapter knows it. */
  device: {
    id: string;
    ip: string;
    source?: string;
    model?: string;
    label?: string;
    identity?: DeviceIdentity;
    connected: boolean;
    transports: Record<string, boolean>;
    volumeAsPercent?: boolean;
    /** Whether this device's MusicCast events arrive (`dead`: another client takes them away). */
    pushEvents?: string;
  };
  /** The device object's `native` — the capability profile and what the adapter remembers. */
  profile?: Record<string, unknown>;
  /** What the running connection read, or undefined when the device is not connected. */
  connection?: HandleCapture;
  /** Why there is no connection read. */
  connectionNote?: string;
  /** The device's datapoints. */
  objectTree: ObjectTreeEntry[];
  /** The adapter's recent log lines about the device. */
  logs: LogLine[];
}

/**
 * The file name a report is saved under. It has to explain itself to whoever receives it: model and
 * device id tell two receivers apart, adapter version and time say what was measured when.
 *
 * @param deviceId the device's object id (model + serial tail)
 * @param adapterVersion the adapter version
 * @param now the export time
 * @returns the file name
 */
export function diagnosticsFileName(deviceId: string, adapterVersion: string, now: Date): string {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `yamaha_${deviceId.replace(/[^a-z0-9-]/gi, "_")}_v${adapterVersion}_${day}_${time}.json`;
}

/**
 * Build the diagnostics report for one device: the installation, the device as the adapter knows it,
 * who serves which datapoint, what the device answered when it was just read (verbatim, per protocol),
 * the remembered profile, the object tree and the adapter's recent log lines — pseudonymised, so it can
 * be attached to a public issue.
 *
 * @param input what the report is made of
 * @returns the report, ready for `JSON.stringify`
 */
export function buildDiagnosticsReport(input: ReportInput): Record<string, unknown> {
  const { device, connection } = input;
  const captures: Partial<Record<string, TransportCapture>> = {};
  for (const capture of connection?.captures ?? []) {
    captures[capture.transport] = capture;
  }
  const report: Record<string, unknown> = {
    readMe: {
      what: "Diagnostics export of one Yamaha device for a GitHub issue of ioBroker.yamaha. Addresses, serial numbers, network and room names are replaced by markers.",
      markers:
        "Markers (ip-private-1, name-1, serial-1-…2B3C) are stable INSIDE this file only. Never compare them across two exports.",
      captures:
        "captures.* holds what the device answered when this report was made, verbatim and read-only: YNCA SUBUNIT:FUNC → value (plus every received line), MusicCast endpoint → JSON body, XML Element/Node → response body and desc.xml. Same shape as test/fixtures/inventory.",
    },
    adapter: "iobroker.yamaha",
    version: input.adapterVersion,
    exportedAt: input.now.toISOString(),
    environment: input.environment,
    device: {
      id: device.id,
      model: device.model ?? null,
      label: device.label ?? null,
      address: device.ip,
      source: device.source ?? null,
      identity: device.identity ?? null,
      connected: device.connected,
      transports: device.transports,
      volumeAsPercent: device.volumeAsPercent ?? false,
      musiccastEvents: device.pushEvents ?? null,
    },
    connection: connection
      ? { live: connection.live, missing: connection.missing, owners: connection.owners, learnedTree: connection.tree }
      : { note: input.connectionNote ?? "not connected — no live read" },
    captures,
    profile: input.profile ?? null,
    objectTree: input.objectTree,
    recentLogs: input.logs,
  };
  const pseudonymiser = new Pseudonymiser();
  pseudonymiser.teach("serial", device.identity?.serial);
  pseudonymiser.teach("mac", device.identity?.mac);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(device.ip)) {
    pseudonymiser.teach("host", device.ip);
  }
  if (device.label && device.label !== device.id && device.label !== device.model) {
    pseudonymiser.teach("name", device.label);
  }
  pseudonymiser.learn(report);
  return pseudonymiser.walk(report) as Record<string, unknown>;
}

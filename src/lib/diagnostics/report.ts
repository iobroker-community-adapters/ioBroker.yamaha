import { idSegment } from "../device-id";
import type { DeviceIdentity } from "../device-identity";
import { isIPv4 } from "../network-interfaces";
import type { HandleCapture, TransportCapture } from "./types";
import type { LogLine } from "./log-ring";
import { Pseudonymiser, type PersonalKind } from "./pseudonymiser";

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
   * The old musiccast adapter, which speaks to the same receivers — read straight from the objects
   * js-controller keeps for it, read only (Y-11: the documentation says to remove it; this adapter never
   * changes another adapter).
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
 * @param deviceId the device id as the report shows it — pseudonymised (see {@link diagnosticsExport})
 * @param adapterVersion the adapter version
 * @param now the export time
 * @returns the file name
 */
export function diagnosticsFileName(deviceId: string, adapterVersion: string, now: Date): string {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  // A serial marker's ellipsis (`serial-1-…AA22`) has no place in a file name.
  const id = deviceId.replace(/…/g, "").replace(/[^a-z0-9-]+/gi, "_");
  return `yamaha_${id}_v${adapterVersion}_${day}_${time}.json`;
}

/**
 * The report as the admin offers it for download: the JSON, and the file name — taken from the device id
 * as the REPORT shows it, so an id the adapter derived from a typed room name or an address, or the whole
 * serial a second device of the same model carries in its id, does not leave in the file name either
 * (review 2026-10-05, B3).
 *
 * @param input what the report is made of
 * @returns the file name and the report JSON
 */
export function diagnosticsExport(input: ReportInput): { fileName: string; content: string } {
  const report = buildDiagnosticsReport(input);
  const id = (report.device as { id?: unknown } | undefined)?.id;
  return {
    fileName: diagnosticsFileName(typeof id === "string" ? id : "device", input.adapterVersion, input.now),
    content: JSON.stringify(report, null, 2),
  };
}

/**
 * What a device id gives away. An id the adapter built from the model (`rx-v473`, counted on: `rx-v473-2`)
 * or from the model and the serial's last four characters (`rx-v6a-2b3c`) tells nothing the report does not
 * show anyway; the whole serial a second device of a model carries (`wx-010-0b11aa22`) is a serial like any
 * other; an id taken from a typed name or an address (`kueche`, `192-168-178-41`, the 2.x `192_168_178_41`)
 * — or one that cannot be told from those because the model is unknown — names the owner's room or network
 * and becomes a marker of its own (review 2026-10-05, B3).
 *
 * @param id the device id
 * @param model the device's model, when known
 * @returns what to teach the pseudonymiser, or undefined when the id gives nothing away
 */
export function personalIdPart(
  id: string,
  model: string | undefined,
): { kind: PersonalKind; value: string } | undefined {
  const base = idSegment(model ?? "");
  if (base && (id === base || id.startsWith(`${base}-`))) {
    const rest = id.slice(base.length + 1);
    if (rest === "" || /^\d+$/.test(rest) || /^[0-9a-f]{4}$/i.test(rest)) {
      return undefined;
    }
    if (/^[0-9a-f]{5,}$/i.test(rest)) {
      return { kind: "serial", value: rest };
    }
  }
  return { kind: "device", value: id };
}

/**
 * The device object's `native` as the report shows it. The capability profile — and the profile of the
 * releases before 2.7.0 — is stored as a JSON TEXT; parsed, the reader sees its structure and the
 * pseudonymiser reaches the zone names, serials and MACs inside it, which a text hid from every rule that
 * looks at keys: the most common report, the one of a device that is not connected, carried the room names
 * in clear (review 2026-10-05, B1). A text that does not parse stays a text.
 *
 * @param native the device object's native part
 * @returns the same, with every JSON text as the object it holds
 */
function readableProfile(native: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!native) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(native).map(([key, value]) => {
      if (typeof value !== "string" || !/^\s*[[{]/.test(value)) {
        return [key, value];
      }
      try {
        return [key, JSON.parse(value) as unknown];
      } catch {
        return [key, value];
      }
    }),
  );
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
      what: "Diagnostics export of one Yamaha device for a GitHub issue of ioBroker.yamaha. Addresses, serial numbers, MACs, network, room and device names (and a device id made from them) are replaced by markers.",
      markers:
        "Markers (ip-private-1, name-1, device-1, serial-1-…2B3C) are stable INSIDE this file only. Never compare them across two exports.",
      captures:
        "captures.* holds what the device answered when this report was made, verbatim and read-only: YNCA SUBUNIT:FUNC → value (plus every received line), MusicCast endpoint → JSON body, XML Element/Node → response body and desc.xml. Same shape as test/fixtures/inventory. complete = the read ran to its end without a transport failure; failed = questions that got no answer (timeout, lost connection), error = why. A refusal is an answer: kept as {response_code} or {httpStatus}; a transport failure as {error}.",
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
    profile: readableProfile(input.profile),
    objectTree: input.objectTree,
    recentLogs: input.logs,
  };
  const pseudonymiser = new Pseudonymiser();
  pseudonymiser.teach("serial", device.identity?.serial);
  pseudonymiser.teach("mac", device.identity?.mac);
  if (!isIPv4(device.ip)) {
    pseudonymiser.teach("host", device.ip);
  }
  // The display name — the one the adapter knows now and the one it remembered (the profile's `label`).
  for (const label of [device.label, input.profile?.label]) {
    if (typeof label === "string" && label !== device.id && label !== device.model) {
      pseudonymiser.teach("name", label);
    }
  }
  const idPart = personalIdPart(device.id, device.model);
  if (idPart) {
    pseudonymiser.teach(idPart.kind, idPart.value);
  }
  pseudonymiser.learn(report);
  return pseudonymiser.walk(report) as Record<string, unknown>;
}

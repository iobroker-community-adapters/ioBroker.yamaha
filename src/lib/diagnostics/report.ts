import { idSegment } from "../device-id";
import type { DeviceIdentity } from "../device-identity";
import { isIPv4 } from "../network-interfaces";
import type { HandleCapture, TransportCapture } from "./types";
import type { LogLine } from "./log-ring";
import { blankSecrets, PersonalValues, type PersonalKind } from "./personal-values";
import { Placeholders } from "./placeholders";
import type { ReportBody } from "./report-jobs";
import type { HistoryEvent, TrafficSnapshot } from "./traffic-recorder";

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

/** Everything a report body is made of — the frame (adapter, version, time, `connected`) is the master's. */
export interface ReportInput {
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
  /** The device's diagnostics trail, taken before the live read (traffic, commands, connection history, owners). */
  trail?: TrafficSnapshot;
  /** When the device's `info.connection` last turned false — what tells "offline since" after a restart. */
  offlineSince?: string;
}

/** A command datapoint whose value is a name the user gives — registered before the placeholders replace. */
const NAME_COMMAND = /(?:^|\.)(?:zoneName|name)$/;

/**
 * When the device went offline: the last "disconnected" of its history, while it is not connected — after a restart
 * the history has none, and the time its `info.connection` last turned false says it (server test 2026-10-06: a
 * receiver without power since the evening before was reported with null).
 *
 * @param history the connection history, oldest first
 * @param connected whether the device is connected now
 * @param offlineSince when the device's `info.connection` last turned false
 * @returns the time, or null
 */
function disconnectedSince(
  history: readonly HistoryEvent[],
  connected: boolean,
  offlineSince: string | undefined,
): string | null {
  if (connected) {
    return null;
  }
  return [...history].reverse().find(event => event.event === "disconnected")?.at ?? offlineSince ?? null;
}

/**
 * The latest reason each protocol gave for not serving: an attempt it did not connect in, a drop, a reconnect that
 * failed, a liveness question it did not answer.
 *
 * @param history the connection history, oldest first
 * @returns protocol → its latest reason and when
 */
function lastReasonPerTransport(history: readonly HistoryEvent[]): Record<string, { at: string; reason: string }> {
  const reasons: Record<string, { at: string; reason: string }> = {};
  for (const event of history) {
    if (typeof event.transport === "string" && event.event !== "transport back") {
      reasons[event.transport] = {
        at: event.at,
        reason: typeof event.reason === "string" ? `${event.event}: ${event.reason}` : event.event,
      };
    }
    const transports = event.transports;
    if (typeof transports === "object" && transports !== null) {
      for (const [transport, outcome] of Object.entries(transports as Record<string, unknown>)) {
        if (typeof outcome === "string" && outcome !== "connected") {
          reasons[transport] = { at: event.at, reason: outcome };
        }
      }
    }
  }
  return reasons;
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
 * @returns what to register with the placeholders, or undefined when the id gives nothing away
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
 * placeholders reach the zone names, serials and MACs inside it, which a text hid from every rule that
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
 * Build the diagnostics report body for one device: the installation, the device as the adapter knows it, who serves
 * which datapoint, what the device answered when it was just read (verbatim, per protocol), the remembered profile, the
 * object tree and the adapter's recent log lines — with placeholders, so it can be attached to a public issue. The
 * frame around it (adapter, version, time, `connected`) is the master's (`ReportJobs`).
 *
 * @param input what the report is made of
 * @returns the body and the device id as the report shows it — the file name takes it from there, so an id the
 *   adapter derived from a typed room name or an address does not leave in the file name either (review 2026-10-05, B3)
 */
export function buildReportBody(input: ReportInput): ReportBody {
  const { device, connection } = input;
  const captures: Partial<Record<string, TransportCapture>> = {};
  for (const capture of connection?.captures ?? []) {
    captures[capture.transport] = capture;
  }
  const body = blankSecrets({
    environment: input.environment,
    device: {
      id: device.id,
      model: device.model ?? null,
      label: device.label ?? null,
      address: device.ip,
      source: device.source ?? null,
      identity: device.identity ?? null,
      transports: device.transports,
      volumeAsPercent: device.volumeAsPercent ?? false,
      musiccastEvents: device.pushEvents ?? null,
    },
    connection: connection
      ? { live: connection.live, missing: connection.missing, owners: connection.owners, learnedTree: connection.tree }
      : {
          note: input.connectionNote ?? "not connected — no live read",
          // Who served which datapoint, as at the last connection (plan „Diagnosebericht“, Y4).
          ownersAtLastConnection: input.trail?.lastOwners ?? null,
        },
    trail: {
      disconnectedSince: disconnectedSince(input.trail?.connectionHistory ?? [], device.connected, input.offlineSince),
      lastReasonPerTransport: lastReasonPerTransport(input.trail?.connectionHistory ?? []),
      connectionHistory: input.trail?.connectionHistory ?? [],
      commandResults: input.trail?.commands ?? [],
      traffic: input.trail?.traffic ?? { ynca: [], musiccast: [], xml: [], events: [] },
    },
    captures,
    profile: readableProfile(input.profile),
    objectTree: input.objectTree,
    recentLogs: input.logs,
  }) as Record<string, unknown>;
  const places = new Placeholders();
  const personal = new PersonalValues(places);
  personal.teach("serial", device.identity?.serial);
  personal.teach("mac", device.identity?.mac);
  if (!isIPv4(device.ip)) {
    personal.teach("host", device.ip);
  }
  // The display name — the one the adapter knows now and the one it remembered (the profile's `label`).
  for (const label of [device.label, input.profile?.label]) {
    if (typeof label === "string" && label !== device.id && label !== device.model) {
      personal.teach("name", label);
    }
  }
  // A name the user wrote through the adapter stands in the command list under its datapoint, not under a key the
  // collector knows.
  for (const command of input.trail?.commands ?? []) {
    if (NAME_COMMAND.test(command.id) && typeof command.value === "string") {
      personal.teach("name", command.value);
    }
  }
  const idPart = personalIdPart(device.id, device.model);
  if (idPart) {
    personal.teach(idPart.kind, idPart.value);
  }
  personal.learn(body);
  return { content: places.deep(body) as Record<string, unknown> };
}

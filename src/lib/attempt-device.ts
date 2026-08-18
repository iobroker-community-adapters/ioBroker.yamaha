import { YncaClient } from "./ynca/ynca-client";
import { YncaDeviceController } from "./device-controller";
import { YxcDeviceController } from "./yxc/device-controller";
import { YamahaYxcClient } from "./yxc/http-client";
import { XmlDeviceController } from "./xml/device-controller";
import { XmlClient } from "./xml/xml-client";
import { MultiTransportHandle, type ConnectableTransport } from "./lifecycle/multi-transport-handle";
import { TransportConnectionAdapter } from "./lifecycle/transport-connection-adapter";
import { ReconnectStrategy } from "./lifecycle/reconnect-strategy";
import type { ReachabilityDedup } from "./lifecycle/reachability-dedup";
import type { YncaSubunitCache } from "./ynca/subunit-cache";
import type { Transport } from "./catalog/owner-policy";
import { readyLine } from "./ready-line";
import { errorMessage } from "./util";
import type { ConnectionHandle, ControllerLog } from "./controller";
import type { ObjectDef } from "./catalog/types";
import type { DeviceRecord } from "./types";

// Re-exported so existing importers (tests) keep resolving it from here.
export type { ConnectableTransport };

/** Per-transport reconnect backoff bounds — same shape as the device supervisor's. */
const TRANSPORT_RECONNECT_BASE_MS = 1000;
const TRANSPORT_RECONNECT_MAX_MS = 60000;

/** The adapter-bound callbacks {@link attemptDevice} drives — injected so it needs no adapter. */
export interface AttemptDeps {
  /** Adapter log. */
  log: ControllerLog;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter-managed timers (YNCA pacing + per-transport reconnects). */
  timers: {
    /** Schedule a one-shot timer. */
    schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
    /** Cancel a scheduled timer. */
    cancel(handle: ioBroker.Timeout | undefined): void;
  };
  /** Register a YXC push handler for a device IP; returns a function that unregisters it. */
  registerPush(ip: string, onPush: (event: unknown) => void): () => void;
  /** Schedule a repeating keepalive; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** How often to poll an XML/YNC device for state (ms). */
  xmlPollIntervalMs: number;
  /** Report the transports that are live after every change — the id-safe names ("ynca"/"yxc"/"xml"). */
  onTransports?(names: string[]): void;
  /** IPs of all configured devices, so a MusicCast group can resolve a client device by IP. */
  knownDeviceIps: Set<string>;
  /** Dedup for the "no reachable transport" warning — see {@link ConnectDeps.reachability}. */
  reachability?: ReachabilityDedup;
  /** Datapoint-group gate for the YNCA sweep — a disabled group's functions are never fetched. */
  isEntryEnabled?(id: string): boolean;
  /** Per-device cache of the YNCA AVAIL probe, held by the caller across reconnects. */
  yncaSubunitCache?: YncaSubunitCache;
}

/** One transport to try: its name and a factory building a FRESH connectable (also for reconnects). */
export interface TransportAttempt {
  /** The transport this attempt stands for. */
  transport: Transport;
  /** Build a fresh connectable transport (a controller behind its adapter). */
  build(): ConnectableTransport;
}

/** The adapter callbacks {@link connectTransports} drives to build and hold the unified tree. */
export interface ConnectDeps {
  /** Adapter log. */
  log: ControllerLog;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Report the transports that are live after every change — the id-safe names ("ynca"/"yxc"/"xml"). */
  onTransports?(names: string[]): void;
  /**
   * Dedup for the "no reachable transport" warning: without it every retry warns
   * again for as long as the device stays offline (nut2 `failedUps` pattern — first
   * failure warns, repeats stay at debug until the device answers again).
   */
  reachability?: ReachabilityDedup;
  /** Timers for the per-transport reconnect loops (absent in tests → no per-transport retry). */
  timers?: {
    /** Schedule a one-shot timer. */
    schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
    /** Cancel a scheduled timer. */
    cancel(handle: ioBroker.Timeout | undefined): void;
  };
}

/**
 * Bring every answering transport online on ONE object tree. All candidates connect IN
 * PARALLEL (a YNCA connect timeout or long sweep no longer delays YXC/XML); the ones that
 * answer are handed to a single {@link MultiTransportHandle}, which unifies their catalogs
 * (each capability owned by exactly one transport — most-modern-but-lossless, see the
 * object-tree coordinator), routes user writes to the owner, and reconnects a single
 * dropped transport on its own while the others keep running. Ownership is resolved by
 * rank over the connected set, so the connect order/timing never changes it. A transport
 * that does not answer, or whose connect throws, is closed and left out. Returns the
 * handle over the live set, or null when no transport answered (the device is offline
 * this attempt).
 *
 * @param deviceId the id-safe device id
 * @param attempts the transports to try
 * @param deps the adapter callbacks (upsert + log + timers)
 * @returns a connection handle over the live transports, or null when none connected
 */
export async function connectTransports(
  deviceId: string,
  attempts: readonly TransportAttempt[],
  deps: ConnectDeps,
): Promise<ConnectionHandle | null> {
  const results = await Promise.all(
    attempts.map(async attempt => {
      const conn = attempt.build();
      try {
        if (await conn.connect()) {
          return conn;
        }
      } catch (e) {
        deps.log.debug(`${deviceId}/${conn.transport}: transport did not connect (${errorMessage(e)})`);
      }
      conn.close();
      return null;
    }),
  );
  const live = results.filter((conn): conn is ConnectableTransport => conn !== null);
  if (live.length === 0) {
    const level = deps.reachability?.reportUnreachable() ?? "warn";
    deps.log[level](`${deviceId}: no reachable transport (YNCA/YXC/XML)`);
    return null;
  }
  deps.reachability?.reportReachable();
  const rebuilds = new Map(attempts.map(attempt => [attempt.transport, attempt.build] as const));
  const handle = new MultiTransportHandle(deviceId, live, {
    upsertObject: deps.upsertObject,
    log: deps.log,
    onTransports: deps.onTransports,
    rebuild: deps.timers ? transport => rebuilds.get(transport)!() : undefined,
    schedule: deps.timers ? (cb, ms) => deps.timers!.schedule(cb, ms) : undefined,
    cancel: deps.timers ? handle_ => deps.timers!.cancel(handle_ as ioBroker.Timeout | undefined) : undefined,
    backoffFactory: () => new ReconnectStrategy(TRANSPORT_RECONNECT_BASE_MS, TRANSPORT_RECONNECT_MAX_MS),
  });
  try {
    await handle.start();
  } catch (e) {
    // Building the unified tree failed (e.g. object creation errored): close every live
    // transport before rethrowing, or the supervisor's retry would leak sockets and timers —
    // fatal for YNCA, where the receiver allows only ONE connection and a zombie socket
    // would block every future attempt until the adapter restarts.
    handle.close();
    throw e;
  }
  // One summary line instead of three per-transport "ready" lines; each controller logs its
  // own readiness at debug level for diagnostics.
  deps.log.info(
    readyLine(
      deviceId,
      live.map(conn => conn.transport),
    ),
  );
  return handle;
}

/**
 * Bring one device online across ALL its transports. Every transport that answers — YNCA (amp
 * control over a held TCP connection), YXC (MusicCast, push + poll), XML/YNC (pre-2010) — is built
 * behind a {@link TransportConnectionAdapter} and connected in parallel on one object tree, so a
 * MusicCast AVR gets YNCA base control AND the YXC-exclusive richness (multiroom, equalizer, album
 * art) instead of one transport winning and hiding the rest. Each transport is described by a
 * factory, so the handle can rebuild and reconnect a single dropped transport while the others
 * keep running. Returns a {@link ConnectionHandle} over the live set, or null when no transport
 * answers this attempt.
 *
 * @param device the configured device record
 * @param deps the adapter-bound callbacks
 * @returns a connection handle, or null when no transport connected
 */
export function attemptDevice(device: DeviceRecord, deps: AttemptDeps): Promise<ConnectionHandle | null> {
  const { log, upsertObject, setStateAck, timers } = deps;

  // 1) YNCA — amp control over a held TCP connection; a socket drop is the genuine gone-signal.
  const buildYnca = (): ConnectableTransport => {
    const ynca = new TransportConnectionAdapter("ynca", device.id, setStateAck);
    ynca.bind(
      new YncaDeviceController(device.id, {
        client: new YncaClient(device.ip, timers),
        upsertObject: ynca.interceptUpsert,
        setStateAck: ynca.interceptSetStateAck,
        log,
        isEntryEnabled: deps.isEntryEnabled,
        subunitCache: deps.yncaSubunitCache,
      }),
    );
    return ynca;
  };

  // 2) YXC — MusicCast; polled + push. Drop reported after a run of failed keepalive polls.
  const buildYxc = (): ConnectableTransport => {
    const yxc = new TransportConnectionAdapter("yxc", device.id, setStateAck);
    yxc.bind(
      new YxcDeviceController(device.id, {
        client: new YamahaYxcClient(device.ip),
        // Resolve another configured device's client for a multiroom link — never this device itself.
        clientFor: ip => (ip !== device.ip && deps.knownDeviceIps.has(ip) ? new YamahaYxcClient(ip) : undefined),
        registerPush: onPush => deps.registerPush(device.ip, onPush),
        scheduleKeepalive: deps.scheduleKeepalive,
        upsertObject: yxc.interceptUpsert,
        setStateAck: yxc.interceptSetStateAck,
        log,
      }),
    );
    return yxc;
  };

  // 3) XML/YNC — pre-2010 receivers; polled. A drop is reported after a run of failed polls.
  const buildXml = (): ConnectableTransport => {
    const xml = new TransportConnectionAdapter("xml", device.id, setStateAck);
    xml.bind(
      new XmlDeviceController(
        device.id,
        {
          client: new XmlClient(device.ip),
          scheduleKeepalive: deps.scheduleKeepalive,
          upsertObject: xml.interceptUpsert,
          setStateAck: xml.interceptSetStateAck,
          log,
        },
        deps.xmlPollIntervalMs,
      ),
    );
    return xml;
  };

  return connectTransports(
    device.id,
    [
      { transport: "ynca", build: buildYnca },
      { transport: "yxc", build: buildYxc },
      { transport: "xml", build: buildXml },
    ],
    {
      upsertObject,
      log,
      onTransports: deps.onTransports,
      reachability: deps.reachability,
      timers: deps.timers,
    },
  );
}

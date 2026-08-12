import { YncaClient } from "./ynca/ynca-client";
import { YncaDeviceController } from "./device-controller";
import { YxcDeviceController } from "./yxc/device-controller";
import { YamahaYxcClient } from "./yxc/http-client";
import { XmlDeviceController } from "./xml/device-controller";
import { XmlClient } from "./xml/xml-client";
import { MultiTransportHandle, type TransportConnection } from "./lifecycle/multi-transport-handle";
import { TransportConnectionAdapter } from "./lifecycle/transport-connection-adapter";
import { errorMessage } from "./util";
import type { ConnectionHandle, ControllerLog } from "./controller";
import type { ObjectDef } from "./catalog/types";
import type { DeviceRecord } from "./types";

/** The adapter-bound callbacks {@link attemptDevice} drives — injected so it needs no adapter. */
export interface AttemptDeps {
  /** Adapter log. */
  log: ControllerLog;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter-managed timers for the YNCA client. */
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
  /** Called once a device connects over the XML/YNC transport (a pre-2010 receiver). */
  onXmlConnected(): void;
  /** IPs of all configured devices, so a MusicCast group can resolve a client device by IP. */
  knownDeviceIps: Set<string>;
}

/** A transport connection that can be brought online — a {@link TransportConnection} plus connect(). */
export interface ConnectableTransport extends TransportConnection {
  /** Connect, probe, and build the object tree. Resolves true if the transport answered. */
  connect(): Promise<boolean>;
}

/** One transport to try, with an optional hook fired once if it connects. */
export interface TransportAttempt {
  /** The connectable transport (a controller behind its adapter). */
  conn: ConnectableTransport;
  /** Called once if this transport connects (XML uses it to flag a pre-2010 device). */
  onConnected?: () => void;
}

/** The adapter callbacks {@link connectTransports} drives to build and hold the unified tree. */
export interface ConnectDeps {
  /** Adapter log. */
  log: ControllerLog;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
}

/**
 * Bring every answering transport online on ONE object tree. Each candidate is tried in turn; the
 * ones that connect are handed to a single {@link MultiTransportHandle}, which unifies their
 * catalogs (each capability owned by exactly one transport — most-modern-but-lossless, see the
 * object-tree coordinator) and routes user writes to the owner. A transport that does not answer,
 * or whose connect throws, is closed and left out. Returns the handle over the live set, or null
 * when no transport answered (the device is offline this attempt).
 *
 * @param deviceId the id-safe device id
 * @param attempts the transports to try, in priority order
 * @param deps the adapter callbacks (upsert + log)
 * @returns a connection handle over the live transports, or null when none connected
 */
export async function connectTransports(
  deviceId: string,
  attempts: readonly TransportAttempt[],
  deps: ConnectDeps,
): Promise<ConnectionHandle | null> {
  const live: TransportConnection[] = [];
  for (const { conn, onConnected } of attempts) {
    try {
      if (await conn.connect()) {
        live.push(conn);
        onConnected?.();
      } else {
        conn.close();
      }
    } catch (e) {
      conn.close();
      deps.log.debug(`${deviceId}/${conn.transport}: transport did not connect (${errorMessage(e)})`);
    }
  }
  if (live.length === 0) {
    deps.log.warn(`${deviceId}: no reachable transport (YNCA/YXC/XML)`);
    return null;
  }
  const handle = new MultiTransportHandle(deviceId, live, { upsertObject: deps.upsertObject, log: deps.log });
  await handle.start();
  return handle;
}

/**
 * Bring one device online across ALL its transports. Every transport that answers — YNCA (amp
 * control over a held TCP connection), YXC (MusicCast, push + poll), XML/YNC (pre-2010) — is built
 * behind a {@link TransportConnectionAdapter} and connected in parallel on one object tree, so a
 * MusicCast AVR gets YNCA base control AND the YXC-exclusive richness (multiroom, equalizer, album
 * art) instead of one transport winning and hiding the rest. Returns a {@link ConnectionHandle}
 * over the live set, or null when no transport answers this attempt.
 *
 * @param device the configured device record
 * @param deps the adapter-bound callbacks
 * @returns a connection handle, or null when no transport connected
 */
export function attemptDevice(device: DeviceRecord, deps: AttemptDeps): Promise<ConnectionHandle | null> {
  const { log, upsertObject, setStateAck, timers } = deps;

  // 1) YNCA — amp control over a held TCP connection; a socket drop reconnects through the supervisor.
  const ynca = new TransportConnectionAdapter("ynca", device.id, setStateAck);
  ynca.bind(
    new YncaDeviceController(device.id, {
      client: new YncaClient(device.ip, timers),
      upsertObject: ynca.interceptUpsert,
      setStateAck: ynca.interceptSetStateAck,
      log,
    }),
  );

  // 2) YXC — MusicCast; polled + push. Drop reported after a run of failed keepalive polls.
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

  // 3) XML/YNC — pre-2010 receivers; polled. A drop is reported after a run of failed polls.
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

  return connectTransports(
    device.id,
    [{ conn: ynca }, { conn: yxc }, { conn: xml, onConnected: (): void => deps.onXmlConnected() }],
    { upsertObject, log },
  );
}

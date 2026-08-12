import { YncaClient } from "./ynca/ynca-client";
import { YncaDeviceController } from "./device-controller";
import { YxcDeviceController } from "./yxc/device-controller";
import { YamahaYxcClient } from "./yxc/http-client";
import { XmlDeviceController } from "./xml/device-controller";
import { XmlClient } from "./xml/xml-client";
import { MultiTransportHandle } from "./lifecycle/multi-transport-handle";
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

/**
 * Bring one device online across its transports, tried in order: YNCA (amp control
 * over a held TCP connection), then YXC (MusicCast), then XML/YNC (pre-2010). Returns
 * the transport controller that connected — each implements {@link ConnectionHandle},
 * so it is returned directly — or null when no transport answers this attempt. The
 * transport that connects owns the device's object tree, so the mappers never collide.
 *
 * @param device the configured device record
 * @param deps the adapter-bound callbacks
 * @returns a connection handle, or null when no transport connected
 */
export async function attemptDevice(device: DeviceRecord, deps: AttemptDeps): Promise<ConnectionHandle | null> {
  const { log, upsertObject, setStateAck, timers } = deps;
  const connections: TransportConnectionAdapter[] = [];

  // Every transport that answers runs in parallel on ONE object tree: each is built behind an
  // adapter that collects its objects and filters its state writes to the ids the object-tree
  // coordinator assigns it, so no state is written twice and each capability comes from the
  // best-fitting transport (see owner-policy). The set is then held by one MultiTransportHandle.

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
  await tryConnect(ynca, connections, log, `${device.id}: no YNCA`);

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
  await tryConnect(yxc, connections, log, `${device.id}: no YXC`);

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
  if (await tryConnect(xml, connections, log, `${device.id}: no XML`)) {
    deps.onXmlConnected();
  }

  if (connections.length === 0) {
    log.warn(`${device.id}: no reachable transport (YNCA/YXC/XML)`);
    return null;
  }
  const handle = new MultiTransportHandle(device.id, connections, { upsertObject, log });
  await handle.start();
  return handle;
}

/**
 * Connect one transport's adapter; on success add it to the set, else close it. A connect error
 * is logged and swallowed so the other transports still get their chance.
 *
 * @param adapter the transport adapter to connect
 * @param connections the set to add it to on success
 * @param log the adapter log
 * @param failMessage the debug message prefix if it does not connect
 * @returns whether the transport connected
 */
async function tryConnect(
  adapter: TransportConnectionAdapter,
  connections: TransportConnectionAdapter[],
  log: ControllerLog,
  failMessage: string,
): Promise<boolean> {
  try {
    if (await adapter.connect()) {
      connections.push(adapter);
      return true;
    }
    adapter.close();
  } catch (e) {
    adapter.close();
    log.debug(`${failMessage} (${errorMessage(e)})`);
  }
  return false;
}

import { YncaClient } from "./ynca/ynca-client";
import { YncaDeviceController } from "./device-controller";
import { YxcDeviceController } from "./yxc/device-controller";
import { YamahaYxcClient } from "./yxc/http-client";
import { XmlDeviceController } from "./xml/device-controller";
import { XmlClient } from "./xml/xml-client";
import {
  MultiTransportHandle,
  type ConnectableTransport,
  type DeviceTreeDeps,
} from "./lifecycle/multi-transport-handle";
import { TransportConnectionAdapter } from "./lifecycle/transport-connection-adapter";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, ReconnectStrategy } from "./lifecycle/reconnect-strategy";
import { CommandGate } from "./lifecycle/command-gate";
import { COMMAND_SPACING_MS, LIVE_GATES, type GateRegistry } from "./lifecycle/gate-registry";
import { isIPv4, resolveIPv4 } from "./network-interfaces";
import type { YncaSubunitCache } from "./ynca/subunit-cache";
import type { ProbeMemory } from "./lifecycle/probe-memory";
import type { Transport } from "./catalog/owner-policy";
import { readyLine } from "./ready-line";
import { errText } from "./err-text";
import { captureXml, captureYnca, captureYxc } from "./diagnostics/device-capture";
import type { ConnectionHandle } from "./controller";
import type { DeviceRecord } from "./types";
import type { PushLiveness } from "./yxc/push-liveness";
import { MEMORY_KEY } from "./lifecycle/memory-keys";

// Re-exported so existing importers (tests) keep resolving it from here.
export type { ConnectableTransport };

/** The adapter-bound callbacks {@link attemptDevice} drives — injected so it needs no adapter. */
export interface AttemptDeps extends DeviceTreeDeps {
  /** The installation's system language (`system.config`), for the MusicCast menus' language. */
  systemLanguage?: string;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string | null): void;
  /** Adapter-managed timers (YNCA pacing + per-transport reconnects). */
  timers: {
    /** Schedule a one-shot timer. */
    schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
    /** Cancel a scheduled timer. */
    cancel(handle: ioBroker.Timeout | undefined): void;
  };
  /** Register a YXC push handler for a device address (and its MusicCast device id); returns the unregister. */
  registerPush(ip: string, onPush: (event: unknown) => void, deviceId?: string): () => void;
  /** Whether the shared push receiver is listening (decides how much the keepalive polls). */
  pushActive?(): boolean;
  /** Whether this device's MusicCast events actually arrive (held by the caller across reconnects). */
  pushLiveness: PushLiveness;
  /** Schedule a repeating keepalive; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** How often to poll an XML/YNC device for state (ms). */
  xmlPollIntervalMs: number;
  /** Report the name the device carries for itself (MusicCast), for the device object's label. */
  onDeviceName?(name: string): void;
  /** IPs of all configured devices, so a MusicCast group can resolve a client device by IP. */
  knownDeviceIps: Set<string>;
  /** Datapoint-group gate for the YNCA sweep — a disabled group's functions are never fetched. */
  isEntryEnabled?(id: string): boolean;
  /** Per-device cache of the YNCA AVAIL probe, held by the caller across reconnects. */
  yncaSubunitCache: YncaSubunitCache;
  /** Per-device memory for device answers that stay constant while it runs (held by the caller). */
  probeMemory: ProbeMemory;
}

/** One transport to try: its name and a factory building a FRESH connectable (also for reconnects). */
export interface TransportAttempt {
  /** The transport this attempt stands for. */
  transport: Transport;
  /** Build a fresh connectable transport (a controller behind its adapter). */
  build(): ConnectableTransport;
}

/** The adapter callbacks {@link connectTransports} drives to build and hold the unified tree. */
export interface ConnectDeps extends DeviceTreeDeps {
  /** Timers for the per-transport reconnect loops (absent in tests → no per-transport retry). */
  timers?: {
    /** Schedule a one-shot timer. */
    schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
    /** Cancel a scheduled timer. */
    cancel(handle: ioBroker.Timeout | undefined): void;
  };
  /** Whether this device has been shown to have a transport — it answered it before (D1). */
  proven?(transport: Transport): boolean;
}

/**
 * Resolve another configured device's client for a multiroom link — never this device
 * itself, and only an address this instance runs. The client goes through the partner's
 * command gate (Y-15): the one of its running MusicCast connection, else one of its own.
 * Ungated, linking a running WX-030 sent getFeatures, setClientInfo and setInput in parallel
 * to its own keepalive (review 2026-10-05, A13).
 *
 * @param ownIp the address of the device asking
 * @param knownDeviceIps every address this instance runs
 * @param ip the address the link names
 * @param gateFor the partner's gate at an address (see {@link GateRegistry.gateFor})
 * @returns a client for the partner, or undefined when the address is not a partner
 */
export function partnerClient(
  ownIp: string,
  knownDeviceIps: ReadonlySet<string>,
  ip: string,
  gateFor: (ip: string) => CommandGate,
): YamahaYxcClient | undefined {
  return ip !== ownIp && knownDeviceIps.has(ip) ? new YamahaYxcClient(ip, undefined, gateFor(ip)) : undefined;
}

/**
 * The MusicCast Link partners of a device: every other configured device ONCE. The address set holds a device
 * configured by hostname twice — typed and resolved — and counted twice, a server's two clients made
 * `startDistribution(4)` instead of 2; the device itself stood in it under its resolved address (review 2026-10-05,
 * A44). Two addresses one running MusicCast connection holds are one device (its IPv4 address is kept, the one a
 * server's roster lists); the asking device's own connection is no partner.
 *
 * @param own the asking device's typed address
 * @param ownGate the asking device's MusicCast gate
 * @param known every address this instance runs
 * @param gates the running connections' gates
 * @returns one address per partner device
 */
export function partnerAddresses(
  own: string,
  ownGate: CommandGate,
  known: Iterable<string>,
  gates: GateRegistry,
): string[] {
  const byDevice = new Map<CommandGate | string, string>();
  for (const address of known) {
    const gate = gates.gateAt("yxc", address);
    if (address === own || gate === ownGate) {
      continue;
    }
    const device = gate ?? address;
    const kept = byDevice.get(device);
    if (kept === undefined || (!isIPv4(kept) && isIPv4(address))) {
      byDevice.set(device, address);
    }
  }
  return [...byDevice.values()];
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
 * @param signal aborted when the supervisor is closed mid-attempt: every transport built so far is
 *   closed (that also closes its command gate, so nothing waits on a timer any more) and the
 *   attempt yields nothing (audit 2026-09-24, A3)
 * @returns a connection handle over the live transports, or null when none connected
 */
export async function connectTransports(
  deviceId: string,
  attempts: readonly TransportAttempt[],
  deps: ConnectDeps,
  signal?: AbortSignal,
): Promise<ConnectionHandle | null> {
  if (signal?.aborted) {
    return null;
  }
  const built: ConnectableTransport[] = [];
  const closeBuilt = (): void => {
    for (const conn of built) {
      conn.close();
    }
  };
  signal?.addEventListener("abort", closeBuilt, { once: true });
  try {
    return await connectBuilt(deviceId, attempts, deps, built, signal);
  } finally {
    signal?.removeEventListener("abort", closeBuilt);
  }
}

/**
 * The body of {@link connectTransports}: build, connect, hand the live set to one handle.
 *
 * @param deviceId the id-safe device id
 * @param attempts the transports to try
 * @param deps the adapter callbacks
 * @param built collects every transport built, so an abort can close them
 * @param signal the attempt's abort signal
 * @returns a connection handle over the live transports, or null
 */
async function connectBuilt(
  deviceId: string,
  attempts: readonly TransportAttempt[],
  deps: ConnectDeps,
  built: ConnectableTransport[],
  signal: AbortSignal | undefined,
): Promise<ConnectionHandle | null> {
  const results = await Promise.all(
    attempts.map(async attempt => {
      const conn = attempt.build();
      built.push(conn);
      try {
        if (await conn.connect()) {
          return conn;
        }
      } catch (e) {
        deps.log.debug(`${deviceId}/${conn.transport}: transport did not connect (${errText(e)})`);
      }
      conn.close();
      return null;
    }),
  );
  const live = results.filter((conn): conn is ConnectableTransport => conn !== null);
  if (signal?.aborted) {
    for (const conn of live) {
      conn.close();
    }
    return null;
  }
  if (live.length === 0) {
    // A device that is off is off: `info.connection` says so, the log does not (krobi
    // 2026-09-22 — no adapter of the fleet reports an offline device in the log).
    deps.log.debug(`${deviceId}: no reachable transport (YNCA/YXC/XML)`);
    return null;
  }
  const rebuilds = new Map(attempts.map(attempt => [attempt.transport, attempt.build] as const));
  const handle = new MultiTransportHandle(deviceId, live, {
    ...deps,
    rebuild: deps.timers ? transport => rebuilds.get(transport)!() : undefined,
    schedule: deps.timers ? (cb, ms) => deps.timers!.schedule(cb, ms) : undefined,
    cancel: deps.timers ? handle_ => deps.timers!.cancel(handle_ as ioBroker.Timeout | undefined) : undefined,
    backoffFactory: () => new ReconnectStrategy(RECONNECT_BASE_MS, RECONNECT_MAX_MS),
    // A transport the device has shown before but that did not answer now — reconnected, and a read-in
    // does not complete without it. One it never answered is not retried: every MusicCast-only device
    // would knock on the YNCA port forever.
    missing: attempts
      .map(attempt => attempt.transport)
      .filter(transport => !live.some(conn => conn.transport === transport) && deps.proven?.(transport) === true),
  });
  let running: Transport[];
  try {
    running = await handle.start();
  } catch (e) {
    // Building the unified tree failed (e.g. object creation errored): close every live
    // transport before rethrowing, or the supervisor's retry would leak sockets and timers —
    // fatal for YNCA, where the receiver allows only ONE connection and a zombie socket
    // would block every future attempt until the adapter restarts.
    handle.close();
    throw e;
  }
  if (signal?.aborted) {
    handle.close();
    return null;
  }
  if (running.length === 0) {
    // Every transport dropped while the tree was being built: that is no connection. Handing the
    // handle on said "ready" and flipped info.connection true and at once false again — a log
    // line for a device that is off (audit 2026-09-24, A21).
    handle.close();
    deps.log.debug(`${deviceId}: every transport dropped while connecting`);
    return null;
  }
  // One summary line instead of three per-transport "ready" lines; each controller logs its
  // own readiness at debug level for diagnostics. It names what is live NOW, not what connected.
  deps.log.info(readyLine(deviceId, running));
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
 * @param signal aborted when the supervisor is closed mid-attempt (see {@link connectTransports})
 * @returns a connection handle, or null when no transport connected
 */
export function attemptDevice(
  device: DeviceRecord,
  deps: AttemptDeps,
  signal?: AbortSignal,
): Promise<ConnectionHandle | null> {
  const { log, setStateAck, timers } = deps;
  /**
   * A fresh command gate for one transport connection. EVERY command of that transport
   * goes through it: user writes, the init sweep, the keepalive and browsing alike. It is
   * also the connection's shutdown signal — closing it empties the queue and ends every
   * pending wait, so a stopped adapter leaves nothing running.
   *
   * One gate per device AND transport, not one for the adapter: the spacing is a property
   * of the device connection, so a shared gate would let one receiver's 19-second sweep
   * block another receiver's button press.
   *
   * It is held in the process's gate registry under every address the device is known by,
   * so a client another device builds for it (a MusicCast Link partner) or the identification
   * of a device about to be added goes through it too (review 2026-10-05, A13).
   *
   * @param transport the transport the gate belongs to
   * @returns the gate
   */
  const gateFor = (transport: Transport): CommandGate => {
    const gate = new CommandGate({ minSpacingMs: COMMAND_SPACING_MS[transport], timers });
    LIVE_GATES.hold(transport, device.ip, gate);
    if (!isIPv4(device.ip)) {
      void resolveIPv4(device.ip).then(ip => {
        if (ip !== undefined) {
          LIVE_GATES.hold(transport, ip, gate);
        }
      });
    }
    return gate;
  };
  /**
   * A partner's gate: its running connection's, else one of its own.
   *
   * @param ip the partner's address
   * @returns the gate
   */
  const partnerGate = (ip: string): CommandGate => LIVE_GATES.gateFor("yxc", ip, timers);

  // 1) YNCA — amp control over a held TCP connection; a socket drop is the genuine gone-signal.
  const buildYnca = (): ConnectableTransport => {
    const ynca = new TransportConnectionAdapter("ynca", device.id, setStateAck);
    const gate = gateFor("ynca");
    const client = new YncaClient(device.ip, timers, gate);
    ynca.readWith(() => captureYnca(client));
    ynca.bind(
      new YncaDeviceController(device.id, {
        client,
        gate,
        upsertObject: ynca.interceptUpsert,
        setStateAck: ynca.interceptSetStateAck,
        log,
        isEntryEnabled: deps.isEntryEnabled,
        subunitCache: deps.yncaSubunitCache,
        probeMemory: deps.probeMemory,
      }),
    );
    return ynca;
  };

  // 2) YXC — MusicCast; polled + push. Drop reported after a run of failed keepalive polls.
  const buildYxc = (): ConnectableTransport => {
    const yxc = new TransportConnectionAdapter("yxc", device.id, setStateAck);
    const gate = gateFor("yxc");
    const client = new YamahaYxcClient(device.ip, undefined, gate);
    yxc.readWith(() => captureYxc(client));
    yxc.bind(
      new YxcDeviceController(device.id, {
        client,
        aliasZone: (from, to) => yxc.aliasZone(from, to),
        systemLanguage: deps.systemLanguage,
        clientFor: ip => partnerClient(device.ip, deps.knownDeviceIps, ip, partnerGate),
        partnerIps: () => partnerAddresses(device.ip, gate, deps.knownDeviceIps, LIVE_GATES),
        registerPush: (onPush, deviceId) => deps.registerPush(device.ip, onPush, deviceId),
        pushActive: deps.pushActive,
        pushLiveness: deps.pushLiveness,
        host: device.ip,
        probeMemory: deps.probeMemory,
        scheduleKeepalive: deps.scheduleKeepalive,
        upsertObject: yxc.interceptUpsert,
        setStateAck: yxc.interceptSetStateAck,
        reportDeviceName: deps.onDeviceName,
        log,
        gate,
      }),
    );
    return yxc;
  };

  // 3) XML/YNC — pre-2010 receivers; polled. A drop is reported after a run of failed polls.
  const buildXml = (): ConnectableTransport => {
    const xml = new TransportConnectionAdapter("xml", device.id, setStateAck);
    const gate = gateFor("xml");
    const client = new XmlClient(device.ip, undefined, gate);
    xml.readWith(() => captureXml(client));
    xml.bind(
      new XmlDeviceController(
        device.id,
        {
          client,
          scheduleKeepalive: deps.scheduleKeepalive,
          upsertObject: xml.interceptUpsert,
          setStateAck: xml.interceptSetStateAck,
          log,
          gate,
          probeMemory: deps.probeMemory,
          host: device.ip,
        },
        deps.xmlPollIntervalMs,
      ),
    );
    return xml;
  };

  // Which transports to try. Without a description (a typed or migrated row, or a record from
  // before the description was kept) all three; with one, the two HTTP protocols it lists — the
  // description is per firmware, so a listed service is there and an unlisted one is not. YNCA
  // is raw TCP and never listed: always tried. The caller decides WHEN a narrowed set is used
  // (main.ts `startDevice`: only inside a streak of failed attempts, never the first after a
  // success) — a skipped transport is silent by nature, so the rule that lets the set widen
  // again lives there, not here.
  const services = device.services;
  const skip = (transport: Transport): [] => {
    log.debug(`${device.id}/${transport}: not advertised by the device — skipped`);
    return [];
  };
  return connectTransports(
    device.id,
    [
      { transport: "ynca", build: buildYnca },
      ...(services === undefined || services.yxc ? [{ transport: "yxc" as const, build: buildYxc }] : skip("yxc")),
      ...(services === undefined || services.xml ? [{ transport: "xml" as const, build: buildXml }] : skip("xml")),
    ],
    {
      ...deps,
      // What the device has answered before: the YNCA capability profile, the MusicCast and XML
      // identities — each written only once that transport answered (D1).
      proven: transport =>
        transport === "ynca"
          ? deps.probeMemory.remembered(MEMORY_KEY.yncaCapabilities) !== undefined ||
            deps.yncaSubunitCache.get() !== undefined
          : deps.probeMemory.remembered(transport === "yxc" ? MEMORY_KEY.yxcIdentity : MEMORY_KEY.xmlIdentity) !==
            undefined,
    },
    signal,
  );
}

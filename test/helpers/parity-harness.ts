import { createRequire, syncBuiltinESMExports } from "node:module";
import type { ObjectDef } from "../../src/lib/catalog/types";
import type { Transport } from "../../src/lib/catalog/owner-policy";
import { CommandGate } from "../../src/lib/lifecycle/command-gate";
import { ProbeMemory } from "../../src/lib/lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../../src/lib/lifecycle/discovery-schema";
import { TransportConnectionAdapter } from "../../src/lib/lifecycle/transport-connection-adapter";
import { YncaClient } from "../../src/lib/ynca/ynca-client";
import { createSubunitCache } from "../../src/lib/ynca/subunit-cache";
import { YncaDeviceController } from "../../src/lib/device-controller";
import { YamahaYxcClient } from "../../src/lib/yxc/http-client";
import { YxcDeviceController } from "../../src/lib/yxc/device-controller";
import { PushLiveness } from "../../src/lib/yxc/push-liveness";
import { XmlClient } from "../../src/lib/xml/xml-client";
import { XmlDeviceController } from "../../src/lib/xml/device-controller";

const require = createRequire(__filename);

/** One fixture device as the inventory describes it. */
export interface FixtureDevice {
  /** The fixture's id (`rxv6a`). */
  id: string;
  /** Its address — routed to the fixture servers by the inventory hook. */
  ip: string;
  /** The protocols the fixture answers. */
  transports: Transport[];
}

/** The objects one protocol builds for one device, by canonical id — and what it reported. */
export interface TransportTree {
  /** The canonical object definitions. */
  objects: Map<string, ObjectDef>;
  /** The last value the controller reported per canonical id. */
  values: Map<string, unknown>;
}

/** Timers for the clients and gates: real timeouts, shortened so a YNCA read-in takes a second, not half a minute. */
const timers = {
  schedule: (handler: () => void, ms: number): ioBroker.Timeout | undefined =>
    setTimeout(handler, Math.min(ms, 50)) as unknown as ioBroker.Timeout,
  cancel: (handle: ioBroker.Timeout | undefined): void => clearTimeout(handle as unknown as NodeJS.Timeout),
};

const silent = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

/**
 * Start the inventory's fixture devices and route their addresses to them (the inventory hook, loaded into this
 * process). Returns the devices and a stopper.
 *
 * @returns the devices and the stopper
 */
export async function startFixtures(): Promise<{ devices: FixtureDevice[]; stop: () => Promise<void> }> {
  const fixtures = require("../inventory-fixtures.cjs") as {
    startFixtureDevices(): Promise<{ routes: Record<string, unknown>; stop: () => Promise<void> }>;
    loadFixtures(): Array<{ id: string; ip: string; ynca?: unknown; yxc?: unknown; xml?: unknown }>;
  };
  const running = await fixtures.startFixtureDevices();
  process.env.YAMAHA_FIXTURE_ROUTES = JSON.stringify(running.routes);
  require("../inventory-hook.cjs");
  // The hook patches node:http's exports; the ES module view of a builtin is a copy until it is synced.
  syncBuiltinESMExports();
  const devices = fixtures.loadFixtures().map(f => ({
    id: f.id,
    ip: f.ip,
    transports: (["ynca", "yxc", "xml"] as const).filter(t => f[t] !== undefined),
  }));
  return { devices, stop: running.stop };
}

/**
 * Connect ONE protocol of a fixture device and collect what it builds — the controller behind its transport adapter,
 * exactly as the adapter wires it, alone on the device.
 *
 * @param device the fixture device
 * @param transport the protocol
 * @returns the canonical objects and values
 */
export async function readTransport(device: FixtureDevice, transport: Transport): Promise<TransportTree> {
  const values = new Map<string, unknown>();
  const adapter = new TransportConnectionAdapter(transport, device.id, (id, value) =>
    values.set(id.slice(device.id.length + 1), value),
  );
  const gate = new CommandGate({ minSpacingMs: 0, timers });
  const probeMemory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
  const common = { upsertObject: adapter.interceptUpsert, setStateAck: adapter.interceptSetStateAck, log: silent };
  if (transport === "ynca") {
    adapter.bind(
      new YncaDeviceController(device.id, {
        ...common,
        client: new YncaClient(device.ip, timers, gate),
        gate,
        subunitCache: createSubunitCache(undefined, () => undefined),
        probeMemory,
      }),
    );
  } else if (transport === "yxc") {
    adapter.bind(
      new YxcDeviceController(device.id, {
        ...common,
        client: new YamahaYxcClient(device.ip, undefined, gate),
        gate,
        aliasZone: (from, to) => adapter.aliasZone(from, to),
        registerPush: () => () => undefined,
        pushLiveness: new PushLiveness(),
        host: device.ip,
        probeMemory,
        scheduleKeepalive: () => () => undefined,
      }),
    );
  } else {
    adapter.bind(
      new XmlDeviceController(
        device.id,
        {
          ...common,
          client: new XmlClient(device.ip, undefined, gate),
          scheduleKeepalive: () => () => undefined,
          gate,
          probeMemory,
          host: device.ip,
        },
        60_000,
      ),
    );
  }
  try {
    if (!(await adapter.connect())) {
      throw new Error(`${device.id}/${transport} did not connect`);
    }
    const objects = new Map(adapter.buildObjects().map(def => [def.id, def] as const));
    // What the controller reported, owned or not — the adapter keeps the last value of every id (C21).
    const reported = (adapter as unknown as { latest: Map<string, unknown> }).latest;
    for (const [id, value] of reported) {
      values.set(id, value);
    }
    return { objects, values };
  } finally {
    adapter.close();
  }
}

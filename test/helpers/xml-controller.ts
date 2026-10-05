import type { ObjectDef } from "../../src/lib/catalog/types";
import { CommandGate } from "../../src/lib/lifecycle/command-gate";
import { DISCOVERY_SCHEMA } from "../../src/lib/lifecycle/discovery-schema";
import { ProbeMemory } from "../../src/lib/lifecycle/probe-memory";
import type { XmlClientLike } from "../../src/lib/xml/controller-context";
import { XmlDeviceController } from "../../src/lib/xml/device-controller";
import type { BasicStatus, XmlSystemConfig } from "../../src/lib/xml/protocol";

/** One request the fake client saw. */
export interface XmlCall {
  /** `getStatus`, `getXml`, `send`, `getSystemConfig` or `getDescriptor`. */
  method: string;
  /** The element the request went to. */
  zone: string;
  /** The inner XML, where the request carries one. */
  inner?: string;
  /** The gate priority the caller asked for, where it asked for one. */
  priority?: string;
}

/**
 * A scriptable XML client — a TEST helper (the controller's tests, the review regression tests): canned answers per
 * `<element>|<inner>`, canned failures, and a record of every request with the priority it was asked at.
 */
export class FakeXmlClient implements XmlClientLike {
  /** Every request, in order. */
  public calls: XmlCall[] = [];
  /** Canned GET answers keyed `<element>|<inner>`; unmatched requests answer "" (declares none). */
  public xmlAnswers: Record<string, string> = {};
  /** Canned GET failures keyed like {@link xmlAnswers}. */
  public xmlErrors: Record<string, Error> = {};
  /** The device's declaration of itself. */
  public config: XmlSystemConfig = {};
  /** The raw device description; undefined = an empty body (declares none). */
  public descriptor: string | undefined = undefined;
  /** A rejection every send answers with — the device refusing, or not answering at all. */
  public sendError: Error | undefined = undefined;
  /** Status reads that fail, keyed by element. */
  public statusErrors: Record<string, Error> = {};

  /**
   * @param statuses the Basic_Status answer per zone element
   */
  public constructor(public statuses: Record<string, BasicStatus>) {}

  /**
   * @param zone the zone element
   * @param priority the gate priority the caller asked for
   * @returns the canned status
   */
  public getStatus(zone: string, priority?: string): Promise<BasicStatus> {
    this.calls.push({ method: "getStatus", zone, ...(priority ? { priority } : {}) });
    const failure = this.statusErrors[zone];
    return failure ? Promise.reject(failure) : Promise.resolve(this.statuses[zone] ?? {});
  }

  /** @returns the canned declaration */
  public getSystemConfig(): Promise<XmlSystemConfig> {
    this.calls.push({ method: "getSystemConfig", zone: "" });
    return Promise.resolve(this.config);
  }

  /** @returns the canned description */
  public getDescriptor(): Promise<string> {
    this.calls.push({ method: "getDescriptor", zone: "" });
    return Promise.resolve(this.descriptor ?? "");
  }

  /**
   * @param zone the element
   * @param inner the inner XML
   * @returns settles like the canned send
   */
  public send(zone: string, inner: string): Promise<void> {
    this.calls.push({ method: "send", zone, inner });
    return this.sendError ? Promise.reject(this.sendError) : Promise.resolve();
  }

  /**
   * @param zone the element
   * @param inner the inner XML
   * @param priority the gate priority the caller asked for
   * @returns the canned answer
   */
  public getXml(zone: string, inner: string, priority?: string): Promise<string> {
    this.calls.push({ method: "getXml", zone, inner, ...(priority ? { priority } : {}) });
    const failure = this.xmlErrors[`${zone}|${inner}`];
    return failure ? Promise.reject(failure) : Promise.resolve(this.xmlAnswers[`${zone}|${inner}`] ?? "");
  }

  /** @returns the inner XML of every send, in order */
  public sent(): string[] {
    return this.calls.filter(call => call.method === "send").map(call => `${call.zone}:${call.inner ?? ""}`);
  }
}

/** Everything a test needs from one XML controller. */
export interface XmlHarness {
  /** The controller under test. */
  controller: XmlDeviceController;
  /** Its client. */
  client: FakeXmlClient;
  /** Every object id upserted, in order. */
  objects: string[];
  /** The last definition per full object id. */
  defs: Map<string, ObjectDef>;
  /** Every acknowledged value, in order. */
  acks: Array<{ id: string; value: unknown }>;
  /** Every debug line. */
  debugs: string[];
  /** Every warn line. */
  warnings: string[];
  /** Fires the keepalive poll. */
  poll(): void;
  /** The device's probe memory. */
  memory: ProbeMemory;
}

/** Where a harness forwards what the controller writes — a transport adapter's intercepts, for a handle test. */
export interface XmlTree {
  /** Receives every upsert after the harness recorded it. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Receives every value after the harness recorded it. */
  setStateAck(id: string, value: boolean | number | string | null): void;
}

/**
 * Build an XML controller for device `living` over a {@link FakeXmlClient}.
 *
 * @param statuses the Basic_Status answer per zone element
 * @param memory the probe memory (a fresh one by default)
 * @param tree where to forward the controller's objects and values as well (a transport adapter's intercepts)
 * @returns the harness
 */
export function xmlHarness(statuses: Record<string, BasicStatus>, memory?: ProbeMemory, tree?: XmlTree): XmlHarness {
  const client = new FakeXmlClient(statuses);
  const objects: string[] = [];
  const defs = new Map<string, ObjectDef>();
  const acks: Array<{ id: string; value: unknown }> = [];
  const debugs: string[] = [];
  const warnings: string[] = [];
  const keepalive: { run?: () => void } = {};
  const probeMemory = memory ?? new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
  const controller = new XmlDeviceController("living", {
    gate: new CommandGate({
      minSpacingMs: 0,
      timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
    }),
    probeMemory,
    client,
    scheduleKeepalive: handler => {
      keepalive.run = handler;
      return () => undefined;
    },
    upsertObject: (id, def) => {
      objects.push(id);
      defs.set(id, def);
      return tree ? tree.upsertObject(id, def) : Promise.resolve();
    },
    setStateAck: (id, value) => {
      acks.push({ id, value });
      tree?.setStateAck(id, value);
    },
    log: {
      debug: line => void debugs.push(line),
      info: () => undefined,
      warn: line => void warnings.push(line),
    },
    host: "192.0.2.10",
  });
  return {
    controller,
    client,
    objects,
    defs,
    acks,
    debugs,
    warnings,
    poll: () => keepalive.run?.(),
    memory: probeMemory,
  };
}

/**
 * Let the fire-and-forget chains (read-backs, gate queue) run.
 *
 * @param rounds how many macrotask turns to wait
 */
export async function settle(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

import type { YncaCapabilities } from "./ynca/capability";
import type { ObjectDef } from "./catalog/types";
import type { ConnectionHandle, ControllerLog } from "./controller";
import {
  buildYncaCatalog,
  funcToEntry,
  idToEntry,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
} from "./ynca/catalog";

// The YNCA catalog and its lookup maps are static — built once for all devices.
const CATALOG = buildYncaCatalog();
const FUNC_MAP = funcToEntry(CATALOG);
const ID_MAP = idToEntry(CATALOG);
// The init sweep: the model name (for the ready log line) plus every catalogued function.
const SWEEP = [{ subunit: "SYS", func: "MODELNAME" }, ...sweepGets(CATALOG)];

/** The subset of the YNCA client the controller uses (so tests can inject a fake). */
export interface YncaClientLike {
  /** Open the connection. */
  connect(): Promise<void>;
  /** Run the init sweep and return the device's capabilities. */
  readCapabilities(
    gets: Array<{ subunit: string; func: string }>,
    spacingMs?: number,
    settleMs?: number,
  ): Promise<YncaCapabilities>;
  /** Send a PUT command. */
  send(subunit: string, func: string, value: string): void;
  /** Register a handler for pushed messages. */
  onMessage(handler: (message: { subunit: string; func: string; value: string }) => void): void;
  /** Register the socket-drop handler the supervisor reconnects on. */
  onDrop(handler: (reason?: Error) => void): void;
  /** Start the keepalive poll — called after the init sweep, not on connect. */
  startKeepalive(): void;
  /** Close the connection synchronously. */
  close(): void;
}

export type { ControllerLog };

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface ControllerDeps {
  /** The YNCA client for this device. */
  client: YncaClientLike;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter log. */
  log: ControllerLog;
}

/**
 * Drives one YNCA device: connect, init sweep, build the object tree, and route
 * commands both ways. Create-only — orphan cleanup and legacy migration are
 * separate, gated steps.
 */
export class YncaDeviceController implements ConnectionHandle {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: ControllerDeps,
  ) {}

  /**
   * Connect, sweep the device from the catalog, and create its object tree; wire
   * up push updates. The catalog is the single source: it drives the sweep, the
   * device→state read-back and (in handleStateChange) the state→wire encode.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  public async start(): Promise<boolean> {
    await this.deps.client.connect();
    const capabilities = await this.deps.client.readCapabilities(SWEEP);
    const objects = yncaObjectsFor(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // Parents before children (channels before their states) — created in order.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    // Seed the states with the values read during the init sweep — otherwise they
    // stay empty until the device pushes a change of its own.
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        const update = yncaStateUpdate({ subunit, func, value }, FUNC_MAP);
        if (update) {
          this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        }
      }
    }
    this.deps.client.onMessage(message => {
      const update = yncaStateUpdate(message, FUNC_MAP);
      if (update) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    });
    // Start the keepalive only now the sweep is done, so its 30 s poll never collides
    // with the paced init sweep.
    this.deps.client.startKeepalive();
    this.deps.log.info(`${this.deviceId}: ${capabilities.model || "device"} ready`);
    return true;
  }

  /**
   * Handle a state change: a user write (ack false) becomes a YNCA command; an
   * acked change (the device's own echo) is ignored to avoid a resend loop.
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  public handleStateChange(fullStateId: string, ack: boolean, value: unknown): void {
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const triple = yncaCommand(fullStateId.slice(prefix.length), value, ID_MAP);
    if (triple) {
      this.deps.client.send(triple.subunit, triple.func, triple.value);
    }
  }

  /**
   * Register the supervisor's drop handler — delegated to the client's socket drop,
   * which is YNCA's genuine connection-lost signal.
   *
   * @param cb invoked once when the connection drops, with the reason if known
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.deps.client.onDrop(cb);
  }

  /** Close the client. Synchronous — safe to call from onUnload. */
  public close(): void {
    this.deps.client.close();
  }
}

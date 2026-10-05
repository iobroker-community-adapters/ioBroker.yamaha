/**
 * Shared contracts for the device controllers. The multi-transport handle implements
 * {@link ConnectionHandle}, so the supervisor holds one handle per device and drives it
 * through this shape; each transport controller (YNCA/YXC/XML) sits behind a
 * TransportConnectionAdapter and contributes its objects and writes to the unified tree.
 */
import type { ObjectDef } from "./catalog/types";
import type { HandleCapture } from "./diagnostics/types";
import type { CommandGate } from "./lifecycle/command-gate";
import type { ProbeMemory } from "./lifecycle/probe-memory";

/** Log surface every device controller needs — one definition, not one per transport. */
export interface ControllerLog {
  /** Routine detail. */
  debug(message: string): void;
  /** Relevant events. */
  info(message: string): void;
  /** Warnings. */
  warn(message: string): void;
}

/**
 * What every transport controller is built with — declared once instead of three times (review 2026-10-05, D).
 * The transport connection adapter intercepts `upsertObject` and `setStateAck`, so a controller never writes the
 * tree itself.
 */
export interface ControllerDepsBase {
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string | null): void;
  /** Adapter log. */
  log: ControllerLog;
  /**
   * The device's command gate for this transport: every request is paced through it, and its signal is the
   * connection's shutdown flag — a closed gate ends pending waits and stops state writes from a request that
   * was already in flight.
   */
  gate: CommandGate;
  /** Per-device memory for answers that do not change while the device runs (see ProbeMemory). */
  probeMemory: ProbeMemory;
}

/**
 * A live connection to a device, handed back by a successful connection attempt.
 * The supervisor holds it, routes writes through it, reconnects on its drop and
 * closes it on teardown.
 */
export interface ConnectionHandle {
  /**
   * Register the callback invoked once when this connection drops, so the
   * supervisor can reconnect. The optional reason is the last error, for logging.
   *
   * @param cb invoked once on an unexpected drop, with the reason if known
   */
  onDrop(cb: (reason?: Error) => void): void;
  /**
   * Route a state change (a user write or a device echo) to the controller.
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  handleStateChange(fullStateId: string, ack: boolean, value: unknown): void;
  /**
   * Read the device for a diagnostics report (optional — a handle without it reports nothing).
   *
   * @returns who serves what, and what the device answered
   */
  capture?(): Promise<HandleCapture>;
  /** Close the connection synchronously — safe to call from onUnload. */
  close(): void;
}

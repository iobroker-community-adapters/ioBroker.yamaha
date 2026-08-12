/**
 * Shared contracts for the device controllers. The multi-transport handle implements
 * {@link ConnectionHandle}, so the supervisor holds one handle per device and drives it
 * through this shape; each transport controller (YNCA/YXC/XML) sits behind a
 * TransportConnectionAdapter and contributes its objects and writes to the unified tree.
 */

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
  /** Close the connection synchronously — safe to call from onUnload. */
  close(): void;
}

/** The three network protocols a Yamaha device may speak. */
export type Protocol = "ynca" | "yxc" | "xml";

/** Where a command was routed, or "skip" when no protocol can serve it. */
export type TransportDecision = Protocol | "skip";

/**
 * A command to apply to a device. `kind` is a dotted capability path — either an
 * amplifier capability (`power`, `volume`, `mute`, `input`, `soundProgram`, …)
 * or a YXC-exclusive one (`netusb.*`, `tuner.*`, `cd.*`, `clock.*`, `dist.*`).
 */
export interface DeviceCommand {
  /** Dotted capability path, e.g. `power` or `netusb.play`. */
  kind: string;
  /** Optional command payload. */
  value?: string | number | boolean;
}

/** A configured device and the protocols it was found to speak. */
export interface DeviceRecord {
  /** Stable device id (used as the object-tree path segment). */
  id: string;
  /** Device IP address. */
  ip: string;
  /** Protocols this device speaks. */
  protocols: Set<Protocol>;
}

/** What a device can do, as reported by a transport client. */
export interface CapabilityReport {
  /** The protocol that produced this report. */
  protocol: Protocol;
  /** The capability paths the device supports over this protocol. */
  capabilities: string[];
}

/** A state change pushed from a device. */
export interface StateUpdate {
  /** Dotted state path that changed. */
  path: string;
  /** The new value. */
  value: string | number | boolean;
}

/** A unified state id and its typed value (command-mapper / status-parser form). */
export interface StateValue {
  /** State id relative to the device (e.g. `power`, `zone2.volume`). */
  id: string;
  /** Typed value for the state. */
  value: boolean | number | string;
}

/**
 * The uniform shape every transport client (YNCA / YXC / XML) implements, so the
 * command-router and lifecycle can treat them interchangeably. Implemented in the
 * per-protocol build phases; declared here as the fixed contract from phase 1 on.
 */
export interface TransportClient {
  /** Open the connection to the device. */
  connect(): Promise<void>;
  /** Close the connection synchronously — safe to call from onUnload. */
  close(): void;
  /**
   * Send a command to the device.
   *
   * @param cmd the command to send
   */
  sendCommand(cmd: DeviceCommand): Promise<void>;
  /** Probe what the device can do over this protocol. */
  readCapabilities(): Promise<CapabilityReport>;
  /**
   * Register a callback for state changes the device pushes.
   *
   * @param cb invoked with each state update
   */
  onUpdate(cb: (update: StateUpdate) => void): void;
  /** Whether the device is currently reachable. */
  isReachable(): boolean;
}

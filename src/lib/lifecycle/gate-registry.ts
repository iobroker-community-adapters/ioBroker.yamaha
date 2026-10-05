import type { Transport } from "../catalog/owner-policy";
import { CommandGate, type CommandGateTimers } from "./command-gate";

/**
 * Minimum spacing between two commands, per transport. YNCA's 100 ms is Yamaha's
 * specification (`ynca-python` protocol.py: "YNCA spec specifies that there should be at
 * least 100 milliseconds between commands"). The HTTP transports have no documented
 * spacing — 0 ms, but they still run through a gate, which serialises them so an embedded
 * device never faces a burst of parallel requests.
 */
export const COMMAND_SPACING_MS: Readonly<Record<Transport, number>> = { ynca: 100, yxc: 0, xml: 0 };

/**
 * The command gates of the device connections that run in this process, by transport and by every address their
 * device is known by — typed and resolved (Y-15: one gate per device and protocol). A client for ANOTHER configured
 * device — the MusicCast Link partner a group is built with, a device identified before it is added — took no gate
 * at all: linking a running WX-030 sent getFeatures, setClientInfo and setInput in parallel to its own keepalive
 * (review 2026-10-05, A13). Such a client takes the running connection's gate from here.
 *
 * Process-wide on purpose: the gate belongs to the physical device, whichever code path talks to it. A gate is held
 * until it closes (its connection closed), so nothing here outlives a connection.
 */
export class GateRegistry {
  private readonly held = new Map<string, CommandGate>();

  /**
   * Hold a running connection's gate under one more of its device's addresses, until the gate closes. The newest
   * connection wins an address.
   *
   * @param transport the gate's transport
   * @param address an address the device is known by
   * @param gate the connection's gate
   */
  public hold(transport: Transport, address: string, gate: CommandGate): void {
    if (gate.closed) {
      return;
    }
    const key = `${transport} ${address}`;
    this.held.set(key, gate);
    gate.signal.addEventListener(
      "abort",
      () => {
        if (this.held.get(key) === gate) {
          this.held.delete(key);
        }
      },
      { once: true },
    );
  }

  /**
   * The gate of the running connection at an address.
   *
   * @param transport the transport
   * @param address the address
   * @returns the gate, or undefined when no connection of that transport runs there
   */
  public gateAt(transport: Transport, address: string): CommandGate | undefined {
    const gate = this.held.get(`${transport} ${address}`);
    return gate && !gate.closed ? gate : undefined;
  }

  /**
   * The gate a client for a device at an address goes through: the running connection's, else a gate of its own.
   *
   * @param transport the transport
   * @param address the device's address
   * @param timers the timers a gate of its own paces with (the adapter's)
   * @returns the gate
   */
  public gateFor(transport: Transport, address: string, timers: CommandGateTimers): CommandGate {
    return this.gateAt(transport, address) ?? new CommandGate({ minSpacingMs: COMMAND_SPACING_MS[transport], timers });
  }
}

/** The gates of the connections running in this process (see {@link GateRegistry}). */
export const LIVE_GATES = new GateRegistry();

import { CommandGate } from "./command-gate";
import { COMMAND_SPACING_MS, GateRegistry } from "./gate-registry";

const timers = { schedule: (): undefined => undefined, cancel: (): void => undefined };

describe("GateRegistry — the gates of the running connections (review 2026-10-05, A13)", () => {
  test("a gate is held under each address of its device and per transport, until it closes", () => {
    const registry = new GateRegistry();
    const gate = new CommandGate({ minSpacingMs: 0, timers });
    registry.hold("yxc", "wx030.fritz.box", gate);
    registry.hold("yxc", "192.168.1.30", gate);
    expect(registry.gateAt("yxc", "192.168.1.30")).toBe(gate);
    expect(registry.gateAt("yxc", "wx030.fritz.box")).toBe(gate);
    expect(registry.gateAt("xml", "192.168.1.30")).toBeUndefined();
    gate.close();
    expect(registry.gateAt("yxc", "192.168.1.30")).toBeUndefined();
  });

  test("the newest connection wins an address, and the old one closing does not take it away", () => {
    const registry = new GateRegistry();
    const old = new CommandGate({ minSpacingMs: 0, timers });
    const fresh = new CommandGate({ minSpacingMs: 0, timers });
    registry.hold("yxc", "192.168.1.30", old);
    registry.hold("yxc", "192.168.1.30", fresh);
    old.close();
    expect(registry.gateAt("yxc", "192.168.1.30")).toBe(fresh);
  });

  test("no running connection: a gate of its own, paced as its transport", () => {
    const registry = new GateRegistry();
    const own = registry.gateFor("xml", "192.168.1.40", timers);
    expect(own).toBeInstanceOf(CommandGate);
    expect(registry.gateFor("xml", "192.168.1.40", timers)).not.toBe(own);
    expect(COMMAND_SPACING_MS).toEqual({ ynca: 100, yxc: 0, xml: 0 });
  });
});

import { describe, expect, test } from "vitest";
import { CommandGate, type CommandPriority } from "../lib/lifecycle/command-gate";
import { YncaClient, type YncaSocket } from "../lib/ynca/ynca-client";
import { YamahaYxcClient } from "../lib/yxc/http-client";
import { XmlClient } from "../lib/xml/xml-client";

// Y-15: every device command passes one central command gate — one gate per device and protocol. Nothing reaches a
// device past it: user writes, reads, keepalives and browsing alike.

const timers = {
  schedule: (handler: () => void, ms: number): ioBroker.Timeout =>
    setTimeout(handler, ms) as unknown as ioBroker.Timeout,
  cancel: (handle: ioBroker.Timeout | undefined): void =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

/** A real gate that knows whether a command is running inside it right now. */
class WatchedGate extends CommandGate {
  public inside = 0;
  public passed = 0;
  public constructor() {
    super({ minSpacingMs: 0, timers });
  }
  public override run<T>(run: () => Promise<T> | T, priority?: CommandPriority, key?: string): Promise<T> {
    return super.run(
      async () => {
        this.inside++;
        this.passed++;
        try {
          return await run();
        } finally {
          this.inside--;
        }
      },
      priority,
      key,
    );
  }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe("Y-15 every device command passes the command gate of its device and protocol", () => {
  test("YNCA: every line on the wire is written inside the gate", async () => {
    const gate = new WatchedGate();
    const outside: string[] = [];
    let written = 0;
    let onConnect: () => void = () => undefined;
    const socket: YncaSocket = {
      write: data => {
        written++;
        if (gate.inside === 0) {
          outside.push(String(data));
        }
      },
      destroy: () => undefined,
      onData: () => undefined,
      onConnect: handler => {
        onConnect = handler;
      },
      onClose: () => undefined,
      onError: () => undefined,
    };
    const client = new YncaClient("10.0.0.6", timers, gate, () => socket);
    const connected = client.connect();
    onConnect();
    await connected;
    client.get("MAIN", "PWR");
    client.get("MAIN", "VOL", "user");
    void client.send("MAIN", "MUTE", "On");
    await settle();
    client.close();
    expect(written).toBeGreaterThan(2);
    expect(outside).toEqual([]);
  });

  test("MusicCast: every request, read or write, is sent inside the gate", async () => {
    const gate = new WatchedGate();
    const sent: Array<{ command: string; inside: boolean }> = [];
    const client = new YamahaYxcClient(
      "10.0.0.7",
      command => {
        sent.push({ command, inside: gate.inside > 0 });
        return Promise.resolve({ response_code: 0 });
      },
      gate,
    );
    await client.power(true, "main");
    await client.getStatus("main");
    await client.setInput("hdmi1", "main");
    expect(sent).toHaveLength(3);
    expect(sent.filter(request => !request.inside)).toEqual([]);
    expect(gate.passed).toBe(3);
  });

  test("XML: every request, read or write, is sent inside the gate", async () => {
    const gate = new WatchedGate();
    const sent: boolean[] = [];
    const client = new XmlClient(
      "10.0.0.8",
      () => {
        sent.push(gate.inside > 0);
        return Promise.resolve('<YAMAHA_AV rsp="PUT" RC="0"></YAMAHA_AV>');
      },
      gate,
      () => {
        sent.push(gate.inside > 0);
        return Promise.resolve("<Unit_Description/>");
      },
    );
    await client.send("Main_Zone", "<Power_Control><Power>On</Power></Power_Control>");
    await client.getDescriptor();
    expect(sent).toEqual([true, true]);
  });

  test("the gate runs one command at a time, and a user command goes before queued background work", async () => {
    const gate = new CommandGate({ minSpacingMs: 0, timers });
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = gate.run(
      () =>
        new Promise<void>(resolve => {
          order.push("sweep 1 start");
          release = () => {
            order.push("sweep 1 end");
            resolve();
          };
        }),
    );
    const second = gate.run(() => {
      order.push("sweep 2");
    });
    const press = gate.run(() => {
      order.push("key press");
    }, "user");
    await settle();
    expect(order).toEqual(["sweep 1 start"]);
    release();
    await Promise.all([first, second, press]);
    expect(order).toEqual(["sweep 1 start", "sweep 1 end", "key press", "sweep 2"]);
  });
});

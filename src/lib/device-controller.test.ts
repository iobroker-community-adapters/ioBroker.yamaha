import { YncaDeviceController } from "./device-controller";
import type { YncaClientLike } from "./device-controller";
import type { YncaCapabilities } from "./ynca/capability";

interface Msg {
  subunit: string;
  func: string;
  value: string;
}

class FakeClient implements YncaClientLike {
  public sent: Msg[] = [];
  public closed = false;
  public keepaliveStarted = false;
  public capabilities: YncaCapabilities = { model: "", subunits: {} };
  private handler?: (message: Msg) => void;

  public async connect(): Promise<void> {}
  public async readCapabilities(): Promise<YncaCapabilities> {
    return this.capabilities;
  }
  public send(subunit: string, func: string, value: string): void {
    this.sent.push({ subunit, func, value });
  }
  public onMessage(handler: (message: Msg) => void): void {
    this.handler = handler;
  }
  public onDrop(): void {}
  public startKeepalive(): void {
    this.keepaliveStarted = true;
  }
  public close(): void {
    this.closed = true;
  }
  public emit(message: Msg): void {
    this.handler?.(message);
  }
}

function makeDeps(client: FakeClient): {
  created: string[];
  acked: Array<{ id: string; value: unknown }>;
  deps: ConstructorParameters<typeof YncaDeviceController>[1];
} {
  const created: string[] = [];
  const acked: Array<{ id: string; value: unknown }> = [];
  return {
    created,
    acked,
    deps: {
      client,
      upsertObject: async (id: string) => {
        created.push(id);
      },
      setStateAck: (id: string, value: boolean | number | string) => {
        acked.push({ id, value });
      },
      log: { debug() {}, info() {}, warn() {} },
    },
  };
}

describe("YncaDeviceController", () => {
  test("start arms the keepalive once, after the sweep", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX", subunits: { MAIN: { PWR: "On" } } };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("dev", deps);
    expect(client.keepaliveStarted).toBe(false);
    await controller.start();
    expect(client.keepaliveStarted).toBe(true);
  });

  test("start creates the object tree from the swept capabilities", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX-A810", subunits: { MAIN: { PWR: "On", VOL: "-30.0" } } };
    const { created, deps } = makeDeps(client);
    const ok = await new YncaDeviceController("living", deps).start();
    expect(ok).toBe(true);
    expect(created).toContain("living.power");
    expect(created).toContain("living.volume");
  });

  test("start seeds the states with the values read during the init sweep", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX-A810", subunits: { MAIN: { PWR: "On", VOL: "-30.0", MUTE: "Off" } } };
    const { acked, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    expect(acked).toContainEqual({ id: "living.power", value: true });
    expect(acked).toContainEqual({ id: "living.volume", value: -30 });
    expect(acked).toContainEqual({ id: "living.mute", value: false });
  });

  test("start creates nothing and returns false when no capabilities come back", async () => {
    const client = new FakeClient();
    const { created, deps } = makeDeps(client);
    const ok = await new YncaDeviceController("living", deps).start();
    expect(ok).toBe(false);
    expect(created).toEqual([]);
  });

  test("creates a channel before its child states", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "X", subunits: { MAIN: { PWR: "On" }, ZONE2: { PWR: "On" } } };
    const { created, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    expect(created.indexOf("living.zone2")).toBeLessThan(created.indexOf("living.zone2.power"));
  });

  test("a device push updates the matching state with an ack", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "X", subunits: { MAIN: { PWR: "Standby" } } };
    const { acked, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    client.emit({ subunit: "MAIN", func: "PWR", value: "On" });
    expect(acked).toContainEqual({ id: "living.power", value: true });
  });

  test("a user write (ack false) is sent to the device", () => {
    const client = new FakeClient();
    new YncaDeviceController("living", makeDeps(client).deps).handleStateChange("living.power", false, true);
    expect(client.sent).toEqual([{ subunit: "MAIN", func: "PWR", value: "On" }]);
  });

  test("an acked change (device echo) is not sent back", () => {
    const client = new FakeClient();
    new YncaDeviceController("living", makeDeps(client).deps).handleStateChange("living.power", true, true);
    expect(client.sent).toEqual([]);
  });

  test("close closes the client", () => {
    const client = new FakeClient();
    const controller = new YncaDeviceController("living", makeDeps(client).deps);
    controller.close();
    expect(client.closed).toBe(true);
  });
});

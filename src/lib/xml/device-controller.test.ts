import { XmlDeviceController } from "./device-controller";
import type { XmlClientLike } from "./device-controller";
import type { BasicStatus } from "./protocol";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

class FakeClient implements XmlClientLike {
  public calls: Array<{ method: string; zone: string; inner?: string }> = [];
  public constructor(private readonly statuses: Record<string, BasicStatus>) {}
  public async getStatus(zone: string): Promise<BasicStatus> {
    this.calls.push({ method: "getStatus", zone });
    return this.statuses[zone] ?? {};
  }
  public modelName: string | undefined = undefined;
  public async getModelName(): Promise<string | undefined> {
    this.calls.push({ method: "getModelName", zone: "" });
    return this.modelName;
  }
  public async send(zone: string, inner: string): Promise<void> {
    this.calls.push({ method: "send", zone, inner });
  }
}

function setup(
  statuses: Record<string, BasicStatus>,
  pollIntervalMs?: number,
): {
  controller: XmlDeviceController;
  client: FakeClient;
  objects: string[];
  acks: Array<{ id: string; value: unknown }>;
  fire: { keepalive?: () => void; keepaliveMs?: number };
  cancelled: () => boolean;
} {
  const client = new FakeClient(statuses);
  const objects: string[] = [];
  const acks: Array<{ id: string; value: unknown }> = [];
  const fire: { keepalive?: () => void; keepaliveMs?: number } = {};
  let cancelled = false;
  const controller = new XmlDeviceController(
    "living",
    {
      client,
      scheduleKeepalive: (handler, ms) => {
        fire.keepalive = handler;
        fire.keepaliveMs = ms;
        return () => {
          cancelled = true;
        };
      },
      upsertObject: async id => {
        objects.push(id);
      },
      setStateAck: (id, value) => {
        acks.push({ id, value });
      },
      log: silentLog,
    },
    pollIntervalMs,
  );
  return { controller, client, objects, acks, fire, cancelled: () => cancelled };
}

describe("XmlDeviceController", () => {
  test("polls at the configured interval", async () => {
    const s = setup({ Main_Zone: { power: true } }, 15000);
    await s.controller.start();
    expect(s.fire.keepaliveMs).toBe(15000);
  });

  test("defaults to a 60 s poll interval", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    expect(s.fire.keepaliveMs).toBe(60000);
  });

  test("creates info.model from the System/Config model name", async () => {
    const s = setup({ Main_Zone: { power: true } });
    s.client.modelName = "RX-V1900";
    await s.controller.start();
    expect(s.objects).toContain("living.info.model");
    expect(s.acks).toContainEqual({ id: "living.info.model", value: "RX-V1900" });
  });

  test("builds the amp tree for the main zone and seeds its state", async () => {
    const s = setup({ Main_Zone: { power: true, volume: -30, mute: false, input: "HDMI1" } });
    expect(await s.controller.start()).toBe(true);
    expect(s.objects).toEqual(expect.arrayContaining(["living.power", "living.volume", "living.mute", "living.input"]));
    expect(s.acks).toContainEqual({ id: "living.power", value: true });
    expect(s.acks).toContainEqual({ id: "living.volume", value: -30 });
  });

  test("adds a further zone as a channel when it responds", async () => {
    const s = setup({ Main_Zone: { power: true }, Zone_2: { power: false } });
    await s.controller.start();
    expect(s.objects).toContain("living.zone2");
    expect(s.objects).toContain("living.zone2.power");
  });

  test("returns false and builds nothing when the main zone does not answer", async () => {
    const s = setup({});
    expect(await s.controller.start()).toBe(false);
    expect(s.objects).toEqual([]);
  });

  test("a user write becomes the matching XML command", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.power", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({
      method: "send",
      zone: "Main_Zone",
      inner: "<Power_Control><Power>On</Power></Power_Control>",
    });
  });

  test("an acked change is ignored", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.power", true, true);
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("keepalive polls the live zones", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", zone: "Main_Zone" });
  });

  test("close cancels the keepalive", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.controller.close();
    expect(s.cancelled()).toBe(true);
  });

  test("creates the scene channel + a main-only recall, but nothing scene/HDMI under a further zone", async () => {
    const s = setup({ Main_Zone: { power: true }, Zone_2: { power: false } });
    await s.controller.start();
    expect(s.objects).toContain("living.scene");
    expect(s.objects).toContain("living.scene.recall");
    expect(s.objects).not.toContain("living.zone2.scene.recall");
    expect(s.objects).not.toContain("living.zone2.hdmiOut1");
  });
});

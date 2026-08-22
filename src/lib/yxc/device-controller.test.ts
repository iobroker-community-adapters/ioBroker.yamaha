import { YxcDeviceController } from "./device-controller";
import type { YxcClientLike } from "./device-controller";
import wx10 from "./__fixtures__/WX10_216_208.json";
import ysp from "./__fixtures__/status/YSP1600_main.json";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

class FakeClient implements YxcClientLike {
  public calls: Array<{ method: string; args: unknown[] }> = [];
  public failStatus = false;
  public constructor(
    private readonly features: unknown,
    private readonly status: unknown,
  ) {}
  public async getFeatures(): Promise<unknown> {
    return this.features;
  }
  public async getStatus(zone: string): Promise<unknown> {
    this.calls.push({ method: "getStatus", args: [zone] });
    if (this.failStatus) {
      throw new Error("device offline");
    }
    return this.status;
  }
  public deviceInfo: unknown = {};
  public async getDeviceInfo(): Promise<unknown> {
    this.calls.push({ method: "getDeviceInfo", args: [] });
    return this.deviceInfo;
  }
  public async power(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "power", args: [on, zone] });
    return {};
  }
  public async setVolumeTo(to: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "setVolumeTo", args: [to, zone] });
    return {};
  }
  public async mute(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "mute", args: [on, zone] });
    return {};
  }
  public async setInput(input: string, zone: string): Promise<unknown> {
    this.calls.push({ method: "setInput", args: [input, zone] });
    return {};
  }
  public async setSound(program: string, zone: string): Promise<unknown> {
    this.calls.push({ method: "setSound", args: [program, zone] });
    return {};
  }
  public async setEnhancer(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "setEnhancer", args: [on, zone] });
    return {};
  }
  public async setPureDirect(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "setPureDirect", args: [on, zone] });
    return {};
  }
  public async getPlayInfo(source?: string): Promise<unknown> {
    this.calls.push({ method: "getPlayInfo", args: source === undefined ? [] : [source] });
    if (source === "tuner") {
      return { band: "fm", fm: { freq: 100900 }, rds: { radio_text_a: "Hit" } };
    }
    if (source === "cd") {
      return { playback: "play", track: "Track 1" };
    }
    return {};
  }
  public async setCDPlayback(action: string): Promise<unknown> {
    this.calls.push({ method: "setCDPlayback", args: [action] });
    return {};
  }
  public async toggleNetRepeat(): Promise<unknown> {
    this.calls.push({ method: "toggleNetRepeat", args: [] });
    return {};
  }
  public async toggleNetShuffle(): Promise<unknown> {
    this.calls.push({ method: "toggleNetShuffle", args: [] });
    return {};
  }
  public async toggleCDRepeat(): Promise<unknown> {
    this.calls.push({ method: "toggleCDRepeat", args: [] });
    return {};
  }
  public async toggleCDShuffle(): Promise<unknown> {
    this.calls.push({ method: "toggleCDShuffle", args: [] });
    return {};
  }
  public async toggleTray(): Promise<unknown> {
    this.calls.push({ method: "toggleTray", args: [] });
    return {};
  }
  public async setBand(band: string): Promise<unknown> {
    this.calls.push({ method: "setBand", args: [band] });
    return {};
  }
  public async setFreq(band: string, freq: number): Promise<unknown> {
    this.calls.push({ method: "setFreq", args: [band, freq] });
    return {};
  }
  public async setPartyMode(on: boolean): Promise<unknown> {
    this.calls.push({ method: "setPartyMode", args: [on] });
    return {};
  }
  public async recallPreset(num: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "recallPreset", args: [num, zone] });
    return {};
  }
  public async setEqualizer(low: number, mid: number, high: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "setEqualizer", args: [low, mid, high, zone] });
    return {};
  }
  public distRole = "server";
  public async getDistributionInfo(): Promise<unknown> {
    this.calls.push({ method: "getDistributionInfo", args: [] });
    return {
      role: this.distRole,
      group_id: "g1",
      group_name: "Group 1",
      server_zone: "main",
      client_list: ["1.2.3.5"],
    };
  }
  public async setServerInfo(info: {
    group_id: string;
    zone: string;
    type: string;
    client_list: string[];
  }): Promise<unknown> {
    this.calls.push({ method: "setServerInfo", args: [info] });
    return {};
  }
  public async setClientInfo(info: { group_id: string; zone: string[] }): Promise<unknown> {
    this.calls.push({ method: "setClientInfo", args: [info] });
    return {};
  }
  public async startDistribution(num: number): Promise<unknown> {
    this.calls.push({ method: "startDistribution", args: [num] });
    return {};
  }
  public async stopDistribution(): Promise<unknown> {
    this.calls.push({ method: "stopDistribution", args: [] });
    return {};
  }
  public async setSubwooferVolumeTo(to: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "setSubwooferVolumeTo", args: [to, zone] });
    return {};
  }
  public async setBassTo(to: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "setBassTo", args: [to, zone] });
    return {};
  }
  public async setTrebleTo(to: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "setTrebleTo", args: [to, zone] });
    return {};
  }
  public async sleep(minutes: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "sleep", args: [minutes, zone] });
    return {};
  }
  public async setDirect(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "setDirect", args: [on, zone] });
    return {};
  }
  public async setClearVoice(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "setClearVoice", args: [on, zone] });
    return {};
  }
  public async setBassExtension(on: boolean, zone: string): Promise<unknown> {
    this.calls.push({ method: "setBassExtension", args: [on, zone] });
    return {};
  }
  public async setBalance(value: number, zone: string): Promise<unknown> {
    this.calls.push({ method: "setBalance", args: [value, zone] });
    return {};
  }
  public async playNet(): Promise<unknown> {
    this.calls.push({ method: "playNet", args: [] });
    return {};
  }
  public async pauseNet(): Promise<unknown> {
    this.calls.push({ method: "pauseNet", args: [] });
    return {};
  }
  public async stopNet(): Promise<unknown> {
    this.calls.push({ method: "stopNet", args: [] });
    return {};
  }
  public async nextNet(): Promise<unknown> {
    this.calls.push({ method: "nextNet", args: [] });
    return {};
  }
  public async prevNet(): Promise<unknown> {
    this.calls.push({ method: "prevNet", args: [] });
    return {};
  }
}

function setup(
  features: unknown,
  status: unknown,
  linkTargets: Record<string, YxcClientLike> = {},
): {
  controller: YxcDeviceController;
  client: FakeClient;
  objects: string[];
  acks: Array<{ id: string; value: unknown }>;
  fire: { push?: (event: unknown) => void; keepalive?: () => void };
  cancelled: () => boolean;
  unregistered: () => boolean;
} {
  const client = new FakeClient(features, status);
  const objects: string[] = [];
  const acks: Array<{ id: string; value: unknown }> = [];
  const fire: { push?: (event: unknown) => void; keepalive?: () => void } = {};
  let cancelled = false;
  let unregistered = false;
  const controller = new YxcDeviceController("living", {
    client,
    clientFor: ip => linkTargets[ip],
    registerPush: onPush => {
      fire.push = onPush;
      return () => {
        unregistered = true;
      };
    },
    scheduleKeepalive: handler => {
      fire.keepalive = handler;
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
  });
  return { controller, client, objects, acks, fire, cancelled: () => cancelled, unregistered: () => unregistered };
}

describe("YxcDeviceController", () => {
  test("builds the object tree from getFeatures", async () => {
    const s = setup(wx10, ysp);
    expect(await s.controller.start()).toBe(true);
    expect(s.objects).toEqual(expect.arrayContaining(["living.power", "living.volume", "living.mute"]));
  });

  test("creates info.model from the getDeviceInfo model name", async () => {
    const s = setup(wx10, ysp);
    s.client.deviceInfo = { model_name: "WX-010" };
    await s.controller.start();
    expect(s.objects).toContain("living.info.model");
    expect(s.acks).toContainEqual({ id: "living.info.model", value: "WX-010" });
  });

  test("skips info.model when getDeviceInfo reports no model name", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    expect(s.objects).not.toContain("living.info.model");
  });

  test("sets initial state from getStatus for each zone", async () => {
    const s = setup(wx10, ysp); // YSP status: power=standby→false, volume=30
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.power", value: false });
    expect(s.acks).toContainEqual({ id: "living.volume", value: 30 });
  });

  test("creates nothing and returns false without capabilities", async () => {
    const s = setup({}, ysp);
    expect(await s.controller.start()).toBe(false);
    expect(s.objects).toEqual([]);
  });

  test("a user write (ack false) becomes the matching client call", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.power", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "power", args: [true, "main"] });
  });

  test("an acked change (device echo) is ignored", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.power", true, true);
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("a push refreshes the named zone via getStatus", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.acks.length = 0;
    s.fire.push?.({ main: { power: "on" } });
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["main"] });
    expect(s.acks).toContainEqual({ id: "living.power", value: false });
  });

  test("keepalive polls main to renew the push registration", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["main"] });
  });

  test("close cancels the keepalive", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.controller.close();
    expect(s.cancelled()).toBe(true);
  });

  test("creates cd and tuner blocks and seeds them from their play info", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], cd: {}, tuner: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(s.objects).toEqual(expect.arrayContaining(["living.player.cd.playback", "living.tuner.band"]));
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["cd"] });
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["tuner"] });
    expect(s.acks).toContainEqual({ id: "living.player.cd.track", value: "Track 1" });
    expect(s.acks).toContainEqual({ id: "living.tuner.frequency", value: 100900 });
  });

  test("a cd transport write becomes a setCDPlayback call", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], cd: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.player.cd.play", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setCDPlayback", args: ["play"] });
  });

  test("an equalizer band write sends setEqualizer with the other two bands from the last status", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    const status = { power: "on", equalizer: { mode: "manual", low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.sound.equalizerLow", false, 7);
    await flush();
    // low from the write, mid/high from the cached status, on the main zone.
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [7, 2, 3, "main"] });
  });

  test("a zoned equalizer band write finds the cached bands under the multiroom zone prefix", async () => {
    const features = {
      zone: [
        { id: "main", func_list: ["power", "equalizer"] },
        { id: "zone2", func_list: ["power", "equalizer"] },
      ],
    };
    const status = { power: "on", equalizer: { mode: "manual", low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.multiroom.zone2.sound.equalizerMid", false, -4);
    await flush();
    // mid from the write, low/high from the cached zone2 status — not the 0/0 fallback.
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [1, -4, 3, "zone2"] });
  });

  test("seeds the multiroom channel from getDistributionInfo when the device reports distribution", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(s.objects).toContain("living.multiroom.group.role");
    expect(s.client.calls).toContainEqual({ method: "getDistributionInfo", args: [] });
    expect(s.acks).toContainEqual({ id: "living.multiroom.group.role", value: "server" });
    expect(s.acks).toContainEqual({ id: "living.multiroom.group.linkedDevices", value: '["1.2.3.5"]' });
  });

  test("leaving a group as the server stops distribution", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.multiroom.group.leave", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "stopDistribution", args: [] });
  });

  test("leaving a group as a client clears its client info", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    s.client.distRole = "client";
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.multiroom.group.leave", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setClientInfo", args: [{ group_id: "", zone: ["main"] }] });
  });

  test("linking a client sends it the group, adds it on the server, and starts distribution", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const clientDevice = new FakeClient({}, {});
    const s = setup(features, ysp, { "1.2.3.9": clientDevice });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.multiroom.group.linkDevice", false, "1.2.3.9");
    await flush();
    const join = clientDevice.calls.find(c => c.method === "setClientInfo");
    const add = s.client.calls.find(c => c.method === "setServerInfo");
    expect(add?.args[0]).toMatchObject({ type: "add", client_list: ["1.2.3.9"], zone: "main" });
    expect(s.client.calls).toContainEqual({ method: "startDistribution", args: [0] });
    // The client and server carry the same (non-empty) group id.
    const clientGroup = (join?.args[0] as { group_id: string }).group_id;
    expect(clientGroup).toBeTruthy();
    expect(clientGroup).toBe((add?.args[0] as { group_id: string }).group_id);
  });

  test("linking an unknown ip does nothing", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.multiroom.group.linkDevice", false, "9.9.9.9");
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("a media push refreshes only the named player source, not every zone", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], cd: {}, tuner: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.acks.length = 0;
    s.fire.push?.({ tuner: { play_info_updated: true } });
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["tuner"] });
    expect(s.client.calls).not.toContainEqual({ method: "getPlayInfo", args: ["cd"] });
    expect(s.acks).toContainEqual({ id: "living.tuner.band", value: "fm" });
  });

  test("keepalive also refreshes tuner and cd when present", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], cd: {}, tuner: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["cd"] });
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["tuner"] });
  });

  test("keepalive renews every zone, not just the first", async () => {
    const features = {
      zone: [
        { id: "main", func_list: ["power"] },
        { id: "zone2", func_list: ["power"] },
      ],
    };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["main"] });
    expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["zone2"] });
  });

  test("reports a drop after three consecutive keepalive polls in which every zone fails", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    s.client.failStatus = true; // device goes offline
    for (let i = 0; i < 3; i++) {
      s.fire.keepalive?.();
      await flush();
    }
    expect(dropped).toBe(1);
  });

  test("a single failed poll does not report a drop, and a recovery resets the count", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    s.client.failStatus = true;
    s.fire.keepalive?.();
    await flush();
    s.fire.keepalive?.();
    await flush();
    s.client.failStatus = false; // recovers before the third failure
    s.fire.keepalive?.();
    await flush();
    s.client.failStatus = true;
    s.fire.keepalive?.();
    await flush();
    s.fire.keepalive?.();
    await flush();
    expect(dropped).toBe(0); // never three in a row
  });

  test("close unregisters from the shared push receiver", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.controller.close();
    expect(s.unregistered()).toBe(true);
  });
});

describe("YxcDeviceController guards", () => {
  test("ignores a write meant for another device", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }] };
    const s = setup(features, { power: "on" });
    await s.controller.start();
    s.client.calls.length = 0;
    // "office." is exactly as long as "living." — a foreign id of a different
    // length would be sliced into nonsense and dropped by the command map anyway.
    s.controller.handleStateChange("office.power", false, false);
    await flush();
    expect(s.client.calls).toEqual([]);

    s.controller.handleStateChange("living.power", false, false);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "power", args: [false, "main"] });
  });

  test("reports the device gone exactly once", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }] };
    const s = setup(features, { power: "on" });
    await s.controller.start();
    const drops: Array<Error | undefined> = [];
    s.controller.onDrop(reason => drops.push(reason));
    s.client.failStatus = true;

    for (let i = 0; i < 12; i++) {
      s.fire.keepalive?.();
      await flush();
    }
    // A second report makes the supervisor reconnect a handle it already replaced —
    // two live YXC connections to one device, only one of them reachable by close().
    expect(drops).toHaveLength(1);
  });

  test("merges equalizer bands across status updates instead of zeroing the others", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    const status: Record<string, unknown> = { power: "on", equalizer: { mode: "manual", low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();

    // A later poll carrying only ONE band — the device omits unchanged fields.
    status.equalizer = { mid: 9 };
    s.fire.keepalive?.();
    await flush();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.sound.equalizerLow", false, 7);
    await flush();
    // low from the write, mid from the partial push, high still from the full status.
    // Resetting the cache on every update would send 0 for every band the user did
    // not touch — the device would flatten its own tone settings.
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [7, 9, 3, "main"] });
  });
});

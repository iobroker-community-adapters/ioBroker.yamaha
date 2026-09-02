import { YxcDeviceController, zoneNameFrom } from "./device-controller";
import type { YxcClientLike } from "./device-controller";
import wx10 from "./__fixtures__/WX10_216_208.json";
import ysp from "./__fixtures__/status/YSP1600_main.json";
import { CommandGate } from "../lifecycle/command-gate";
import { ProbeMemory } from "../lifecycle/probe-memory";

/** A real command gate for the controller under test (pacing has its own suite). */
const testGate = (): CommandGate =>
  new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  });

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

/**
 * A recording MusicCast client for the controller tests.
 *
 * Every method records its call and answers from `replies`; anything not listed answers an
 * empty success. Spelling all fifty methods out by hand (which is what the former
 * hand-written client interface forced) added 239 lines that had to be extended with every
 * new client method — the same generic approach the command-mapper tests already use.
 */
interface FakeClient extends YxcClientLike {
  /** Every call the controller made, in order. */
  calls: Array<{ method: string; args: unknown[] }>;
  /** Canned answers, settable per test. */
  features: unknown;
  status: unknown;
  deviceInfo: unknown;
  nameText: unknown;
  listInfo: unknown;
  presetInfo: unknown;
  recentInfo: unknown;
  tunerPresetInfo: unknown;
  clockSettings: unknown;
  /** The netusb getPlayInfo answer (tuner/cd have fixed canned answers). */
  playInfo: unknown;
  /** Per-zone getStatus answers; falls back to `status` for zones not listed. */
  statusByZone: Record<string, unknown> | undefined;
  distRole: string;
  /** Make the zone status / name lookup fail, as an unreachable device would. */
  failStatus: boolean;
  failNameText: boolean;
}

/**
 * Build the recording client.
 *
 * @param features the getFeatures answer
 * @param status the getStatus answer
 * @returns the fake client
 */
function makeFakeClient(features: unknown, status: unknown): FakeClient {
  const state: Record<string, unknown> = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    features,
    status,
    deviceInfo: {},
    nameText: {},
    listInfo: { response_code: 0, menu_layer: 1, menu_name: "", max_line: 0, list_info: [] },
    presetInfo: { response_code: 0, preset_info: [] },
    recentInfo: { response_code: 0, recent_info: [] },
    tunerPresetInfo: { response_code: 0, preset_info: [] },
    clockSettings: { response_code: 0 },
    playInfo: {},
    statusByZone: undefined,
    distRole: "server",
    failStatus: false,
    failNameText: false,
  };
  // The answers that are more than "an empty success".
  const replies: Record<string, (args: unknown[]) => unknown> = {
    getFeatures: () => state.features,
    getStatus: ([zone]) => {
      if (state.failStatus) {
        throw new Error("device offline");
      }
      const byZone = state.statusByZone as Record<string, unknown> | undefined;
      if (byZone && typeof zone === "string" && zone in byZone) {
        return byZone[zone];
      }
      return state.status;
    },
    getDeviceInfo: () => state.deviceInfo,
    getNameText: () => {
      if (state.failNameText) {
        throw new Error("not supported");
      }
      return state.nameText;
    },
    getListInfo: () => state.listInfo,
    setListControl: () => ({ response_code: 0 }),
    getPresetInfo: () => state.presetInfo,
    getRecentInfo: () => state.recentInfo,
    getTunerPresetInfo: () => state.tunerPresetInfo,
    getClockSettings: () => state.clockSettings,
    getPlayInfo: ([source]) => {
      if (source === "tuner") {
        return { band: "fm", fm: { freq: 100900 }, rds: { radio_text_a: "Hit" } };
      }
      if (source === "cd") {
        return { playback: "play", track: "Track 1" };
      }
      return state.playInfo;
    },
    getDistributionInfo: () => ({
      role: state.distRole,
      group_id: "g1",
      group_name: "Group 1",
      server_zone: "main",
      client_list: ["1.2.3.5"],
    }),
  };
  return new Proxy(state, {
    get: (target, prop: string) => {
      if (prop in target) {
        return target[prop];
      }
      return (...args: unknown[]) => {
        // Trailing optional arguments the caller left out are not recorded — otherwise
        // getPlayInfo() would show up as [undefined] instead of [].
        const recorded = [...args];
        while (recorded.length > 0 && recorded[recorded.length - 1] === undefined) {
          recorded.pop();
        }
        (target.calls as Array<{ method: string; args: unknown[] }>).push({ method: prop, args: recorded });
        try {
          return Promise.resolve(replies[prop]?.(args) ?? {});
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
    },
    set: (target, prop: string, value) => {
      target[prop] = value;
      return true;
    },
  }) as unknown as FakeClient;
}

function setup(
  features: unknown,
  status: unknown,
  linkTargets: Record<string, YxcClientLike> = {},
  pushActive?: () => boolean,
): {
  controller: YxcDeviceController;
  client: FakeClient;
  objects: string[];
  acks: Array<{ id: string; value: unknown }>;
  fire: { push?: (event: unknown) => void; keepalive?: () => void };
  names: string[];
  cancelled: () => boolean;
  unregistered: () => boolean;
} {
  const client = makeFakeClient(features, status);
  const objects: string[] = [];
  const acks: Array<{ id: string; value: unknown }> = [];
  const names: string[] = [];
  const fire: { push?: (event: unknown) => void; keepalive?: () => void } = {};
  let cancelled = false;
  let unregistered = false;
  const controller = new YxcDeviceController("living", {
    client,
    clientFor: ip => linkTargets[ip],
    pushActive,
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
    upsertObject: id => {
      objects.push(id);
      return Promise.resolve();
    },
    setStateAck: (id, value) => {
      acks.push({ id, value });
    },
    reportDeviceName: name => {
      names.push(name);
    },
    log: silentLog,
  });
  return {
    controller,
    client,
    objects,
    acks,
    names,
    fire,
    cancelled: () => cancelled,
    unregistered: () => unregistered,
  };
}

describe("YxcDeviceController", () => {
  test("builds the object tree from getFeatures", async () => {
    const s = setup(wx10, ysp);
    expect(await s.controller.start()).toBe(true);
    expect(s.objects).toEqual(expect.arrayContaining(["living.power", "living.volume", "living.mute"]));
  });

  test("reports the model from getDeviceInfo into the adapter-created info.model", async () => {
    const s = setup(wx10, ysp);
    s.client.deviceInfo = { model_name: "WX-010" };
    await s.controller.start();
    // The object itself is created once by the adapter (ensureDeviceHeader) for every
    // device, offline ones included — the transport only fills in the value.
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

  test("creates the flat player + tuner blocks; cd play info feeds the zone LISTENING to the disc (v2.0.0)", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], cd: {}, tuner: {} };
    const s = setup(features, { power: "on", input: "cd" });
    await s.controller.start();
    expect(s.objects).toEqual(expect.arrayContaining(["living.player.playback", "living.tuner.band"]));
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["cd"] });
    expect(s.client.calls).toContainEqual({ method: "getPlayInfo", args: ["tuner"] });
    expect(s.acks).toContainEqual({ id: "living.player.track", value: "Track 1" });
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "cd" });
    expect(s.acks).toContainEqual({ id: "living.tuner.frequency", value: 100900 });
  });

  test("cd play info does NOT touch the block of a zone on another input", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], cd: {} };
    const s = setup(features, ysp); // the fixture's input is hdmi
    await s.controller.start();
    expect(s.acks).not.toContainEqual({ id: "living.player.track", value: "Track 1" });
  });

  test("netusb feeds the listening zone; leaving the source clears the block once", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {} };
    const s = setup(features, { power: "on", input: "net_radio" });
    s.client.playInfo = { input: "net_radio", playback: "play", artist: "BBC" };
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "BBC" });
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "net_radio" });
    // The zone switches to HDMI — the next refresh clears the stale metadata.
    s.client.status = { power: "on", input: "hdmi1" };
    s.acks.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "" });
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "" });
    expect(s.acks).not.toContainEqual({ id: "living.player.artist", value: "BBC" });
  });

  test("a transport button acts on the source the zone is playing — nothing when it plays none", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {}, cd: {} };
    const s = setup(features, { power: "on", input: "cd" });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.player.play", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setCDPlayback", args: ["play"] });
    // Same button while the zone plays no media source: no transport call goes out.
    const idle = setup(features, { power: "on", input: "hdmi1" });
    await idle.controller.start();
    idle.client.calls.length = 0;
    idle.controller.handleStateChange("living.player.play", false, true);
    await flush();
    expect(idle.client.calls).toEqual([]);
  });

  test("an equalizer band write sends setEqualizer with the other two bands from the last status", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    const status = { power: "on", equalizer: { mode: "manual", low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.sound.equalizer.low", false, 7);
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
    s.controller.handleStateChange("living.multiroom.zone2.sound.equalizer.mid", false, -4);
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
    const clientDevice = makeFakeClient({}, {});
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
    s.controller.handleStateChange("living.sound.equalizer.low", false, 7);
    await flush();
    // low from the write, mid from the partial push, high still from the full status.
    // Resetting the cache on every update would send 0 for every band the user did
    // not touch — the device would flatten its own tone settings.
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [7, 9, 3, "main"] });
  });
});

describe("YxcDeviceController reachability (a remembered device must still answer)", () => {
  const oneZone = { system: {}, zone: [{ id: "main", func_list: ["power"], input_list: ["hdmi1"] }] };

  test("a device whose zones all fail to answer does not count as connected", async () => {
    const s = setup(oneZone, { power: "on" });
    s.client.failStatus = true;
    expect(await s.controller.start()).toBe(false);
  });

  test("a reconnect to a device that lost power fails even though its capabilities are remembered", async () => {
    const memory = new ProbeMemory();
    const build = (client: FakeClient): YxcDeviceController =>
      new YxcDeviceController("living", {
        client,
        registerPush: () => () => {},
        scheduleKeepalive: () => () => {},
        upsertObject: async () => {},
        setStateAck: () => {},
        log: silentLog,
        gate: testGate(),
        probeMemory: memory,
      });

    expect(await build(makeFakeClient(oneZone, { power: "on" })).start()).toBe(true);

    // Same adapter run, device now unplugged. getFeatures is never asked again (it is
    // remembered for the device's lifetime), and model/name are best-effort — so the zone
    // status is the ONLY thing left that can notice the device is gone. Reporting "ready"
    // here is what made the adapter claim a live MusicCast connection to a receiver that
    // had lost power, while YNCA and XML failed honestly.
    const second = makeFakeClient(oneZone, { power: "on" });
    second.failStatus = true;
    expect(await build(second).start()).toBe(false);
    expect(second.calls.some(call => call.method === "getFeatures")).toBe(false);
  });
});

describe("zoneNameFrom", () => {
  it("reads the main zone's text — the name shown in the MusicCast app", () => {
    expect(zoneNameFrom({ zone_list: [{ id: "main", text: "Wohnzimmer" }] })).toBe("Wohnzimmer");
  });

  it("ignores the other zones", () => {
    expect(
      zoneNameFrom({
        zone_list: [
          { id: "zone2", text: "Terrasse" },
          { id: "main", text: "Wohnzimmer" },
        ],
      }),
    ).toBe("Wohnzimmer");
  });

  it("returns nothing for an answer that carries no usable name", () => {
    expect(zoneNameFrom({ zone_list: [{ id: "main", text: "  " }] })).toBeUndefined();
    expect(zoneNameFrom({ zone_list: [{ id: "zone2", text: "Terrasse" }] })).toBeUndefined();
    expect(zoneNameFrom({ zone_list: "nonsense" })).toBeUndefined();
    expect(zoneNameFrom(null)).toBeUndefined();
    expect(zoneNameFrom(undefined)).toBeUndefined();
  });
});

describe("YxcDeviceController device name", () => {
  test("reports the name the device carries for itself", async () => {
    const s = setup(wx10, ysp);
    s.client.nameText = { zone_list: [{ id: "main", text: "Wohnzimmer" }] };
    await s.controller.start();
    await flush();
    expect(s.names).toEqual(["Wohnzimmer"]);
  });

  test("connects anyway when the device does not answer getNameText", async () => {
    // Older MusicCast firmware may not know the call — the device still works, it just
    // keeps whatever label it has.
    const s = setup(wx10, ysp);
    s.client.failNameText = true;
    expect(await s.controller.start()).toBe(true);
    await flush();
    expect(s.names).toEqual([]);
  });

  test("start fetches the netusb favourites/recent lists and writes the JSON states", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {} };
    const s = setup(features, ysp);
    s.client.presetInfo = { response_code: 0, preset_info: [{ input: "net_radio", text: "hr3" }] };
    s.client.recentInfo = { response_code: 0, recent_info: [{ input: "spotify", text: "Mix" }] };
    await s.controller.start();
    expect(s.acks).toContainEqual({
      id: "living.player.netPlayer.presets",
      value: JSON.stringify([{ num: 1, input: "net_radio", name: "hr3" }]),
    });
    expect(s.acks).toContainEqual({
      id: "living.player.netPlayer.recent",
      value: JSON.stringify([{ num: 1, input: "spotify", name: "Mix" }]),
    });
  });

  test("a separate-preset tuner is fetched per band; a preset recall uses the current band", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm", "dab"], preset: { type: "separate", num: 30 } },
    };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(s.client.calls).toContainEqual({ method: "getTunerPresetInfo", args: ["fm"] });
    expect(s.client.calls).toContainEqual({ method: "getTunerPresetInfo", args: ["dab"] });
    s.client.calls.length = 0;
    // The YSP status fixture leaves the cached band at its default "fm".
    s.controller.handleStateChange("living.tuner.preset", false, 7);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallTunerPreset", args: ["fm", 7, "main"] });
  });

  test("a common-preset tuner is fetched and recalled on the shared list", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["am", "fm"], preset: { type: "common", num: 40 } },
    };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(s.client.calls).toContainEqual({ method: "getTunerPresetInfo", args: ["common"] });
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.tuner.preset", false, 12);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallTunerPreset", args: ["common", 12, "main"] });
  });

  test("preset up/down and recall-recent writes reach the client", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {}, tuner: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.tuner.presetUp", false, true);
    s.controller.handleStateChange("living.player.netPlayer.recallRecent", false, 2);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "switchTunerPreset", args: ["next"] });
    expect(s.client.calls).toContainEqual({ method: "recallRecentItem", args: [2, "main"] });
  });

  test("a push flagging changed favourites/recents refetches just those lists", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.fire.push?.({ netusb: { preset_info_updated: true, recent_info_updated: true } });
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getPresetInfo", args: [] });
    expect(s.client.calls).toContainEqual({ method: "getRecentInfo", args: [] });
  });

  test("a clock device reads its alarm settings at start", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      clock: { func_list: ["alarm"], alarm_mode_list: ["oneday"] },
    };
    const s = setup(features, ysp);
    s.client.clockSettings = { response_code: 0, auto_sync: true, format: "24h" };
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.clock.autoSync", value: true });
    expect(s.acks).toContainEqual({ id: "living.clock.format", value: "24h" });
    expect(s.client.calls).toContainEqual({ method: "getClockSettings", args: [] });
  });
});

describe("YxcDeviceController browse surface (#613)", () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const browsableFeatures = {
    system: {},
    zone: [{ id: "main", func_list: ["power"], input_list: ["net_radio", "server", "hdmi1"] }],
    netusb: {},
  };

  function browseSetup(features: unknown): {
    controller: YxcDeviceController;
    client: FakeClient;
    objects: string[];
  } {
    const client = makeFakeClient(features, { response_code: 0 });
    const objects: string[] = [];
    const controller = new YxcDeviceController("living", {
      client,
      registerPush: () => () => {},
      scheduleKeepalive: () => () => {},
      upsertObject: id => {
        objects.push(id);
        return Promise.resolve();
      },
      setStateAck: () => {},
      log: silentLog,
      gate: testGate(),
    });
    return { controller, client, objects };
  }

  test("creates the browse tree for a netusb device and routes its writes", async () => {
    const { controller, client, objects } = browseSetup(browsableFeatures);
    await controller.start();
    expect(objects).toContain("living.player.browse");
    expect(objects).toContain("living.player.browse.selectLine");
    controller.handleStateChange("living.player.browse.source", false, "netRadio");
    await flush();
    expect(client.calls).toContainEqual({ method: "getListInfo", args: ["net_radio", 0] });
  });

  test("creates no browse tree without the netusb block", async () => {
    const { controller, objects } = browseSetup({
      system: {},
      zone: [{ id: "main", func_list: ["power"], input_list: ["hdmi1"] }],
    });
    await controller.start();
    expect(objects.some(id => id.includes("player.browse"))).toBe(false);
  });
});

describe("YxcDeviceController recall routing (which zone gets the favourite)", () => {
  const twoZones = {
    system: {},
    zone: [
      { id: "main", func_list: ["power"], input_list: ["hdmi1", "net_radio"] },
      { id: "zone2", func_list: ["power"], input_list: ["net_radio"] },
    ],
    netusb: {},
  };

  /** Set up a two-zone device where main plays HDMI and zone 2 plays net radio. */
  function twoZoneSetup(): Promise<{ controller: YxcDeviceController; client: FakeClient }> {
    const client = makeFakeClient(twoZones, { response_code: 0 });
    // getStatus answers per zone via the recorded call; the controller stores each zone's input.
    const controller = new YxcDeviceController("living", {
      client,
      registerPush: () => () => {},
      scheduleKeepalive: () => () => {},
      upsertObject: async () => {},
      setStateAck: () => {},
      log: silentLog,
    });
    return Promise.resolve({ controller, client });
  }

  test("a favourite goes to the zone that is listening to the network player, not always to main", async () => {
    const { controller, client } = await twoZoneSetup();
    // Main is on HDMI, zone 2 on net radio — and the network player plays net radio.
    const inner = controller as unknown as {
      lastZoneInput: Map<string, string>;
      lastNetusbInput: string;
      applyCommand(stateId: string, command: unknown): Promise<void>;
    };
    inner.lastZoneInput.set("main", "hdmi1");
    inner.lastZoneInput.set("zone2", "net_radio");
    inner.lastNetusbInput = "net_radio";
    await inner.applyCommand("player.netPlayer.preset", { kind: "netusbPreset", value: 3 });
    expect(client.calls).toContainEqual({ method: "recallPreset", args: [3, "zone2"] });
  });

  test("main wins when it is listening to the same source", async () => {
    const { controller, client } = await twoZoneSetup();
    const inner = controller as unknown as {
      lastZoneInput: Map<string, string>;
      lastNetusbInput: string;
      applyCommand(stateId: string, command: unknown): Promise<void>;
    };
    inner.lastZoneInput.set("main", "net_radio");
    inner.lastZoneInput.set("zone2", "net_radio");
    inner.lastNetusbInput = "net_radio";
    await inner.applyCommand("player.netPlayer.preset", { kind: "netusbPreset", value: 1 });
    expect(client.calls).toContainEqual({ method: "recallPreset", args: [1, "main"] });
  });

  test("falls back to main when nothing is listening to that source (every single-zone device)", async () => {
    const { controller, client } = await twoZoneSetup();
    const inner = controller as unknown as {
      lastZoneInput: Map<string, string>;
      lastNetusbInput: string;
      applyCommand(stateId: string, command: unknown): Promise<void>;
    };
    inner.lastZoneInput.set("main", "hdmi1");
    inner.lastNetusbInput = "";
    await inner.applyCommand("player.netPlayer.recallRecent", { kind: "netusbRecent", value: 2 });
    expect(client.calls).toContainEqual({ method: "recallRecentItem", args: [2, "main"] });
  });

  test("a tuner preset goes to the zone listening to the tuner", async () => {
    const { controller, client } = await twoZoneSetup();
    const inner = controller as unknown as {
      lastZoneInput: Map<string, string>;
      tunerFeatures: { presetType: string; bands: string[] };
      applyCommand(stateId: string, command: unknown): Promise<void>;
    };
    inner.lastZoneInput.set("main", "hdmi1");
    inner.lastZoneInput.set("zone2", "tuner");
    inner.tunerFeatures = { presetType: "common", bands: ["fm"] };
    await inner.applyCommand("tuner.preset", { kind: "tunerPreset", value: 4 });
    expect(client.calls).toContainEqual({ method: "recallTunerPreset", args: ["common", 4, "zone2"] });
  });
});

describe("YxcDeviceController signal/playlist/queue polling (declared surfaces only)", () => {
  const declaringFeatures = {
    response_code: 0,
    zone: [{ id: "main", func_list: ["power", "signal_info"], input_list: ["hdmi1"] }],
    netusb: { func_list: ["mc_playlist", "play_queue", "recent_info"] },
  };

  test("start fetches signal info, playlists and the queue when the device declares them", async () => {
    const s = setup(declaringFeatures, { response_code: 0, power: "on" });
    await s.controller.start();
    const methods = (s.client.calls as Array<{ method: string }>).map(c => c.method);
    expect(methods).toContain("getSignalInfo");
    expect(methods).toContain("getMcPlaylistName");
    expect(methods).toContain("getPlayQueue");
  });

  test("a device declaring none of them is never asked", async () => {
    const s = setup(
      { response_code: 0, zone: [{ id: "main", func_list: ["power"], input_list: ["hdmi1"] }], netusb: {} },
      { response_code: 0, power: "on" },
    );
    await s.controller.start();
    const methods = (s.client.calls as Array<{ method: string }>).map(c => c.method);
    expect(methods).not.toContain("getSignalInfo");
    expect(methods).not.toContain("getMcPlaylistName");
    expect(methods).not.toContain("getPlayQueue");
  });
});

describe("YxcDeviceController freshness guard (persisted memory)", () => {
  const features = {
    response_code: 0,
    zone: [{ id: "main", func_list: ["power"], input_list: ["hdmi1"] }],
  };

  test("a matching identity keeps the remembered capabilities — no second getFeatures", async () => {
    const memory = new ProbeMemory();
    const first = setup(features, { response_code: 0, power: "on" });
    (first.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await first.controller.start();
    const second = setup(features, { response_code: 0, power: "on" });
    (second.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await second.controller.start();
    const methods = (second.client.calls as Array<{ method: string }>).map(c => c.method);
    expect(methods).toContain("getDeviceInfo"); // the live identity proof
    expect(methods).not.toContain("getFeatures"); // capabilities come from the memory
  });

  test("a different identity voids the remembered capabilities and re-probes", async () => {
    const memory = new ProbeMemory();
    const first = setup(features, { response_code: 0, power: "on" });
    (first.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    (first.client as unknown as { deviceInfo: unknown }).deviceInfo = { model_name: "RX-A", system_version: 1.0 };
    await first.controller.start();
    const second = setup(features, { response_code: 0, power: "on" });
    (second.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    (second.client as unknown as { deviceInfo: unknown }).deviceInfo = { model_name: "RX-B", system_version: 2.0 };
    await second.controller.start();
    const methods = (second.client.calls as Array<{ method: string }>).map(c => c.method);
    // The swapped device must not inherit the old device's declared surface.
    expect(methods).toContain("getFeatures");
  });
});

describe("YxcDeviceController scene title writes (shared memory)", () => {
  test("a title write resolves to recallScene with the number from the device memory", async () => {
    const declaration =
      '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Scene><Scene_Sel_Item>' +
      "<Item_4><Param>Scene 4</Param><RW>W</RW><Title>NET Audio</Title></Item_4>" +
      "</Scene_Sel_Item></Scene></Main_Zone></YAMAHA_AV>";
    const memory = new ProbeMemory({ "xmlScenes:main": declaration });
    const s = setup(
      { response_code: 0, zone: [{ id: "main", func_list: ["power", "scene"], input_list: ["hdmi1"], scene_num: 8 }] },
      { response_code: 0, power: "on" },
    );
    (s.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await s.controller.start();
    (s.client.calls as Array<{ method: string }>).length = 0;
    s.controller.handleStateChange("living.scene.recall", false, "net audio");
    await new Promise(resolve => setImmediate(resolve));
    expect(s.client.calls as Array<{ method: string; args: unknown[] }>).toContainEqual({
      method: "recallScene",
      args: [4, "main"],
    });
    // An unknown title sends nothing.
    (s.client.calls as Array<{ method: string }>).length = 0;
    s.controller.handleStateChange("living.scene.recall", false, "Party");
    await new Promise(resolve => setImmediate(resolve));
    expect((s.client.calls as Array<{ method: string }>).some(c => c.method === "recallScene")).toBe(false);
  });
});

describe("YxcDeviceController player review fixes (2.0.0 pre-release audit)", () => {
  const netusbFeatures = { zone: [{ id: "main", func_list: ["power"] }], netusb: {} };

  test("in push mode a zone leaving its source is cleared by the ZONE status alone — no media sweep needed", async () => {
    const s = setup(netusbFeatures, { power: "on", input: "net_radio" }, {}, () => true);
    s.client.playInfo = { input: "net_radio", playback: "play", artist: "BBC" };
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "BBC" });
    // The zone switches to HDMI; netusb itself does not change, so no media push
    // would ever arrive — the zone status alone must clear the stale block.
    s.client.status = { power: "on", input: "hdmi1" };
    s.acks.length = 0;
    s.client.calls.length = 0;
    s.fire.keepalive?.(); // push active, first run → zone poll only, NO media sweep
    await flush();
    expect(s.client.calls.map(call => call.method)).not.toContain("getPlayInfo");
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "" });
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "" });
  });

  test("a zone joining a running source gets its block filled right away (targeted refetch)", async () => {
    const s = setup(netusbFeatures, { power: "on", input: "hdmi1" }, {}, () => true);
    s.client.playInfo = { input: "net_radio", playback: "play", artist: "BBC" };
    await s.controller.start();
    expect(s.acks).not.toContainEqual({ id: "living.player.artist", value: "BBC" });
    s.client.status = { power: "on", input: "net_radio" };
    s.acks.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "BBC" });
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "net_radio" });
  });

  test("scene.list exists on a MusicCast-only device: every declared slot, titles empty without a title source", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "scene"], scene_num: 4 }], netusb: {} };
    const s = setup(features, { power: "on", input: "hdmi1" });
    await s.controller.start();
    expect(s.objects).toContain("living.scene.list");
    const list = s.acks.find(ack => ack.id === "living.scene.list");
    expect(JSON.parse(String(list?.value))).toEqual([
      { num: 1, title: "" },
      { num: 2, title: "" },
      { num: 3, title: "" },
      { num: 4, title: "" },
    ]);
  });
});

describe("YxcDeviceController player.source seeding", () => {
  test("a zone starting on a non-media input gets the WHOLE block cleared, not valueless states", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], netusb: {} }, { power: "on", input: "hdmi1" });
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "" });
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "" });
    expect(s.acks).toContainEqual({ id: "living.player.playback", value: 1 });
    expect(s.acks).toContainEqual({ id: "living.player.elapsedTime", value: 0 });
  });

  test("a zone starting ON a media source keeps the routed source value (no empty overwrite)", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], netusb: {} }, { power: "on", input: "net_radio" });
    s.client.playInfo = { input: "net_radio", playback: "play" };
    await s.controller.start();
    const sources = s.acks.filter(ack => ack.id === "living.player.source").map(ack => ack.value);
    expect(sources).toEqual(["net_radio"]);
  });
});

describe("YxcDeviceController seed edge cases (2.0.1 hardening)", () => {
  test("the DAB scan counters start at zero on a DAB-capable tuner — and only there", async () => {
    // The RX-V6A getFeatures shape: bands come from tuner.func_list (fm/am/dab).
    const dabFeatures = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm", "rds", "dab"], preset: { type: "separate", num: 40 } },
    };
    const s = setup(dabFeatures, { power: "on", input: "hdmi1" });
    await s.controller.start();
    // The device delivers the two counters only after a station scan — until then the
    // documented start state is zero, never a valueless datapoint.
    expect(s.acks).toContainEqual({ id: "living.tuner.dab.totalStations", value: 0 });
    expect(s.acks).toContainEqual({ id: "living.tuner.dab.scanProgress", value: 0 });
    // A tuner without DAB gets neither counter.
    const fmOnly = setup(
      {
        zone: [{ id: "main", func_list: ["power"] }],
        tuner: { func_list: ["fm", "rds"], preset: { type: "common", num: 40 } },
      },
      { power: "on", input: "hdmi1" },
    );
    await fmOnly.controller.start();
    expect(fmOnly.acks.some(ack => ack.id.startsWith("living.tuner.dab."))).toBe(false);
  });

  test("a cd-only device gets the cleared player block too (no netusb required)", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], cd: {} }, { power: "on", input: "hdmi1" });
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "" });
    expect(s.acks).toContainEqual({ id: "living.player.playback", value: 1 });
  });
});

describe("YxcDeviceController test-audit hardening (2.0.1)", () => {
  const twoZoneNetusb = {
    zone: [
      { id: "main", func_list: ["power"] },
      { id: "zone2", func_list: ["power"] },
    ],
    netusb: {},
  };

  test("multi-zone routing: the LISTENING zone's block fills under its multiroom prefix, main stays untouched", async () => {
    const s = setup(twoZoneNetusb, { power: "on", input: "hdmi1" });
    s.client.statusByZone = {
      main: { power: "on", input: "hdmi1" },
      zone2: { power: "on", input: "net_radio" },
    };
    s.client.playInfo = { input: "net_radio", playback: "play", artist: "BBC" };
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.player.artist", value: "BBC" });
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.player.source", value: "net_radio" });
    expect(s.acks).not.toContainEqual({ id: "living.player.artist", value: "BBC" });
    // Main (on HDMI) got its cleared resting shape instead.
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "" });
  });

  test("multi-zone clear-on-switch: zone 2 leaving the source clears ITS block via the zone status alone", async () => {
    const s = setup(twoZoneNetusb, { power: "on", input: "hdmi1" }, {}, () => true);
    s.client.statusByZone = {
      main: { power: "on", input: "hdmi1" },
      zone2: { power: "on", input: "net_radio" },
    };
    s.client.playInfo = { input: "net_radio", playback: "play", artist: "BBC" };
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.player.artist", value: "BBC" });
    s.client.statusByZone = {
      main: { power: "on", input: "hdmi1" },
      zone2: { power: "on", input: "audio1" },
    };
    s.acks.length = 0;
    s.fire.keepalive?.(); // push mode, first run → zone polls only
    await flush();
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.player.artist", value: "" });
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.player.source", value: "" });
  });

  test("a band write is remembered BEFORE the round-trip — a frequency in the same turn uses the new band", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], tuner: { func_list: ["am", "fm"] } };
    const s = setup(features, { power: "on", input: "tuner" });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.tuner.band", false, "am");
    s.controller.handleStateChange("living.tuner.frequency", false, 1440);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setBand", args: ["am"] });
    expect(s.client.calls).toContainEqual({ method: "setFreq", args: ["am", 1440] });
  });

  test("two equalizer bands written back-to-back keep BOTH values (cache before round-trip)", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    const status = { power: "on", input: "hdmi1", equalizer: { mode: "manual", low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.sound.equalizer.low", false, 7);
    s.controller.handleStateChange("living.sound.equalizer.mid", false, -4);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [7, 2, 3, "main"] });
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [7, -4, 3, "main"] });
  });

  test("scene.list merges titles from the shared device memory where another transport reported them", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "scene"], scene_num: 3 }], netusb: {} };
    const s = setup(features, { power: "on", input: "hdmi1" });
    const memory = new ProbeMemory();
    memory.set(
      "xmlScenes:main",
      `<YAMAHA_AV rsp="GET" RC="0"><Scene><Scene_Sel_Item>` +
        `<Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie</Title></Item_1>` +
        `<Item_2><Param>Scene 2</Param><RW>W</RW><Title>Radio</Title></Item_2>` +
        `</Scene_Sel_Item></Scene></YAMAHA_AV>`,
    );
    (s.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await s.controller.start();
    const list = s.acks.find(ack => ack.id === "living.scene.list");
    expect(JSON.parse(String(list?.value))).toEqual([
      { num: 1, title: "Movie" },
      { num: 2, title: "Radio" },
      { num: 3, title: "" },
    ]);
  });
});

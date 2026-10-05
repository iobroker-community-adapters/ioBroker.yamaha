import { YxcRefusalError, YxcTransportError } from "./http-client";
import { HttpStatusError } from "../util";
import cdNt670d from "./__fixtures__/cd_nt670d.json";
import wx30 from "./__fixtures__/WX30_317_208.json";
import { nameTextLabels, YxcDeviceController, zoneNameFrom } from "./device-controller";
import type { YxcClientLike } from "./device-controller";
import type { ObjectDef } from "../catalog/types";
import wx10 from "./__fixtures__/WX10_216_208.json";
import rxV481 from "./__fixtures__/RX_V481_285_208.json";
import rxA2070 from "./__fixtures__/RX_A2070_285_208.json";
import ysp from "./__fixtures__/status/YSP1600_main.json";
import { CommandGate } from "../lifecycle/command-gate";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";
import { PushLiveness } from "./push-liveness";

/** A real command gate for the controller under test (pacing has its own suite). */
const testGate = (): CommandGate =>
  new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  });

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A command gate whose waits end only when the test says so — the push-event window, say. */
function manualGate(): { gate: CommandGate; elapse: () => Promise<void> } {
  const pending: Array<() => void> = [];
  const gate = new CommandGate({
    minSpacingMs: 0,
    timers: {
      schedule: handler => pending.push(handler),
      cancel: () => {},
    },
  });
  return {
    gate,
    elapse: async () => {
      await flush();
      for (const handler of pending.splice(0)) {
        handler();
      }
      await flush();
    },
  };
}
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
  /** The netusb getPlayInfo answer (cd has a fixed canned answer). */
  playInfo: unknown;
  /** The tuner getPlayInfo answer (default: FM 100.9 MHz with RDS text). */
  tunerPlayInfo: unknown;
  /** Per-zone getStatus answers; falls back to `status` for zones not listed. */
  statusByZone: Record<string, unknown> | undefined;
  distRole: string;
  /** The whole getDistributionInfo answer, overriding the one derived from `distRole`. */
  distInfo: unknown;
  /** Make the zone status / name lookup fail, as an unreachable device would. */
  failStatus: boolean;
  /** Make the zone status answer with this `response_code` — the device is there and says no. */
  refuseStatus: number | undefined;
  failWrites: Error | undefined;
  failNameText: boolean;
  /** The getFuncStatus answer (default: an empty success — no device-wide settings). */
  funcStatus: unknown;
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
    listInfo: { response_code: 0, menu_layer: 0, menu_name: "", max_line: 0, list_info: [] },
    presetInfo: { response_code: 0, preset_info: [] },
    recentInfo: { response_code: 0, recent_info: [] },
    tunerPresetInfo: { response_code: 0, preset_info: [] },
    clockSettings: { response_code: 0 },
    playInfo: {},
    tunerPlayInfo: { band: "fm", fm: { freq: 100900 }, rds: { radio_text_a: "Hit" } },
    statusByZone: undefined,
    distRole: "server",
    distInfo: undefined,
    failStatus: false,
    refuseStatus: undefined as number | undefined,
    failNameText: false,
    /** When set, every command that is not a read answer rejects with it (a write that never reaches the device). */
    failWrites: undefined as Error | undefined,
    funcStatus: {},
  };
  // The answers that are more than "an empty success".
  const replies: Record<string, (args: unknown[]) => unknown> = {
    getFeatures: () => state.features,
    getFuncStatus: () => state.funcStatus,
    getStatus: ([zone]) => {
      if (state.failStatus) {
        throw new Error("device offline");
      }
      if (typeof state.refuseStatus === "number") {
        throw new YxcRefusalError(`/${String(zone)}/getStatus`, state.refuseStatus);
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
        return state.tunerPlayInfo;
      }
      if (source === "cd") {
        return { playback: "play", track: "Track 1" };
      }
      return state.playInfo;
    },
    // A server carries its group and roster, a client its group id, "none" neither — the shape
    // YXC Advanced §5.1/§9.2 describe (the role word alone is not what decides the role, C7).
    getDistributionInfo: () =>
      state.distInfo ?? {
        role: state.distRole,
        group_id: state.distRole === "none" ? "" : "9A237BF5AB80ED3C7251DFF49825CA42",
        group_name: "Group 1",
        server_zone: "main",
        client_list: state.distRole === "server" ? ["1.2.3.5"] : [],
      },
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
        if (target.failWrites instanceof Error && !(prop in replies)) {
          return Promise.reject(target.failWrites);
        }
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
  extra: {
    pushLiveness?: PushLiveness;
    gate?: CommandGate;
    host?: string;
    reportDeclaredAbsent?: (ids: string[]) => void;
    aliasZone?: (from: string, to: string) => void;
    probeMemory?: ProbeMemory;
  } = {},
): {
  /** Every info line the controller logged. */
  infos: string[];
  /** Every debug line the controller logged. */
  debugs: string[];
  /**
   * Make value writes throw, to prove what a failing tree write may and may not cost. `only`
   * narrows it to one state id, so a test can break exactly the zone-status path and leave the
   * rest of the start-up intact.
   */
  breakAcks: { on: boolean; only?: string };
  /** Every warn line the controller logged. */
  warnings: string[];
  controller: YxcDeviceController;
  client: FakeClient;
  objects: string[];
  defs: Map<string, ObjectDef>;
  acks: Array<{ id: string; value: unknown }>;
  /** Object writes and value writes on ONE timeline, so a test can assert their ORDER. */
  trace: Array<{ kind: "object" | "value"; id: string }>;
  /** Set `fn` to hold one id's object write open, proving what waits for it to FINISH. */
  hold: { fn?: (id: string) => Promise<void> | undefined };
  fire: { push?: (event: unknown) => void; keepalive?: () => void; pushDeviceId?: string };
  names: string[];
  cancelled: () => boolean;
  unregistered: () => boolean;
} {
  const client = makeFakeClient(features, status);
  const objects: string[] = [];
  const defs = new Map<string, ObjectDef>();
  const acks: Array<{ id: string; value: unknown }> = [];
  const trace: Array<{ kind: "object" | "value"; id: string }> = [];
  /** Set by a test to hold one upsert open; see `hold` on the returned setup. */
  const hold: { fn?: (id: string) => Promise<void> | undefined } = {};
  const names: string[] = [];
  const fire: { push?: (event: unknown) => void; keepalive?: () => void; pushDeviceId?: string } = {};
  const breakAcks: { on: boolean; only?: string } = { on: false };
  const warnings: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  let cancelled = false;
  let unregistered = false;
  const controller = new YxcDeviceController("living", {
    client,
    clientFor: ip => linkTargets[ip],
    partnerIps: () => Object.keys(linkTargets),
    pushActive,
    gate: testGate(),
    probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
    pushLiveness: new PushLiveness(),
    ...extra,
    registerPush: (onPush, deviceId) => {
      fire.push = onPush;
      fire.pushDeviceId = deviceId;
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
    upsertObject: (id, def) => {
      objects.push(id);
      defs.set(id, def);
      trace.push({ kind: "object", id });
      // A test can hold one id's write open, to prove what waits for it to FINISH rather than
      // for it to be called (an async function runs synchronously up to its first await).
      return hold.fn?.(id) ?? Promise.resolve();
    },
    setStateAck: (id, value) => {
      if (breakAcks.on && (breakAcks.only === undefined || id.endsWith(breakAcks.only))) {
        throw new Error("states db unreachable");
      }
      acks.push({ id, value });
      trace.push({ kind: "value", id });
    },
    reportDeviceName: name => {
      names.push(name);
    },
    log: {
      ...silentLog,
      debug: (line: string) => {
        debugs.push(line);
      },
      info: (line: string) => {
        infos.push(line);
      },
      warn: (line: string) => {
        warnings.push(line);
      },
    },
  });
  return {
    infos,
    debugs,
    breakAcks,
    warnings,
    hold,
    controller,
    client,
    objects,
    defs,
    acks,
    trace,
    names,
    fire,
    cancelled: () => cancelled,
    unregistered: () => unregistered,
  };
}

describe("YxcDeviceController", () => {
  // The update from 2.12.0 left a zone's maximum volume behind where the zone has no volume: the
  // controller now says what its declaration proves absent, so the adapter removes it at once.
  test("start() reports what getFeatures proves absent, and builds none of it", async () => {
    const absent: string[] = [];
    const s = setup(wx10, ysp, {}, undefined, { reportDeclaredAbsent: ids => void absent.push(...ids) });
    await s.controller.start();
    expect(absent.length).toBeGreaterThan(0);
    expect(absent.filter(id => s.objects.includes(`living.${id}`))).toEqual([]);
  });

  test("builds the object tree from getFeatures", async () => {
    const s = setup(wx10, ysp);
    expect(await s.controller.start()).toBe(true);
    expect(s.objects).toEqual(expect.arrayContaining(["living.power", "living.volume", "living.mute"]));
  });

  // An event from another address (Docker, a second interface) is routed by the device id it
  // carries (Rev 1.10 §11.3) — the controller registers the id getDeviceInfo reported, and only a
  // real one (audit 2026-09-24, C2).
  test("registers for events under the device id getDeviceInfo reports — never an empty one", async () => {
    const s = setup(wx10, ysp);
    s.client.deviceInfo = { model_name: "WX-010", device_id: "00A0DED4F504" };
    await s.controller.start();
    expect(s.fire.pushDeviceId).toBe("00A0DED4F504");
    const empty = setup(wx10, ysp);
    empty.client.deviceInfo = { model_name: "WX-010", device_id: "" };
    await empty.controller.start();
    expect(empty.fire.pushDeviceId).toBeUndefined();
  });

  test("reports the model from getDeviceInfo into the adapter-created info.model", async () => {
    const s = setup(wx10, ysp);
    s.client.deviceInfo = { model_name: "WX-010" };
    await s.controller.start();
    // The object itself is created once by the adapter (ensureDeviceHeader) for every
    // device, offline ones included — the transport only fills in the value.
    expect(s.acks).toContainEqual({ id: "living.info.model", value: "WX-010" });
  });

  // An answer without a model is no identity (YNCA and XML guard the same way): until 3.1.3 it threw away what
  // the receiver had declared (getFeatures) and every remembered setting with it.
  test("a device info without a model keeps what the receiver declared", async () => {
    const probeMemory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
    const first = setup(wx10, ysp, {}, undefined, { probeMemory });
    first.client.deviceInfo = { model_name: "WX-010", system_version: 2.41 };
    await first.controller.start();
    expect(first.controller.firmware()).toBe("2.41");
    expect(probeMemory.remembered("features")).toBeDefined();
    const again = setup(wx10, ysp, {}, undefined, { probeMemory });
    again.client.deviceInfo = { system_version: 2.41 };
    await again.controller.start();
    expect(probeMemory.remembered("features")).toBeDefined();
    expect(probeMemory.remembered("yxcIdentity")).toBe("WX-010|2.41");
  });

  test("a device-wide setting the receiver delivered before stays when getFuncStatus fails once", async () => {
    const probeMemory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
    const first = setup(wx10, ysp, {}, undefined, { probeMemory });
    first.client.funcStatus = { auto_power_standby: true };
    await first.controller.start();
    expect(first.objects).toContain("living.advanced.autoPowerStandby");
    const again = setup(wx10, ysp, {}, undefined, { probeMemory });
    (again.client as unknown as { getFuncStatus: () => Promise<never> }).getFuncStatus = () =>
      Promise.reject(new Error("timeout"));
    await again.controller.start();
    expect(again.objects).toContain("living.advanced.autoPowerStandby");
  });

  test("a write says what the device made of it — taken, refused, or not sendable", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    await expect(Promise.resolve(s.controller.handleWrite("power", true))).resolves.toBe("sent");
    s.client.failWrites = new YxcRefusalError("/main/setPower", 3);
    await expect(Promise.resolve(s.controller.handleWrite("power", false))).resolves.toBe("refused");
    s.client.failWrites = new YxcTransportError("/main/setPower", new Error("timeout"));
    await expect(Promise.resolve(s.controller.handleWrite("power", true))).resolves.toBe("unavailable");
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

  test("the status is read BEFORE the objects, so a reported value joins its declared list (RX-A2070 tone mode)", async () => {
    const features = {
      response_code: 0,
      system: {},
      zone: [
        { id: "main", func_list: ["power", "tone_control"], input_list: ["hdmi1"], tone_control_mode_list: ["manual"] },
      ],
    };
    const s = setup(features, {
      response_code: 0,
      power: "on",
      input: "av1",
      tone_control: { mode: "auto", bass: 0, treble: 0 },
    });
    await s.controller.start();
    expect(s.defs.get("living.sound.toneMode")?.common.states).toEqual({ manual: "manual", auto: "auto" });
    // The classic names where the app gives none — never the bare id.
    expect(s.defs.get("living.input")?.common.states).toEqual({ hdmi1: "HDMI1", av1: "AV1" });
    // Still one status request per zone at start — the seed reuses the same answer.
    expect(s.client.calls.filter(call => call.method === "getStatus")).toHaveLength(1);
    expect(s.acks).toContainEqual({ id: "living.sound.toneMode", value: "auto" });
  });

  test("a declared menu word outside the shared vocabulary reaches the device; an undeclared one is dropped", async () => {
    const features = {
      response_code: 0,
      system: {},
      zone: [{ id: "main", func_list: ["power", "menu"], input_list: [], menu_list: ["on_screen", "menu", "red"] }],
    };
    const s = setup(features, { response_code: 0, power: "on" });
    await s.controller.start();
    expect(Object.keys(s.defs.get("living.remote.menu")?.common.states ?? {})).toEqual(["on_screen", "menu", "red"]);
    s.client.calls.length = 0;
    void s.controller.handleWrite("remote.menu", "red");
    await flush();
    expect(s.client.calls).toContainEqual({ method: "controlMenu", args: ["red", "main"] });
    s.client.calls.length = 0;
    void s.controller.handleWrite("remote.menu", "purple");
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("a user write (ack false) becomes the matching client call", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("power", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "power", args: [true, "main"] });
  });

  test("a push refreshes the named zone via getStatus", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    s.acks.length = 0;
    s.fire.push?.({ main: { power: "on" } });
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["main"] });
  });

  // A knob turned twenty detents sends twenty events; one running refresh plus one after it answer all
  // of them (audit 2026-09-29, C45).
  test("a burst of events for one zone costs one running refresh and one after it", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    for (let volume = 20; volume < 40; volume++) {
      s.fire.push?.({ main: { volume } });
    }
    await flush();
    expect(s.client.calls.filter(c => c.method === "getStatus")).toHaveLength(2);
    // Later events after the burst settled are refreshed again.
    s.fire.push?.({ main: { volume: 41 } });
    await flush();
    expect(s.client.calls.filter(c => c.method === "getStatus")).toHaveLength(3);
  });

  // The push handler calls refreshZone WITHOUT awaiting it, so a throw on the way into the tree
  // has no receiver at all — and js-controller answers an unhandled rejection by stopping the
  // instance. A failing state write must therefore cost a log line and nothing else.
  test("a failing tree write during a push is reported, not thrown at nobody", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      // A CHANGED answer, or nothing is written at all: unchanged values never reach the tree
      // (the 2.10.0 write guard), so an unchanged status could not provoke the failure.
      s.client.statusByZone = { main: { power: "standby", volume: 17 } };
      s.breakAcks.on = true;
      s.fire.push?.({ main: { power: "standby" } });
      await flush();
      await flush();
    } finally {
      process.off("unhandledRejection", onRejection);
      s.breakAcks.on = false;
    }
    expect(rejections).toEqual([]);
    expect(s.warnings.some(line => line.includes("could not apply the main status"))).toBe(true);
  });

  // The return value answers "did the DEVICE answer", and it did — the zone status came back.
  // `start()` reads exactly that to decide whether this transport is alive, so counting a
  // failed tree write as "no zone answered" would drop a perfectly reachable receiver on a
  // database hiccup (the 1.5.0 liveness rule turned on its head).
  test("a failing tree write does not make the keepalive report the device gone", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    const drops: unknown[] = [];
    s.controller.onDrop(reason => drops.push(reason));
    s.breakAcks.on = true;
    s.breakAcks.only = "power";
    // A CHANGED value every poll, or the write guard skips it and nothing can fail — and
    // enough polls in a row to pass MAX_POLL_FAILURES, so a wrong verdict really would drop.
    for (const power of ["standby", "on", "standby", "on"]) {
      s.client.statusByZone = { main: { power } };
      s.fire.keepalive?.();
      await flush();
    }
    s.breakAcks.on = false;
    expect(s.warnings.some(line => line.includes("could not apply the main status"))).toBe(true);
    expect(drops, "a database hiccup disconnected a reachable receiver").toEqual([]);
  });

  // The RX-V481 declares BOTH display scales; `actual_volume.value` arrives in the one named by `mode`. A receiver
  // that was read in keeps its datapoints (krobi 2026-10-02): switching its display does not rebuild `volume` —
  // the value is converted from the raw step count onto the scale the datapoint was read in on.
  test("a change of display scale keeps the datapoint and converts the value from the raw step count", async () => {
    const s = setup(rxV481, { power: "on", volume: 60, actual_volume: { mode: "db", value: -50.5 } });
    expect(await s.controller.start()).toBe(true);
    expect(s.defs.get("living.volume")?.common.unit).toBe("dB");

    s.trace.length = 0;
    s.client.status = { power: "on", volume: 60, actual_volume: { mode: "numeric", value: 30 } };
    s.fire.push?.({ main: { volume: 60 } });
    await flush();

    expect(s.trace.filter(e => e.kind === "object" && e.id === "living.volume")).toEqual([]);
    expect(s.defs.get("living.volume")?.common.unit).toBe("dB");
    expect(s.acks.filter(a => a.id === "living.volume").at(-1)?.value).toBe(-50.5);
  });

  test("on the other scale without a raw step count, no volume value is written", async () => {
    const s = setup(rxV481, { power: "on", volume: 60, actual_volume: { mode: "db", value: -50.5 } });
    expect(await s.controller.start()).toBe(true);
    s.trace.length = 0;
    s.client.status = { power: "on", actual_volume: { mode: "numeric", value: 30 } };
    s.fire.push?.({ main: { volume: 60 } });
    await flush();
    expect(s.trace.filter(e => e.kind === "value" && e.id === "living.volume")).toEqual([]);
  });

  test("the scale a zone was read in on is remembered: a restart on the other scale keeps the datapoint", async () => {
    const probeMemory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
    const first = setup(
      rxV481,
      { power: "on", volume: 60, actual_volume: { mode: "db", value: -50.5 } },
      {},
      undefined,
      {
        probeMemory,
      },
    );
    await first.controller.start();
    const again = setup(
      rxV481,
      { power: "on", volume: 60, actual_volume: { mode: "numeric", value: 30 } },
      {},
      undefined,
      { probeMemory },
    );
    await again.controller.start();
    expect(again.defs.get("living.volume")?.common.unit).toBe("dB");
    expect(again.acks.filter(a => a.id === "living.volume").at(-1)?.value).toBe(-50.5);
  });

  test("a status without a scale change reshapes nothing", async () => {
    const s = setup(rxV481, { power: "on", actual_volume: { mode: "db", value: -47.5 } });
    await s.controller.start();

    s.trace.length = 0;
    s.client.status = { power: "on", actual_volume: { mode: "db", value: -40 } };
    s.fire.push?.({ main: { volume: 40 } });
    await flush();

    expect(s.trace.filter(e => e.kind === "object" && e.id === "living.volume")).toEqual([]);
  });

  // The datapoint carries what the receiver DISPLAYS, `setVolume` takes the raw step count. The
  // relation comes from the zone's two DECLARED steps (0.5 displayed per 1 raw), anchored at the
  // declared floor — exact on all ten raw/displayed pairs in the bundled captures. On the numeric
  // scale the floor is 0, which is why a plain ratio happened to fit here and nowhere else.
  test("a volume write is converted with the step the device declares", async () => {
    const s = setup(rxV481, { power: "on", volume: 60, actual_volume: { mode: "numeric", value: 30 } });
    expect(await s.controller.start()).toBe(true);
    s.client.calls.length = 0;

    void s.controller.handleWrite("volume", 41.5);
    await flush();

    expect(s.client.calls).toContainEqual({ method: "setVolumeTo", args: [83, "main"] });
  });

  // The scale is DECLARED, so a write never has to wait for the device to report a raw/displayed
  // pair first: a status carrying only the displayed value converts just as exactly. The earlier
  // build measured the pair instead and had to refuse until one arrived.
  test("a volume write works before the device has reported a raw step count", async () => {
    const s = setup(rxV481, { power: "on", actual_volume: { mode: "numeric", value: 30 } });
    await s.controller.start();
    s.client.calls.length = 0;

    void s.controller.handleWrite("volume", 41.5);
    await flush();

    expect(s.client.calls).toContainEqual({ method: "setVolumeTo", args: [83, "main"] });
  });

  // The decibel scale does NOT start at zero, so the relation between the displayed value and the
  // raw step count is affine, never a plain ratio. The RX-A2070 declares raw 0…161 in steps of 1
  // against -80.5…16.5 dB in steps of 0.5, and reports raw 66 as -47.5 dB — that is
  // `-80.5 + raw · 0.5`, exact on every raw/displayed pair in the bundled captures (6 of 6, four
  // models). A ratio learned from that one reading (-47.5 / 66) reproduces the reading it came
  // from and nothing else: it would send raw 56 for -40 dB, and raw 0 — silence — for 0 dB.
  test("a decibel volume write follows the device's declared step, not the ratio of one reading", async () => {
    const s = setup(rxA2070, { power: "on", volume: 66, actual_volume: { mode: "db", value: -47.5 } });
    expect(await s.controller.start()).toBe(true);
    s.client.calls.length = 0;

    void s.controller.handleWrite("volume", -40);
    await flush();

    expect(s.client.calls).toContainEqual({ method: "setVolumeTo", args: [81, "main"] });
  });

  // The top of the declared scale is sent as the scale says, even though the separately declared
  // raw range stops earlier — the two declarations disagree and no capture settles which is real,
  // so the value the datapoint allows travels to the device and the device answers for itself.
  test("the top of the declared scale is sent as that scale says", async () => {
    const s = setup(rxA2070, { power: "on", volume: 66, actual_volume: { mode: "db", value: -47.5 } });
    await s.controller.start();
    s.client.calls.length = 0;

    void s.controller.handleWrite("volume", 16.5);
    await flush();

    expect(s.client.calls).toContainEqual({ method: "setVolumeTo", args: [194, "main"] });
  });

  // The scale is exact, so a computed value normally EQUALS the reported one — which is why this
  // needs a device contradicting its own declaration to show at all. The adapter already meets
  // that (the RX-A2070 answers `auto` for a tone mode it declared as `manual`-only): where the
  // device says a number, that number is the datapoint, and no derivation overrules it.
  test("a reported display value wins over the one the declaration would compute", async () => {
    const s = setup(rxA2070, { power: "on", volume: 66, actual_volume: { mode: "db", value: -30 } });
    expect(await s.controller.start()).toBe(true);

    // raw 66 reads as -47.5 dB on the declared scale; the device says -30.
    expect(s.acks).toContainEqual({ id: "living.volume", value: -30 });
    expect(s.acks).not.toContainEqual({ id: "living.volume", value: -47.5 });
  });

  // The RX-A2070 declares `actual_volume_db` for EVERY zone but answers a status carrying
  // `actual_volume` for main only. The zone datapoint is therefore bounded -80.5…16.5 dB while the
  // raw step count is all that arrives — 66 against a maximum of 16.5 is exactly the js-controller
  // warning on every poll that this rebuild set out to end. The zone's own declared step says what
  // 66 means on the scale it declares, so the datapoint carries that.
  test("a zone that declares a scale but reports no actual_volume still carries that scale", async () => {
    const s = setup(rxA2070, { power: "on", volume: 66, actual_volume: { mode: "db", value: -47.5 } });
    s.client.statusByZone = { zone2: { power: "on", volume: 66 } };
    expect(await s.controller.start()).toBe(true);

    expect(s.defs.get("living.multiroom.zone2.volume")?.common.max).toBe(16.5);
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.volume", value: -47.5 });
  });

  // A speaker reports no display scale at all — its datapoint already holds the device's own step
  // count, so the value goes out untouched, exactly as before this rebuild.
  test("a device without a display scale writes its raw value straight through", async () => {
    // Switched on: in standby the YSP reports volume and mute not operable (disable_flags 3, C27).
    const s = setup(wx10, { ...(ysp as Record<string, unknown>), power: "on", disable_flags: 0 });
    await s.controller.start();
    s.client.calls.length = 0;

    void s.controller.handleWrite("volume", 42);
    await flush();

    expect(s.client.calls).toContainEqual({ method: "setVolumeTo", args: [42, "main"] });
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
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "CD" });
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
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "NET RADIO" });
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
    void s.controller.handleWrite("player.play", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setPlayback", args: ["cd", "play"] });
    // Same button while the zone plays no media source: no transport call goes out.
    const idle = setup(features, { power: "on", input: "hdmi1" });
    await idle.controller.start();
    idle.client.calls.length = 0;
    void idle.controller.handleWrite("player.play", true);
    await flush();
    expect(idle.client.calls).toEqual([]);
  });

  test("an equalizer band write sends setEqualizer with the other two bands from the last status", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    const status = { power: "on", equalizer: { mode: "manual", low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("sound.equalizer.low", 7);
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
    void s.controller.handleWrite("multiroom.zone2.sound.equalizer.mid", -4);
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
    void s.controller.handleWrite("multiroom.group.leave", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "stopDistribution", args: [] });
  });

  test("leaving a group as a client clears its client info", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    s.client.distRole = "client";
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.group.leave", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setClientInfo", args: [{ group_id: "" }] });
  });

  // YXC Advanced §9.1.2: the client gets the group, the server's address and the MusicCast Link input,
  // the server the roster; the first group in the network starts with num 0 (audit 2026-09-24, C7).
  test("linking a client sends it the group, adds it on the server, and starts distribution", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const clientDevice = makeFakeClient({ distribution: { version: 2 } }, {});
    clientDevice.distRole = "none";
    const s = setup(features, ysp, { "1.2.3.9": clientDevice }, undefined, { host: "1.2.3.4" });
    s.client.distRole = "none";
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    const join = clientDevice.calls.find(c => c.method === "setClientInfo");
    const add = s.client.calls.find(c => c.method === "setServerInfo");
    expect(join?.args[0]).toMatchObject({ zone: ["main"], server_ip_address: "1.2.3.4" });
    expect(clientDevice.calls).toContainEqual({ method: "setInput", args: ["mc_link", "main"] });
    expect(add?.args[0]).toMatchObject({ type: "add", client_list: ["1.2.3.9"], zone: "main" });
    expect(s.client.calls).toContainEqual({ method: "startDistribution", args: [0] });
    // The client and server carry the same random 32-digit group id (§9.1.2).
    const clientGroup = (join?.args[0] as { group_id: string }).group_id;
    expect(clientGroup).toMatch(/^[0-9A-F]{32}$/);
    expect(clientGroup).toBe((add?.args[0] as { group_id: string }).group_id);
  });

  // YXC Basic Rev 1.10 §4.2: a Zone B is served as zone2 with `zone_b: true` — its folder is renamed for
  // the tree, and Zone A and B join a group together (Advanced §9.1.7-2; audit 2026-09-29, C29).
  test("a Zone B receiver names its zone2 folder Zone B, and joins a group with both zones", async () => {
    const aliases: string[] = [];
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const zoneB = {
      zone: [
        { id: "main", func_list: ["power"] },
        { id: "zone2", func_list: ["power", "volume"], zone_b: true },
      ],
      distribution: { version: 2 },
    };
    const own = setup(zoneB, { power: "on" }, {}, undefined, {
      aliasZone: (from, to) => aliases.push(`${from}>${to}`),
    });
    await own.controller.start();
    expect(aliases).toEqual(["zone2>zoneB"]);

    const clientDevice = makeFakeClient(zoneB, {});
    clientDevice.distRole = "none";
    const s = setup(features, ysp, { "1.2.3.9": clientDevice }, undefined, { host: "1.2.3.4" });
    s.client.distRole = "none";
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    expect(clientDevice.calls.find(c => c.method === "setClientInfo")?.args[0]).toMatchObject({
      zone: ["main", "zone2"],
    });
    expect(clientDevice.calls.filter(c => c.method === "setInput").map(c => c.args)).toEqual([
      ["mc_link", "main"],
      ["mc_link", "zone2"],
    ]);
  });

  test("the distribution number counts the clients already distributed in the network", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    // Another configured device already serves a group of two (§9.1.5: the second group sends 2).
    const otherServer = makeFakeClient({}, {});
    otherServer.distInfo = {
      role: "server",
      group_id: "7B335AE4C12345677251DAA466669B40",
      client_list: [
        { ip_address: "1.2.3.20", data_type: "base" },
        { ip_address: "1.2.3.21", data_type: "base" },
      ],
    };
    const joining = makeFakeClient({}, {});
    joining.distRole = "none";
    const s = setup(features, ysp, { "1.2.3.9": joining, "1.2.3.10": otherServer });
    s.client.distRole = "none";
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    expect(s.client.calls).toContainEqual({ method: "startDistribution", args: [2] });
  });

  test("a device already serving a group extends it with its own group id", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const joining = makeFakeClient({}, {});
    joining.distRole = "none";
    const s = setup(features, ysp, { "1.2.3.9": joining });
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    expect(s.client.calls.find(c => c.method === "setServerInfo")?.args[0]).toMatchObject({
      group_id: "9A237BF5AB80ED3C7251DFF49825CA42",
    });
    // Its own client counts: a second client joining a group of one sends 1 (§9.1.4).
    expect(s.client.calls).toContainEqual({ method: "startDistribution", args: [1] });
  });

  test("an incompatible client is not linked — the device says why", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      distribution: { version: 3.1, compatible_client: [3] },
    };
    const joining = makeFakeClient({ distribution: { version: 2.05 } }, {});
    const s = setup(features, ysp, { "1.2.3.9": joining });
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    expect(joining.calls.filter(c => c.method === "setClientInfo")).toEqual([]);
    expect(s.warnings.some(line => line.includes("MusicCast Link version 2.05"))).toBe(true);
  });

  test("a new group is read back until it reports working (up to three minutes, §9.1.8-3)", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const { gate, elapse } = manualGate();
    const joining = makeFakeClient({}, {});
    joining.distRole = "none";
    const s = setup(features, ysp, { "1.2.3.9": joining }, undefined, { gate });
    s.client.distRole = "none";
    await s.controller.start();
    s.client.distInfo = {
      role: "server",
      group_id: "9A237BF5AB80ED3C7251DFF49825CA42",
      client_list: ["1.2.3.9"],
      status: " building ",
    };
    s.acks.length = 0;
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    expect(s.acks).toContainEqual({ id: "living.multiroom.group.status", value: "building" });
    s.client.distInfo = { ...(s.client.distInfo as Record<string, unknown>), status: " working " };
    await elapse();
    expect(s.acks).toContainEqual({ id: "living.multiroom.group.status", value: "working" });
    const reads = s.client.calls.filter(c => c.method === "getDistributionInfo").length;
    await elapse();
    expect(s.client.calls.filter(c => c.method === "getDistributionInfo").length).toBe(reads);
  });

  // §9.1.3: a leaving client is taken off its server's roster, and the server re-distributes.
  test("a client leaving is removed from its server's roster, which restarts the distribution", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const master = makeFakeClient({}, {});
    master.distInfo = {
      role: "server",
      group_id: "9A237BF5AB80ED3C7251DFF49825CA42",
      server_zone: "main",
      client_list: ["10.0.0.5", "10.0.0.7"],
    };
    const s = setup(features, ysp, { "10.0.0.9": master }, undefined, { host: "10.0.0.5" });
    s.client.distRole = "client";
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.leave", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setClientInfo", args: [{ group_id: "" }] });
    expect(master.calls).toContainEqual({
      method: "setServerInfo",
      args: [{ group_id: "9A237BF5AB80ED3C7251DFF49825CA42", zone: "main", type: "remove", client_list: ["10.0.0.5"] }],
    });
    expect(master.calls).toContainEqual({ method: "startDistribution", args: [2] });
  });

  // §9.1.3-2: the last client gone, the server's group is emptied (audit 2026-09-29, C43).
  test("the last client leaving empties its server's group", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const master = makeFakeClient({}, {});
    master.distInfo = { role: "server", group_id: "9A23", server_zone: "main", client_list: ["10.0.0.5"] };
    const s = setup(features, ysp, { "10.0.0.9": master }, undefined, { host: "10.0.0.5" });
    s.client.distRole = "client";
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.leave", true);
    await flush();
    expect(master.calls).toContainEqual({ method: "setServerInfo", args: [{ group_id: "" }] });
    expect(master.calls.filter(c => c.method === "startDistribution")).toEqual([]);
  });

  // §9.1.3-1: a server leaving releases the clients it runs among the configured devices (C43).
  test("a server leaving releases its configured clients", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const member = makeFakeClient({}, {});
    const s = setup(features, ysp, { "10.0.0.7": member });
    s.client.distInfo = {
      role: "server",
      group_id: "9A23",
      client_list: [{ ip_address: "10.0.0.7", data_type: "base" }],
    };
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.leave", true);
    await flush();
    expect(member.calls).toContainEqual({ method: "setClientInfo", args: [{ group_id: "" }] });
  });

  // §9.1.8-1/-2: no `version` is a 1.x module — a master taking only 2.x refuses it with a line (C43).
  test("a device without a Link version is checked as 1.x", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      distribution: { version: 2, compatible_client: [2] },
    };
    const old = makeFakeClient({ distribution: {} }, {});
    const s = setup(features, ysp, { "1.2.3.9": old }, undefined, { host: "1.2.3.4" });
    await s.controller.start();
    void s.controller.handleWrite("multiroom.group.linkDevice", "1.2.3.9");
    await flush();
    expect(old.calls.filter(c => c.method === "setClientInfo")).toEqual([]);
    expect(s.warnings.some(line => line.includes("version 1 is not one this device takes"))).toBe(true);
  });

  test("a server whose role word says none still leaves as the server (§9.2)", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    s.client.distInfo = { role: "none", group_id: "9A237BF5AB80ED3C7251DFF49825CA42", client_list: ["1.2.3.5"] };
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.group.leave", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "stopDistribution", args: [] });
    expect(s.client.calls).toContainEqual({ method: "setServerInfo", args: [{ group_id: "" }] });
    expect(s.client.calls.filter(c => c.method === "setClientInfo")).toEqual([]);
  });

  // §9.1.6-1: a client whose input leaves MusicCast Link has to leave the group.
  test("a client that switches away from MusicCast Link leaves the group", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"], input_list: ["mc_link", "hdmi1"] }],
      distribution: { version: 2 },
    };
    const s = setup(features, { ...(ysp as Record<string, unknown>), power: "on", input: "mc_link" });
    s.client.distRole = "client";
    await s.controller.start();
    s.fire.push?.({ dist: { dist_info_updated: true } });
    await flush();
    s.client.calls.length = 0;
    s.client.status = { ...(ysp as Record<string, unknown>), power: "on", input: "hdmi1" };
    s.fire.push?.({ main: { input: "hdmi1" } });
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setClientInfo", args: [{ group_id: "" }] });
  });

  test("linking an unknown ip does nothing", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.group.linkDevice", "9.9.9.9");
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("without push, a write is read back from its zone at once instead of five minutes later", async () => {
    // Poll-only operation (the push port is taken): nothing reports the effect of a write
    // until the next keepalive — five minutes.
    const s = setup(wx10, ysp, {}, () => false);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("power", false);
    await flush();
    const order = s.client.calls.map(c => c.method);
    expect(order.indexOf("power")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("getStatus")).toBeGreaterThan(order.indexOf("power"));
  });

  // A tuner step changes the tuner's play info, never the zone status (YXC Basic §6.6/§6.15; audit
  // 2026-09-29, C32): without push the station stood five minutes old.
  test("without push, a tuner step is read back from the tuner, not from the zone", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm", "rds", "dab"], preset: { type: "separate", num: 40 } },
    };
    const s = setup(features, ysp, {}, () => false);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("tuner.presetUp", true);
    await flush();
    const order = s.client.calls.map(c => c.method);
    expect(order.indexOf("switchTunerPreset")).toBeGreaterThanOrEqual(0);
    const step = order.indexOf("switchTunerPreset");
    const readBack = s.client.calls.findIndex(
      (c, i) => i > step && c.method === "getPlayInfo" && c.args[0] === "tuner",
    );
    expect(readBack).toBeGreaterThan(step);
    expect(order).not.toContain("getStatus");
  });

  // The device announces a CHANGE only (YXC Basic §10.3): a write of the value it already has
  // stood unacknowledged for good under push (audit 2026-09-24, C1).
  test("with push working, writing the value the device already has is read back at once", async () => {
    const s = setup(wx10, ysp, {}, () => true);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("power", false);
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["power", "getStatus"]);
  });

  test("with push working, a changing write waits for the event — and the event is the confirmation", async () => {
    const { gate, elapse } = manualGate();
    const liveness = new PushLiveness();
    const s = setup(wx10, ysp, {}, () => true, { gate, pushLiveness: liveness });
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("power", true);
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["power"]);
    s.client.status = { ...(ysp as Record<string, unknown>), power: "on" };
    s.fire.push?.({ main: { power: "on" } });
    await elapse();
    // The push re-read the zone once; the window closed with nothing more asked.
    expect(s.client.calls.map(c => c.method)).toEqual(["power", "getStatus"]);
    expect(liveness.state).toBe("alive");
  });

  // Zone 2–4 events are "Reserved" in YXC Basic Rev 1.00 §10.3: a zone write under push stood
  // unconfirmed until the next keepalive on such a firmware (found while building C1).
  test("a zone 2 write is read back at once, push or not", async () => {
    const features = {
      zone: [
        { id: "main", func_list: ["power"] },
        { id: "zone2", func_list: ["power"] },
      ],
    };
    const s = setup(features, ysp, {}, () => true);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.zone2.power", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["zone2"] });
  });

  test("without push, a tuner write re-reads the tuner, not the zone", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], tuner: { func_list: ["preset"] } };
    const s = setup(features, { power: "on", input: "tuner" }, {}, () => false);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("tuner.preset", 3);
    await flush();
    const order = s.client.calls.map(c => `${c.method}:${typeof c.args[0] === "string" ? c.args[0] : ""}`);
    expect(order.some(call => call.startsWith("recallTunerPreset"))).toBe(true);
    expect(order).toContain("getPlayInfo:tuner");
    expect(order).not.toContain("getStatus:main");
  });

  test("a clock tick from the playing source updates the elapsed time without asking the device", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], netusb: {} }, { power: "on", input: "net_radio" });
    s.client.playInfo = { input: "net_radio", playback: "play", play_time: 0 };
    await s.controller.start();
    s.client.calls.length = 0;
    s.acks.length = 0;
    s.fire.push?.({ netusb: { play_time: 12 } });
    await flush();
    expect(s.client.calls.filter(c => c.method === "getPlayInfo")).toEqual([]);
    expect(s.acks).toContainEqual({ id: "living.player.elapsedTime", value: 12 });
    // A push that says the metadata changed still re-reads the block, as before.
    s.fire.push?.({ netusb: { play_time: 13, play_info_updated: true } });
    await flush();
    expect(s.client.calls.filter(c => c.method === "getPlayInfo")).toHaveLength(1);
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
  });

  // Every reported value is handed on, changed or not: the database write compares
  // (setStateChangedAsync), and only a value handed on can correct a datapoint someone else
  // wrote with ack, or one this transport just took over from a dropped owner (audit 2026-09-24,
  // C21 — a poll mirrors the device on every answer). The re-read stays: a push is partial.
  describe("a push re-reads the zone and hands every value on", () => {
    test("a status that repeats the current values hands them on again", async () => {
      const s = setup(wx10, ysp);
      await s.controller.start();
      s.acks.length = 0;
      s.fire.push?.({ main: { power: "on" } });
      await flush();
      // The re-read still happens — it is the only way to learn what a partial push left out.
      expect(s.client.calls).toContainEqual({ method: "getStatus", args: ["main"] });
      expect(s.acks).toContainEqual({ id: "living.power", value: false });
    });

    test("a changed field is handed on with its new value", async () => {
      const s = setup(wx10, ysp);
      await s.controller.start();
      s.acks.length = 0;
      s.client.status = { ...(ysp as Record<string, unknown>), power: "on" };
      s.fire.push?.({ main: { power: "on" } });
      await flush();
      expect(s.acks).toContainEqual({ id: "living.power", value: true });
    });

    test("writing the value the device already has gets its acknowledgement from the read-back", async () => {
      const s = setup(wx10, ysp, {}, () => true);
      await s.controller.start();
      s.acks.length = 0;
      // A scene recalling a fixed level, a script with a fixed volume: the write produces no
      // CHANGE, so the device sends no event (YXC Basic §10.3) — only reading it back acknowledges it.
      void s.controller.handleWrite("power", false);
      await flush();
      expect(s.acks).toContainEqual({ id: "living.power", value: false });
    });
  });

  // "Push active" meant the socket is bound: a second MusicCast client on the same host takes the
  // events away (they go to the last registration), and the adapter still trusted them — no
  // read-back after a write, the full sweep every 30 minutes (audit 2026-09-24, C1).
  describe("push liveness", () => {
    const fullSweep = (calls: Array<{ method: string }>): boolean => calls.some(c => c.method === "getPlayInfo");

    test("a changing write no event confirms is read back; the second such change stops trusting push", async () => {
      const { gate, elapse } = manualGate();
      const liveness = new PushLiveness();
      const s = setup(wx10, ysp, {}, () => true, { gate, pushLiveness: liveness });
      await s.controller.start();
      s.client.calls.length = 0;
      s.client.status = { ...(ysp as Record<string, unknown>), power: "on" };
      void s.controller.handleWrite("power", true);
      await elapse();
      expect(s.client.calls.map(c => c.method)).toEqual(["power", "getStatus"]);
      expect(s.acks).toContainEqual({ id: "living.power", value: true });
      expect(liveness.state).toBe("unknown");
      expect(s.infos).toEqual([]);
      s.client.status = { ...(s.client.status as Record<string, unknown>), power: "standby" };
      void s.controller.handleWrite("power", false);
      await elapse();
      expect(liveness.state).toBe("dead");
      expect(s.infos).toEqual(["living: MusicCast events are not arriving — polling and reading writes back"]);
      // Now every keepalive sweeps everything, and a write is read back at once.
      s.client.calls.length = 0;
      s.fire.keepalive?.();
      await flush();
      expect(fullSweep(s.client.calls)).toBe(true);
      s.client.calls.length = 0;
      void s.controller.handleWrite("power", true);
      await flush();
      expect(s.client.calls.map(c => c.method)).toEqual(["power", "getStatus"]);
    });

    test("a write the device took and did not carry out judges nothing", async () => {
      const { gate, elapse } = manualGate();
      const liveness = new PushLiveness();
      const s = setup(wx10, ysp, {}, () => true, { gate, pushLiveness: liveness });
      await s.controller.start();
      // Accepted, not done (the read-back still says standby): no change, so no event was owed.
      void s.controller.handleWrite("power", true);
      await elapse();
      void s.controller.handleWrite("power", true);
      await elapse();
      expect(liveness.state).toBe("unknown");
      expect(s.infos).toEqual([]);
    });

    test("a resting device stays in push mode: the full sweep only every sixth keepalive", async () => {
      const liveness = new PushLiveness();
      const s = setup(wx10, ysp, {}, () => true, { pushLiveness: liveness });
      await s.controller.start();
      const sweeps: boolean[] = [];
      for (let run = 1; run <= 6; run++) {
        s.client.calls.length = 0;
        s.fire.keepalive?.();
        await flush();
        sweeps.push(fullSweep(s.client.calls));
      }
      expect(sweeps).toEqual([false, false, false, false, false, true]);
      expect(liveness.state).toBe("unknown");
    });

    test("a keepalive that finds the main zone changed without an event counts a miss", async () => {
      const liveness = new PushLiveness();
      const s = setup(wx10, ysp, {}, () => true, { pushLiveness: liveness });
      await s.controller.start();
      s.client.status = { ...(ysp as Record<string, unknown>), power: "on" };
      s.fire.keepalive?.();
      await flush();
      expect(liveness.state).toBe("unknown");
      s.client.status = { ...(ysp as Record<string, unknown>), power: "standby" };
      s.fire.keepalive?.();
      await flush();
      expect(liveness.state).toBe("dead");
      // An event in between would have told: the same changes with events judge nothing.
      const told = new PushLiveness();
      const t = setup(wx10, ysp, {}, () => true, { pushLiveness: told });
      await t.controller.start();
      t.client.status = { ...(ysp as Record<string, unknown>), power: "on" };
      t.fire.push?.({ netusb: { play_time: 3 } });
      t.fire.keepalive?.();
      await flush();
      t.client.status = { ...(ysp as Record<string, unknown>), power: "standby" };
      t.fire.push?.({ netusb: { play_time: 4 } });
      t.fire.keepalive?.();
      await flush();
      expect(told.state).toBe("alive");
    });

    test("an event brings it back", async () => {
      const liveness = new PushLiveness();
      liveness.noteMiss();
      liveness.noteMiss();
      const s = setup(wx10, ysp, {}, () => true, { pushLiveness: liveness });
      await s.controller.start();
      s.fire.push?.({ main: { power: "standby" } });
      await flush();
      expect(liveness.state).toBe("alive");
      expect(s.infos).toEqual(["living: MusicCast events arrive again"]);
      s.client.calls.length = 0;
      s.fire.keepalive?.();
      await flush();
      expect(fullSweep(s.client.calls)).toBe(false);
    });

    test("no misses are counted while the push socket is not bound", async () => {
      const liveness = new PushLiveness();
      const s = setup(wx10, ysp, {}, () => false, { pushLiveness: liveness });
      await s.controller.start();
      for (const power of ["on", "standby", "on"]) {
        s.client.status = { ...(ysp as Record<string, unknown>), power };
        s.fire.keepalive?.();
        await flush();
      }
      expect(liveness.state).toBe("unknown");
    });
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

  test("a write nobody answered checks the device at once — and reports the drop when the zone is silent too", async () => {
    // Until 2.10.0 only the 5-minute keepalive fed the drop detector: a device switched off
    // right after a poll stayed "connected" for up to 15 minutes, every write in between
    // merely warned.
    const s = setup(wx10, ysp);
    await s.controller.start();
    const drops: Array<Error | undefined> = [];
    s.controller.onDrop(reason => drops.push(reason));
    s.client.failWrites = new YxcTransportError("main/setPower?power=standby", new Error("connect ECONNREFUSED"));
    s.client.failStatus = true;
    void s.controller.handleWrite("power", false);
    await flush();
    expect(drops).toHaveLength(1);
    expect(s.client.calls.filter(c => c.method === "getStatus").length).toBeGreaterThanOrEqual(1);
  });

  test("a device that refuses a write is alive — read back once, no liveness check, no drop", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    const statusReads = (): number => s.client.calls.filter(c => c.method === "getStatus").length;
    const before = statusReads();
    s.client.failWrites = new YxcRefusalError("/main/setPower?power=standby", 3);
    s.client.failStatus = true;
    void s.controller.handleWrite("power", false);
    await flush();
    // The one status read is the read-back of the refused value (C28) — even when it fails, a
    // refusal never judges the device gone.
    expect(statusReads()).toBe(before + 1);
    expect(dropped).toBe(0);
  });

  // A refused value stood unacknowledged: no event corrects it (nothing changed), and the next
  // zone poll was five minutes away, a system value's thirty (audit 2026-09-24, C28).
  test("a refused write is read back at once and puts the device's value back, push or not", async () => {
    const s = setup(wx10, ysp, {}, () => true);
    await s.controller.start();
    s.acks.length = 0;
    s.client.calls.length = 0;
    s.client.failWrites = new YxcRefusalError("/main/setPower?power=on", 5);
    void s.controller.handleWrite("power", true);
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["power", "getStatus"]);
    expect(s.acks).toContainEqual({ id: "living.power", value: false });
    expect(s.warnings).toEqual([
      "living: write to power failed: device refused /main/setPower?power=on (response_code 5: Guarded)",
    ]);
  });

  test("a refused device-wide setting is read back too", async () => {
    const s = setup(wx10, ysp, {}, () => true);
    s.client.funcStatus = { response_code: 0, auto_power_standby: true };
    await s.controller.start();
    s.acks.length = 0;
    s.client.calls.length = 0;
    s.client.failWrites = new YxcRefusalError("/system/setAutoPowerStandby?enable=false", 5);
    void s.controller.handleWrite("advanced.autoPowerStandby", false);
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["setAutoPowerStandby", "getFuncStatus"]);
    expect(s.acks).toContainEqual({ id: "living.advanced.autoPowerStandby", value: true });
  });

  // A refusal is an answer: code 1 "Initializing" while the device boots, 99 during a firmware
  // update. The keepalive and the liveness check counted it as silence (audit 2026-09-24, C15).
  test("a zone status refusal is proof of life — no drop from the keepalive or the liveness check", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    s.client.refuseStatus = 99;
    for (let run = 0; run < 4; run++) {
      s.fire.keepalive?.();
      await flush();
    }
    await s.controller.verifyAlive();
    expect(dropped).toBe(0);
    // The same device silent: the liveness check reports the drop at once.
    s.client.refuseStatus = undefined;
    s.client.failStatus = true;
    await s.controller.verifyAlive();
    expect(dropped).toBe(1);
  });

  test("a start whose zones all refuse is not ready — and says so, not 'unreachable'", async () => {
    const s = setup(wx10, ysp);
    s.client.refuseStatus = 1;
    expect(await s.controller.start()).toBe(false);
    expect(s.debugs).toContainEqual(
      "living: the device answers but is not ready yet — device refused /main/getStatus (response_code 1: Initializing) (YXC)",
    );
    expect(s.debugs.some(line => line.includes("unreachable"))).toBe(false);
  });

  test("a transport failure on a device whose zone still answers is no drop", async () => {
    const s = setup(wx10, { ...(ysp as Record<string, unknown>), power: "on", disable_flags: 0 });
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    s.client.failWrites = new YxcTransportError("main/setPower?power=standby", new Error("socket hang up"));
    void s.controller.handleWrite("power", false);
    await flush();
    expect(dropped).toBe(0);
    // Several failed writes in a row share ONE check — not one probe per write.
    const before = s.client.calls.filter(c => c.method === "getStatus").length;
    void s.controller.handleWrite("power", false);
    void s.controller.handleWrite("mute", true);
    void s.controller.handleWrite("volume", 10);
    await flush();
    expect(s.client.calls.filter(c => c.method === "getStatus").length - before).toBeLessThanOrEqual(1);
  });

  test("a device-wide switch reads the words a script writes — 'false' switches it off", async () => {
    const s = setup(wx10, ysp);
    s.client.funcStatus = { response_code: 0, auto_power_standby: true };
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("advanced.autoPowerStandby", "false");
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setAutoPowerStandby", args: [false] });
    s.client.calls.length = 0;
    void s.controller.handleWrite("advanced.autoPowerStandby", "maybe");
    await flush();
    expect(s.client.calls.filter(c => c.method === "setAutoPowerStandby")).toEqual([]);
  });

  test("a device-wide setting whose write never arrived is checked the same way", async () => {
    const s = setup(wx10, ysp);
    // The setting exists only once the device reported it in getFuncStatus.
    s.client.funcStatus = { response_code: 0, auto_power_standby: true };
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    s.client.failWrites = new YxcTransportError("system/setAutoPowerStandby", new Error("EHOSTUNREACH"));
    s.client.failStatus = true;
    void s.controller.handleWrite("advanced.autoPowerStandby", true);
    await flush();
    expect(dropped).toBe(1);
  });

  test("close unregisters from the shared push receiver", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.controller.close();
    expect(s.unregistered()).toBe(true);
  });
});

describe("YxcDeviceController guards", () => {
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
    void s.controller.handleWrite("sound.equalizer.low", 7);
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

  test("remembers the device ids from getDeviceInfo, outside the feature-validating identity", async () => {
    const memory = new ProbeMemory();
    const client = makeFakeClient(oneZone, { power: "on" });
    client.deviceInfo = { model_name: "WX-030", system_version: 2.1, system_id: "0E897553", device_id: "00A0DED4F504" };
    const controller = new YxcDeviceController("living", {
      client,
      registerPush: () => () => {},
      scheduleKeepalive: () => () => {},
      upsertObject: async () => {},
      setStateAck: () => {},
      log: silentLog,
      gate: testGate(),
      pushLiveness: new PushLiveness(),
      probeMemory: memory,
    });
    expect(await controller.start()).toBe(true);
    // Serial and MAC ride in their own key: adding them to `yxcIdentity` would drop every
    // remembered feature once on the update, for nothing the features depend on.
    expect(memory.remembered("yxcDeviceIds")).toEqual({ serial: "0E897553", mac: "00A0DED4F504" });
    expect(memory.remembered("yxcIdentity")).toBe("WX-030|2.1");
  });

  test("writes no device ids when getDeviceInfo carries none", async () => {
    const memory = new ProbeMemory();
    const client = makeFakeClient(oneZone, { power: "on" });
    client.deviceInfo = { model_name: "WX-030" };
    const controller = new YxcDeviceController("living", {
      client,
      registerPush: () => () => {},
      scheduleKeepalive: () => () => {},
      upsertObject: async () => {},
      setStateAck: () => {},
      log: silentLog,
      gate: testGate(),
      pushLiveness: new PushLiveness(),
      probeMemory: memory,
    });
    await controller.start();
    expect(memory.remembered("yxcDeviceIds")).toBeUndefined();
  });

  test("verifyAlive asks the main zone once: no answer is a drop, an answer is not", async () => {
    // Called by the multi-transport handle when ANOTHER transport of the device just dropped —
    // a device that lost power must not stay "connected" on MusicCast until the third missed
    // five-minute poll.
    const client = makeFakeClient(oneZone, { power: "on" });
    const controller = new YxcDeviceController("living", {
      probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
      client,
      registerPush: () => () => {},
      scheduleKeepalive: () => () => {},
      upsertObject: async () => {},
      setStateAck: () => {},
      log: silentLog,
      gate: testGate(),
      pushLiveness: new PushLiveness(),
    });
    expect(await controller.start()).toBe(true);
    const drop = vi.fn();
    controller.onDrop(drop);
    await controller.verifyAlive();
    expect(drop).not.toHaveBeenCalled();
    client.failStatus = true;
    const before = client.calls.length;
    await Promise.all([controller.verifyAlive(), controller.verifyAlive()]); // two askers, one question
    expect(client.calls.slice(before).filter(call => call.method === "getStatus")).toHaveLength(1);
    expect(drop).toHaveBeenCalledTimes(1);
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
        pushLiveness: new PushLiveness(),
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

  it("a capability answer without a single zone is not remembered", async () => {
    // A truncated getFeatures still parses — into zero zones. Remembering that froze the
    // device's shape for good (every later connect read the memory instead of asking), and
    // it disarmed the liveness check above, which has nothing left to ask. So: used for
    // this attempt, never written to the memory.
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
        pushLiveness: new PushLiveness(),
        probeMemory: memory,
      });

    const truncated = makeFakeClient({ netusb: {} }, { power: "on" });
    // No zone answers, so nothing proves the device is there — the start fails honestly
    // instead of reporting "ready" out of a shape nobody could verify.
    expect(await build(truncated).start()).toBe(false);
    expect(memory.remembered("features")).toBeUndefined();

    // The next connect asks again — and a complete answer works normally.
    const healthy = makeFakeClient(oneZone, { power: "on" });
    expect(await build(healthy).start()).toBe(true);
    expect(healthy.calls.some(call => call.method === "getFeatures")).toBe(true);
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

  // Beside the JSON: a channel per declared slot, a datapoint per field, an empty slot read empty (C30).
  test("the favourites and recent lists also land as slots, as many as the device declares", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      netusb: { preset: { num: 3 }, recent_info: { num: 2 } },
    };
    const s = setup(features, ysp);
    s.client.presetInfo = {
      response_code: 0,
      preset_info: [
        { input: "unknown", text: "" },
        { input: "net_radio", text: "hr3" },
      ],
    };
    s.client.recentInfo = { response_code: 0, recent_info: [{ input: "spotify", text: "Mix" }] };
    await s.controller.start();
    expect(s.objects.filter(id => id.startsWith("living.player.netPlayer.favourites."))).toHaveLength(3 * 3);
    expect(s.acks).toEqual(
      expect.arrayContaining([
        { id: "living.player.netPlayer.favourites.1.name", value: "" },
        { id: "living.player.netPlayer.favourites.2.name", value: "hr3" },
        { id: "living.player.netPlayer.favourites.2.input", value: "NET RADIO" },
        { id: "living.player.netPlayer.favourites.3.input", value: "" },
        { id: "living.player.netPlayer.recentItems.1.name", value: "Mix" },
        { id: "living.player.netPlayer.recentItems.2.name", value: "" },
      ]),
    );
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
    void s.controller.handleWrite("tuner.preset", 7);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallTunerPreset", args: ["fm", 7, "main"] });
  });

  // A receiver that refuses its preset lists (a CD receiver answers `Guarded`) gets no empty stored-stations
  // folder: the runtime removes nothing, so an empty folder would stand in the tree for good (2026-10-02).
  test("no stored-stations folder while no band has a list", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm", "dab"], preset: { type: "separate", num: 30 } },
    };
    const refused = setup(features, ysp);
    (refused.client as unknown as { getTunerPresetInfo: () => Promise<never> }).getTunerPresetInfo = () =>
      Promise.reject(new YxcRefusalError("/tuner/getPresetInfo", 5));
    await refused.controller.start();
    expect(refused.objects.filter(id => id.startsWith("living.tuner.storedStations"))).toEqual([]);
    // An answer without a list is no list either.
    const empty = setup(features, ysp);
    (empty.client as unknown as { getTunerPresetInfo: () => Promise<unknown> }).getTunerPresetInfo = () =>
      Promise.resolve({ response_code: 0 });
    await empty.controller.start();
    expect(empty.objects.filter(id => id.startsWith("living.tuner.storedStations"))).toEqual([]);
  });

  // YXC Basic Rev 1.10 §6.8 clears on the band (separate lists), §6.4 searches AM/FM, DAB steps its
  // service (§6.15) — the controller supplies the band (audit 2026-09-29, C38).
  test("a preset is cleared on the current band, and a search follows the band", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm", "dab"], preset: { type: "separate", num: 30 } },
    };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(s.objects).toEqual(
      expect.arrayContaining(["living.tuner.storedStations", "living.tuner.storedStations.fm.30.frequency"]),
    );
    s.client.calls.length = 0;
    void s.controller.handleWrite("tuner.presetClear", 3);
    void s.controller.handleWrite("tuner.searchUp", true);
    await flush();
    expect(s.client.calls).toEqual(
      expect.arrayContaining([
        { method: "clearTunerPreset", args: ["fm", 3] },
        { method: "searchTuner", args: ["fm", "auto_up"] },
        // Without events each is read back where it acts: the stored list, the tuner.
        { method: "getTunerPresetInfo", args: ["fm"] },
        { method: "getPlayInfo", args: ["tuner"] },
      ]),
    );
    s.client.calls.length = 0;
    s.client.tunerPlayInfo = { band: "dab", dab: { status: "ready" } };
    void s.controller.handleWrite("tuner.band", "dab");
    await flush();
    void s.controller.handleWrite("tuner.searchDown", true);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setDabService", args: ["previous"] });
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
    void s.controller.handleWrite("tuner.preset", 12);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallTunerPreset", args: ["common", 12, "main"] });
  });

  test("preset up/down and recall-recent writes reach the client", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {}, tuner: {} };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("tuner.presetUp", true);
    void s.controller.handleWrite("player.netPlayer.recallRecent", 2);
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
      probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
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
      pushLiveness: new PushLiveness(),
    });
    return { controller, client, objects };
  }

  test("creates the browse tree for a netusb device and routes its writes", async () => {
    const { controller, client, objects } = browseSetup(browsableFeatures);
    await controller.start();
    expect(objects).toContain("living.player.browse");
    expect(objects).toContain("living.player.browse.selectLine");
    void controller.handleWrite("player.browse.source", "netRadio");
    await flush();
    expect(client.calls).toContainEqual({ method: "getListInfo", args: ["net_radio", 0, 8, "en"] });
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
      { id: "main", func_list: ["power"], input_list: ["hdmi1", "net_radio", "tuner"] },
      { id: "zone2", func_list: ["power"], input_list: ["hdmi1", "net_radio", "tuner"] },
    ],
    netusb: {},
    tuner: { func_list: ["fm"], preset: { type: "common", num: 40 } },
  };

  /**
   * A started two-zone device, both zones switched on — through the public surface only: the zones report their
   * inputs, the network player its source (the routing has its own module and suite, `player-routing.test.ts`).
   *
   * @param main the main zone's input
   * @param zone2 zone 2's input
   * @param network the network player's source
   * @returns the started setup, its calls cleared
   */
  async function started(main: string, zone2: string, network: string): Promise<ReturnType<typeof setup>> {
    const s = setup(twoZones, { power: "on", input: main });
    s.client.statusByZone = { main: { power: "on", input: main }, zone2: { power: "on", input: zone2 } };
    s.client.playInfo = { input: network, playback: "play" };
    await s.controller.start();
    s.client.calls.length = 0;
    return s;
  }

  test("a favourite goes to the zone that is listening to the network player, not always to main", async () => {
    const s = await started("hdmi1", "net_radio", "net_radio");
    void s.controller.handleWrite("player.netPlayer.preset", 3);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallPreset", args: [3, "zone2"] });
  });

  test("main wins when it is listening to the same source", async () => {
    const s = await started("net_radio", "net_radio", "net_radio");
    void s.controller.handleWrite("player.netPlayer.preset", 1);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallPreset", args: [1, "main"] });
  });

  test("falls back to main when nothing is listening to that source (every single-zone device)", async () => {
    const s = await started("hdmi1", "hdmi1", "");
    void s.controller.handleWrite("player.netPlayer.recallRecent", 2);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallRecentItem", args: [2, "main"] });
  });

  test("a tuner preset goes to the zone listening to the tuner", async () => {
    const s = await started("hdmi1", "tuner", "net_radio");
    void s.controller.handleWrite("tuner.preset", 4);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "recallTunerPreset", args: ["common", 4, "zone2"] });
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
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA, "xmlScenes:main": declaration });
    const s = setup(
      { response_code: 0, zone: [{ id: "main", func_list: ["power", "scene"], input_list: ["hdmi1"], scene_num: 8 }] },
      { response_code: 0, power: "on" },
    );
    (s.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await s.controller.start();
    (s.client.calls as Array<{ method: string }>).length = 0;
    void s.controller.handleWrite("scene.recall", "net audio");
    await new Promise(resolve => setImmediate(resolve));
    expect(s.client.calls as Array<{ method: string; args: unknown[] }>).toContainEqual({
      method: "recallScene",
      args: [4, "main"],
    });
    // An unknown title sends nothing.
    (s.client.calls as Array<{ method: string }>).length = 0;
    void s.controller.handleWrite("scene.recall", "Party");
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
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "NET RADIO" });
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
    expect(s.acks).toContainEqual({ id: "living.player.playback", value: 2 });
    expect(s.acks).toContainEqual({ id: "living.player.elapsedTime", value: 0 });
  });

  test("a zone starting ON a media source keeps the routed source value (no empty overwrite)", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], netusb: {} }, { power: "on", input: "net_radio" });
    s.client.playInfo = { input: "net_radio", playback: "play" };
    await s.controller.start();
    const sources = s.acks.filter(ack => ack.id === "living.player.source").map(ack => ack.value);
    expect(sources).toEqual(["NET RADIO"]);
  });
});

describe("YxcDeviceController seed edge cases (2.0.1 hardening)", () => {
  test("the DAB scan counters start at zero where the tuner declares the scan — and only there", async () => {
    // The ISX-18D getFeatures shape: `dab_initial_scan` in tuner.func_list (YXC Basic §6.2; audit
    // 2026-09-29, C42). A DAB receiver without it (RX-V6A, RX-A2070) gets no counters.
    const dabFeatures = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm", "dab", "dab_initial_scan"], preset: { type: "separate", num: 30 } },
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
    const noScan = setup(
      {
        zone: [{ id: "main", func_list: ["power"] }],
        tuner: { func_list: ["fm", "rds", "dab"], preset: { type: "separate", num: 40 } },
      },
      { power: "on", input: "hdmi1" },
    );
    await noScan.controller.start();
    expect(noScan.acks.some(ack => ack.id === "living.tuner.dab.totalStations")).toBe(false);
  });

  test("a cd-only device gets the cleared player block too (no netusb required)", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], cd: {} }, { power: "on", input: "hdmi1" });
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "" });
    expect(s.acks).toContainEqual({ id: "living.player.playback", value: 2 });
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
    expect(s.acks).toContainEqual({ id: "living.multiroom.zone2.player.source", value: "NET RADIO" });
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
    void s.controller.handleWrite("tuner.band", "am");
    void s.controller.handleWrite("tuner.frequency", 1440);
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
    void s.controller.handleWrite("sound.equalizer.low", 7);
    void s.controller.handleWrite("sound.equalizer.mid", -4);
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

describe("YxcDeviceController equalizer cache seeding (audit 2026-09-02)", () => {
  test("an incomplete FIRST status seeds no cache — a band write then refuses instead of inventing 0/0/0", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    // The device's first status carries only one band (fields it deems unchanged are omitted).
    const s = setup(features, { power: "on", equalizer: { mid: 9 } });
    const warnings: string[] = [];
    (s.controller as unknown as { deps: { log: { debug(): void; info(): void; warn(m: string): void } } }).deps.log = {
      ...silentLog,
      warn: (m: string) => warnings.push(m),
    };
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("sound.equalizer.low", 7);
    await flush();
    // Seeding the cache with {low: 0, mid: 9, high: 0} would have sent setEqualizer(7, 9, 0):
    // the user's high band flattened to 0 dB — exactly what the write path's own guard
    // exists to prevent. Without a complete triple the write is refused, visibly.
    expect(s.client.calls.some(c => c.method === "setEqualizer")).toBe(false);
    expect(warnings.some(w => w.includes("has not reported its equalizer bands"))).toBe(true);
  });

  test("a complete first status seeds the cache; later partial statuses merge into it", async () => {
    const features = { zone: [{ id: "main", func_list: ["power", "equalizer"] }] };
    const status: Record<string, unknown> = { power: "on", equalizer: { low: 1, mid: 2, high: 3 } };
    const s = setup(features, status);
    await s.controller.start();
    status.equalizer = { high: 5 };
    s.fire.keepalive?.();
    await flush();
    s.client.calls.length = 0;
    void s.controller.handleWrite("sound.equalizer.low", 7);
    await flush();
    expect(s.client.calls).toContainEqual({ method: "setEqualizer", args: [7, 2, 5, "main"] });
  });
});

describe("the device-wide settings with their declarations (coverage audit 2026-09-09)", () => {
  const features = {
    system: {
      func_list: ["hdmi_standby_through", "speaker_pattern", "video_preset", "party_mode", "headphone"],
      hdmi_standby_through_list: ["off", "on", "auto"],
      speaker_pattern_num: 2,
      video_preset_num: 6,
    },
    zone: [{ id: "main", func_list: ["power"], input_list: ["hdmi1"] }],
  };
  const status = { power: "on", input: "hdmi1" };

  test("the declared list, the pattern count and the preset count become the datapoints' own value lists and bounds", async () => {
    const s = setup(features, status);
    s.client.funcStatus = {
      response_code: 0,
      hdmi_out_1: true,
      hdmi_out_3: false,
      hdmi_standby_through: "auto",
      headphone: true,
      party_mode: false,
      speaker_pattern: 2,
      video_preset: 3,
    };
    await s.controller.start();
    const through = s.defs.get("living.hdmi.standbyThrough");
    expect(through?.common.states).toEqual({ off: "off", on: "on", auto: "auto" });
    expect(through?.declaredStates).toBe(true);
    const pattern = s.defs.get("living.advanced.speakers.pattern");
    expect(pattern?.common.states).toEqual({ "Pattern 1": "Pattern 1", "Pattern 2": "Pattern 2" });
    expect(pattern?.declaredStates).toBe(true);
    const preset = s.defs.get("living.hdmi.videoPreset");
    expect(preset?.common).toMatchObject({ type: "number", min: 1, max: 6, step: 1 });
    expect(s.acks).toContainEqual({ id: "living.advanced.speakers.pattern", value: "Pattern 2" });
    expect(s.acks).toContainEqual({ id: "living.hdmi.standbyThrough", value: "auto" });
    expect(s.acks).toContainEqual({ id: "living.advanced.headphone", value: true });
    expect(s.acks).toContainEqual({ id: "living.hdmi.videoPreset", value: 3 });
    expect(s.acks).toContainEqual({ id: "living.hdmi.out3", value: false });
  });

  test("party mode writes through setPartyMode; a field the device did not answer builds nothing", async () => {
    const s = setup(features, status);
    s.client.funcStatus = { response_code: 0, party_mode: false };
    await s.controller.start();
    expect(s.defs.has("living.multiroom.party")).toBe(true);
    expect(s.defs.has("living.hdmi.standbyThrough")).toBe(false);
    void s.controller.handleWrite("multiroom.party", true);
    await new Promise(resolve => setImmediate(resolve));
    expect(s.client.calls).toContainEqual({ method: "setPartyMode", args: [true] });
  });
});

// Six refresh signals were ignored (a group formed in the app, a changed setting, a renamed room, a
// new input signal, a stored tuner preset, a changed alarm) and waited for the 30-minute sweep; a
// favourite store re-read the whole playback info; the network player's error and message were never
// shown (audit 2026-09-24, C3/C18 — YXC Basic Rev 1.10 §11.3).
describe("YxcDeviceController push signals", () => {
  const features = {
    system: {},
    zone: [{ id: "main", func_list: ["power", "signal_info"], input_list: ["net_radio", "tuner", "cd"] }],
    netusb: {},
    tuner: { func_list: ["fm"] },
    cd: {},
    clock: { func_list: ["alarm"] },
    distribution: { version: 2 },
  };

  async function started(): Promise<ReturnType<typeof setup>> {
    const s = setup(features, ysp, {}, () => true, { gate: testGate() });
    s.client.nameText = { zone_list: [{ id: "main", text: "Kitchen" }] };
    s.client.funcStatus = { response_code: 0, auto_power_standby: true };
    await s.controller.start();
    s.client.calls.length = 0;
    s.acks.length = 0;
    s.names.length = 0;
    return s;
  }

  const methods = (s: ReturnType<typeof setup>): string[] => s.client.calls.map(c => c.method);

  test.each([
    [{ dist: { dist_info_updated: true } }, "getDistributionInfo"],
    [{ system: { func_status_updated: true } }, "getFuncStatus"],
    [{ tuner: { preset_info_updated: true } }, "getTunerPresetInfo"],
    [{ clock: { settings_updated: true } }, "getClockSettings"],
    [{ system: { name_text_updated: true } }, "getNameText"],
  ])("%j is answered by %s alone", async (event, method) => {
    const s = await started();
    s.fire.push?.(event);
    await flush();
    expect(methods(s)).toContain(method);
    expect(methods(s)).not.toContain("getPlayInfo");
  });

  test("a zone's signal flag re-reads that zone's signal", async () => {
    const s = await started();
    s.fire.push?.({ main: { signal_info_updated: true } });
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getSignalInfo", args: ["main"] });
  });

  test("a renamed room reaches the device label", async () => {
    const s = await started();
    s.client.nameText = { zone_list: [{ id: "main", text: "Living room" }] };
    s.fire.push?.({ system: { name_text_updated: true } });
    await flush();
    expect(s.names).toEqual(["Living room"]);
  });

  test("a flag that is false asks nothing", async () => {
    const s = await started();
    s.fire.push?.({ dist: { dist_info_updated: false }, system: { func_status_updated: false } });
    await flush();
    expect(methods(s)).toEqual([]);
  });

  test("a list change re-reads the open menu window", async () => {
    const s = await started();
    void s.controller.handleWrite("player.browse.source", "netRadio");
    await flush();
    const reads = (): number => s.client.calls.filter(c => c.method === "getListInfo").length;
    const before = reads();
    s.fire.push?.({ netusb: { list_info_updated: true } });
    await flush();
    expect(reads()).toBe(before + 1);
    expect(methods(s)).not.toContain("getPlayInfo");
  });

  test("the network player's error and message land in their states straight from the push", async () => {
    const s = await started();
    s.fire.push?.({ netusb: { play_error: 2, play_message: "Playback unavailable" } });
    await flush();
    expect(s.acks).toContainEqual({ id: "living.player.netPlayer.playError", value: 2 });
    expect(s.acks).toContainEqual({ id: "living.player.netPlayer.playMessage", value: "Playback unavailable" });
    expect(methods(s)).not.toContain("getPlayInfo");
  });

  test("the error and message states start at 'none' and exist on a network player", async () => {
    const s = setup(features, ysp, {}, () => true, { gate: testGate() });
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.netPlayer.playError", value: 0 });
    expect(s.acks).toContainEqual({ id: "living.player.netPlayer.playMessage", value: "" });
    expect(s.defs.get("living.player.netPlayer.playError")?.common).toMatchObject({
      type: "number",
      role: "value",
      write: false,
      states: expect.objectContaining({ 0: "No Error", 2: "Playback Unavailable", 100: "Multiple Errors" }),
    });
  });

  test("a favourite this adapter recalled and the device could not play is said on warn — another one is not", async () => {
    const s = await started();
    void s.controller.handleWrite("player.netPlayer.preset", 4);
    await flush();
    s.fire.push?.({ netusb: { preset_control: { type: "recall", num: 4, result: "empty" } } });
    await flush();
    expect(s.warnings).toEqual(["living: favourite 4 could not be recalled (empty)"]);
    s.fire.push?.({ netusb: { preset_control: { type: "recall", num: 7, result: "not_found" } } });
    s.fire.push?.({ netusb: { preset_control: { type: "store", num: 4, result: "error" } } });
    await flush();
    expect(s.warnings).toHaveLength(1);
  });

  test("the disc drive's state comes from the push itself", async () => {
    const s = await started();
    s.fire.push?.({ cd: { device_status: "open" } });
    await flush();
    expect(s.acks).toContainEqual({ id: "living.player.cd.deviceStatus", value: "open" });
    expect(methods(s)).not.toContain("getPlayInfo");
  });
});

// A cover path loaded relative to the ioBroker web server and showed nothing; below API 1.17 the
// device sends only Yamaha's encrypted ymf (YXC Basic §7.2; audit 2026-09-24, C6).
describe("YxcDeviceController cover address", () => {
  const features = { zone: [{ id: "main", func_list: ["power"], input_list: ["net_radio"] }], netusb: {} };

  async function coverAfterPush(
    apiVersion: number,
    albumArtUrl = "/YamahaRemoteControl/AlbumART/AlbumART1.jpg",
    albumArtId?: number,
  ): Promise<unknown> {
    const s = setup(features, { power: "on", input: "net_radio" }, {}, () => true, { host: "10.0.0.5" });
    s.client.deviceInfo = { model_name: "WX-030", api_version: apiVersion };
    s.client.playInfo = {
      input: "net_radio",
      playback: "play",
      albumart_url: albumArtUrl,
      ...(albumArtId !== undefined ? { albumart_id: albumArtId } : {}),
    };
    await s.controller.start();
    s.acks.length = 0;
    s.fire.push?.({ netusb: { play_info_updated: true } });
    await flush();
    return s.acks.find(a => a.id === "living.player.albumArt")?.value;
  }

  test("a cover path is shown as the address on the device", async () => {
    expect(await coverAfterPush(2.08)).toBe("http://10.0.0.5/YamahaRemoteControl/AlbumART/AlbumART1.jpg");
  });

  test("a device below API 1.17 shows no cover — its format is Yamaha's encrypted one", async () => {
    expect(await coverAfterPush(1.1)).toBe("");
  });

  // Only a cover ON THE DEVICE is the encrypted form; a service's web address is a plain image (C49).
  test("below API 1.17 a service's own cover address still shows", async () => {
    expect(await coverAfterPush(1.1, "http://static.airable.io/43/13/186713.png")).toBe(
      "http://static.airable.io/43/13/186713.png",
    );
  });

  // One fixed cover path for every track: the id says the cover changed (YXC Basic §7.2; C36).
  test("the album art id rides along, so a new cover under the same path changes the address", async () => {
    expect(await coverAfterPush(2.08, "/YamahaRemoteControl/AlbumART/AlbumART.jpg", 5708)).toBe(
      "http://10.0.0.5/YamahaRemoteControl/AlbumART/AlbumART.jpg?id=5708",
    );
  });
});

// A zone that declares its remote keys (`cursor_list`) takes those and no other; the shared vocabulary
// is for a zone without a list (audit 2026-09-29, C46).
describe("YxcDeviceController remote keys", () => {
  test("a declared key goes out, a vocabulary word the zone does not declare is not sent", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power", "cursor"], cursor_list: ["up", "down", "select"] }],
    };
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("remote.cursor", "up");
    void s.controller.handleWrite("remote.cursor", "return");
    await flush();
    expect(s.client.calls.filter(c => c.method === "controlCursor")).toEqual([
      { method: "controlCursor", args: ["up", "main"] },
    ]);
  });
});

// setRepeat/setShuffle from API 1.19 on the network player (aiomusiccast, Home Assistant; audit
// 2026-09-29, C37): the modes are writable there, and only there.
describe("YxcDeviceController repeat and shuffle set directly", () => {
  const features = { zone: [{ id: "main", func_list: ["power"], input_list: ["net_radio", "cd"] }], netusb: {} };

  async function started(apiVersion: number, input: string): Promise<ReturnType<typeof setup>> {
    const s = setup(features, { power: "on", input });
    s.client.deviceInfo = { model_name: "WX-030", api_version: apiVersion };
    s.client.playInfo = { input, playback: "play" };
    await s.controller.start();
    s.client.calls.length = 0;
    return s;
  }

  test("API 1.19+: repeat and shuffle are writable and go out as setRepeat/setShuffle", async () => {
    const s = await started(2.08, "net_radio");
    expect(s.defs.get("living.player.repeat")?.common.write).toBe(true);
    void s.controller.handleWrite("player.repeat", 2);
    void s.controller.handleWrite("player.shuffle", true);
    await flush();
    expect(s.client.calls.filter(c => c.method.startsWith("setNet"))).toEqual([
      { method: "setNetRepeat", args: ["all"] },
      { method: "setNetShuffle", args: ["on"] },
    ]);
  });

  test("below API 1.19 the modes stay read-only, and a write sends nothing", async () => {
    const s = await started(1.17, "net_radio");
    expect(s.defs.get("living.player.repeat")?.common.write).toBe(false);
    void s.controller.handleWrite("player.repeat", 1);
    await flush();
    expect(s.client.calls.filter(c => c.method.startsWith("setNet"))).toEqual([]);
  });
});

// The group name is writable since YXC Advanced §5.6 documents setGroupName: UTF-8 within 128 bytes,
// "" restores the default (audit 2026-09-24, C8).
describe("YxcDeviceController group name", () => {
  const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };

  test("a written group name goes to the device and the distribution is read back", async () => {
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.group.name", "Wohnzimmer & Küche");
    await flush();
    expect(s.client.calls).toEqual([
      { method: "setGroupName", args: ["Wohnzimmer & Küche"] },
      { method: "getDistributionInfo", args: [] },
    ]);
  });

  test("a name over 128 UTF-8 bytes is not sent — the device's name is shown again", async () => {
    const s = setup(features, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("multiroom.group.name", "ü".repeat(65));
    await flush();
    expect(s.client.calls).toEqual([{ method: "getDistributionInfo", args: [] }]);
    expect(s.debugs.some(line => line.includes("longer than 128 bytes"))).toBe(true);
  });
});

// setFreq knows only "am" and "fm" (YXC Basic §6.4) — a frequency written while DAB plays went to the
// wrong band; DAB is tuned by service (§6.15), and switchPreset exists from API 1.17 (§6.6; C17).
describe("YxcDeviceController tuner on DAB", () => {
  const features = {
    zone: [{ id: "main", func_list: ["power"], input_list: ["tuner"] }],
    tuner: { func_list: ["fm", "dab"], preset: { type: "common", num: 30 } },
  };

  test("a frequency written while DAB plays is not sent, and the datapoint gets the device's value back", async () => {
    const s = setup(features, { power: "on", input: "tuner" });
    s.client.tunerPlayInfo = { band: "dab", dab: { freq: 180064 } };
    await s.controller.start();
    s.client.calls.length = 0;
    s.acks.length = 0;
    void s.controller.handleWrite("tuner.frequency", 98500);
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["getPlayInfo"]);
    expect(s.acks).toContainEqual({ id: "living.tuner.frequency", value: 180064 });
  });

  test("on FM the frequency is sent as before", async () => {
    const s = setup(features, { power: "on", input: "tuner" });
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("tuner.frequency", 98500);
    await flush();
    expect(s.client.calls[0]).toEqual({ method: "setFreq", args: ["fm", 98500] });
  });

  test("the DAB service buttons choose the next and previous station", async () => {
    const s = setup(features, { power: "on", input: "tuner" });
    await s.controller.start();
    expect(s.objects).toContain("living.tuner.dab.serviceUp");
    s.client.calls.length = 0;
    void s.controller.handleWrite("tuner.dab.serviceUp", true);
    void s.controller.handleWrite("tuner.dab.serviceDown", true);
    await flush();
    expect(s.client.calls.filter(c => c.method === "setDabService")).toEqual([
      { method: "setDabService", args: ["next"] },
      { method: "setDabService", args: ["previous"] },
    ]);
  });

  test("the preset step buttons exist from API 1.17 on", async () => {
    const older = setup(features, { power: "on", input: "tuner" });
    older.client.deviceInfo = { model_name: "WX-030", api_version: 1.16 };
    await older.controller.start();
    expect(older.objects).not.toContain("living.tuner.presetUp");
    const newer = setup(features, { power: "on", input: "tuner" });
    newer.client.deviceInfo = { model_name: "WX-030", api_version: 1.19 };
    await newer.controller.start();
    expect(newer.objects).toContain("living.tuner.presetUp");
    expect(newer.objects).toContain("living.tuner.presetDown");
  });
});

// A soundbar in standby reports volume and mute not operable (YSP-1600 capture: disable_flags 3; YXC
// Basic §5.1 b0 volume, b1 mute, b2 link audio delay) — each write drew a refusal and a warning (C27).
describe("YxcDeviceController disable_flags", () => {
  test("a write to a function the zone reports not operable is not sent; the zone is read back", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("volume", 20);
    void s.controller.handleWrite("mute", true);
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["getStatus", "getStatus"]);
    expect(s.warnings).toEqual([]);
    expect(s.debugs.filter(line => line.includes("not operable"))).toHaveLength(2);
  });

  test("once the device reports them operable again, they are written", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.client.status = { ...(ysp as Record<string, unknown>), power: "on", disable_flags: 0 };
    s.fire.push?.({ main: { power: "on" } });
    await flush();
    s.client.calls.length = 0;
    void s.controller.handleWrite("mute", true);
    await flush();
    expect(s.client.calls[0]).toEqual({ method: "mute", args: [true, "main"] });
  });

  test("a flag that does not name the written function blocks nothing", async () => {
    const s = setup(wx10, { ...(ysp as Record<string, unknown>), disable_flags: 0b100 });
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("mute", true);
    await flush();
    expect(s.client.calls[0]).toEqual({ method: "mute", args: [true, "main"] });
  });
});

// The names are the user's: remembered in the probe memory, a rename in the MusicCast app never reached
// the tree again, not even after a restart (audit 2026-09-24, C12). The input and program names the
// app shows were never used — a MusicCast-only device offered "hdmi1" (C24).
describe("YxcDeviceController names from the MusicCast app", () => {
  const features = {
    zone: [
      {
        id: "main",
        func_list: ["power", "sound_program"],
        input_list: ["hdmi1", "hdmi2", "net_radio"],
        sound_program_list: ["straight", "munich"],
      },
    ],
  };

  test("every connection reads the name afresh — a rename in the app arrives", async () => {
    const memory = new ProbeMemory();
    memory.set("name", "Wohnzimmer"); // what an older version remembered
    const first = setup(features, { power: "on", input: "hdmi1" });
    const client = first.client;
    client.nameText = { zone_list: [{ id: "main", text: "Wohnzimmer" }] };
    const run = async (): Promise<string[]> => {
      const names: string[] = [];
      const controller = new YxcDeviceController("living", {
        gate: testGate(),
        pushLiveness: new PushLiveness(),
        client,
        registerPush: () => () => {},
        scheduleKeepalive: () => () => {},
        upsertObject: () => Promise.resolve(),
        setStateAck: () => {},
        reportDeviceName: name => void names.push(name),
        log: silentLog,
        probeMemory: memory,
      });
      await controller.start();
      return names;
    };
    expect(await run()).toEqual(["Wohnzimmer"]);
    client.nameText = { zone_list: [{ id: "main", text: "Küche" }] };
    expect(await run()).toEqual(["Küche"]);
    expect(memory.remembered("name")).toBeUndefined();
  });

  test("the input and sound-program dropdowns carry the app's names; the value stays the id", async () => {
    const s = setup(features, { power: "on", input: "hdmi1", sound_program: "munich" });
    s.client.nameText = {
      zone_list: [{ id: "main", text: "Wohnzimmer" }],
      input_list: [
        { id: "hdmi1", text: "Apple TV" },
        { id: "hdmi2", text: " " },
      ],
      sound_program_list: [{ id: "munich", text: "Hall in Munich" }],
    };
    await s.controller.start();
    expect(s.defs.get("living.input")?.common.states).toEqual({
      hdmi1: "Apple TV",
      hdmi2: "HDMI2",
      net_radio: "NET RADIO",
    });
    expect(s.defs.get("living.soundProgram")?.common.states).toEqual({
      straight: "straight",
      munich: "Hall in Munich",
    });
  });

  test("a rename in the app reaches the label and the dropdowns on name_text_updated", async () => {
    const s = setup(features, { power: "on", input: "hdmi1" });
    s.client.nameText = {
      zone_list: [{ id: "main", text: "Wohnzimmer" }],
      input_list: [{ id: "hdmi1", text: "Apple TV" }],
    };
    await s.controller.start();
    s.names.length = 0;
    s.client.nameText = { zone_list: [{ id: "main", text: "Kino" }], input_list: [{ id: "hdmi1", text: "Beamer" }] };
    s.fire.push?.({ system: { name_text_updated: true } });
    await flush();
    await flush();
    expect(s.names).toEqual(["Kino"]);
    expect(s.defs.get("living.input")?.common.states).toMatchObject({ hdmi1: "Beamer" });
  });
});

describe("nameTextLabels", () => {
  it("maps ids to the names, leaving out empty ones and malformed entries", () => {
    expect(
      nameTextLabels({
        input_list: [{ id: "hdmi1", text: " Apple TV " }, { id: "hdmi2", text: "" }, { text: "no id" }, "junk"],
        sound_program_list: [{ id: "munich", text: "Hall in Munich" }],
      }),
    ).toEqual({ inputs: { hdmi1: "Apple TV" }, soundPrograms: { munich: "Hall in Munich" } });
    expect(nameTextLabels(null)).toEqual({ inputs: {}, soundPrograms: {} });
  });
});

describe("MusicCast lists as single datapoints and read-backs (audit 2026-09-29, C30/C38)", () => {
  test("the playlist names become slot datapoints next to the JSON list", async () => {
    const features = {
      response_code: 0,
      zone: [{ id: "main", func_list: ["power"], input_list: ["hdmi1"] }],
      netusb: { func_list: ["mc_playlist"] },
    };
    const s = setup(features, { response_code: 0, power: "on" });
    (s.client as unknown as Record<string, unknown>).getMcPlaylistName = (): Promise<unknown> =>
      Promise.resolve({ response_code: 0, name_list: ["Chill", "Rock"] });
    await s.controller.start();
    expect(s.acks).toEqual(
      expect.arrayContaining([
        { id: "living.player.netPlayer.playlistNames.1.name", value: "Chill" },
        { id: "living.player.netPlayer.playlistNames.2.name", value: "Rock" },
      ]),
    );
  });

  test("the group's clients become slot datapoints", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.multiroom.group.clients.1.ip", value: "1.2.3.5" });
  });

  test("the stored stations are also the JSON list", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power"] }],
      tuner: { func_list: ["fm"], preset: { type: "separate", num: 2 } },
    };
    const s = setup(features, ysp);
    s.client.tunerPresetInfo = { response_code: 0, preset_info: [{ band: "fm", number: 98100, text: "hr3" }] };
    await s.controller.start();
    const list = s.acks.find(ack => ack.id === "living.tuner.presets");
    expect(String(list?.value)).toContain("hr3");
  });

  test("a transport key is read back from the source the zone plays", async () => {
    const features = {
      response_code: 0,
      zone: [{ id: "main", func_list: ["power", "playback"], input_list: ["net_radio"] }],
      netusb: { func_list: ["play_queue"] },
    };
    const s = setup(features, { response_code: 0, power: "on", input: "net_radio" });
    // The network player reports what it plays — that is how the zone's input is its source.
    s.client.playInfo = { response_code: 0, input: "net_radio", playback: "play" };
    await s.controller.start();
    s.client.calls.length = 0;
    void s.controller.handleWrite("player.pause", true);
    await flush();
    await flush();
    expect(s.client.calls.some(c => c.method === "getPlayInfo")).toBe(true);
  });
});

describe("the play queue as single datapoints (readable values, 2026-09-30)", () => {
  test("the queue's tracks become slot datapoints beside its JSON; a track without a name is an empty slot", async () => {
    const features = {
      response_code: 0,
      zone: [{ id: "main", func_list: ["power"], input_list: ["net_radio"] }],
      netusb: { func_list: ["play_queue"] },
    };
    const s = setup(features, { response_code: 0, power: "on" });
    (s.client as unknown as Record<string, unknown>).getPlayQueue = (): Promise<unknown> =>
      Promise.resolve({ response_code: 0, max_line: 2, playing_index: 0, track_info: [{ text: "One" }, {}] });
    await s.controller.start();
    expect(s.acks).toEqual(
      expect.arrayContaining([
        { id: "living.player.netPlayer.queueTracks.1.name", value: "One" },
        { id: "living.player.netPlayer.queueTracks.2.name", value: "" },
      ]),
    );
  });

  test("the zone still recognises its network source when player.source shows the input's name", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], netusb: {} };
    const s = setup(features, { power: "on", input: "spotify" });
    s.client.playInfo = { input: "spotify", playback: "play", artist: "Band" };
    await s.controller.start();
    expect(s.acks).toContainEqual({ id: "living.player.source", value: "Spotify" });
    expect(s.acks).toContainEqual({ id: "living.player.artist", value: "Band" });
  });
});

// Every write path says what became of it: a forgotten `undefined` reads as "unclear" in the multi-transport handle,
// which then never tries the next protocol (Y-04) — on the RX-V6A MusicCast refuses setPartyMode and YNCA's
// @SYS:PARTY was never tried. A write the controller drops itself is `unavailable` with a debug line, never "sent"
// (review 2026-10-05, A3/A46).
describe("every write says what became of it (review 2026-10-05, A3/A46)", () => {
  const withSettings = async (failure?: Error): Promise<ReturnType<typeof setup>> => {
    const s = setup(rxV481, { power: "on", volume: 60, input: "hdmi1", actual_volume: { mode: "numeric", value: 30 } });
    s.client.funcStatus = { response_code: 0, party_mode: false, hdmi_out_1: true, speaker_a: true };
    await s.controller.start();
    s.client.failWrites = failure;
    s.client.calls.length = 0;
    return s;
  };

  test.each([
    ["refused", new YxcRefusalError("/system/setPartyMode?enable=true", 3), "refused"],
    [
      "answered with an HTTP error",
      new HttpStatusError("device refused /system/setPartyMode (HTTP 503)", 503),
      "refused",
    ],
    ["unanswered", new YxcTransportError("/system/setPartyMode", new Error("timeout")), "unavailable"],
  ] as const)("a device-wide setting %s says so, like a zone setting", async (_label, failure, expected) => {
    const s = await withSettings(failure);
    for (const id of ["multiroom.party", "hdmi.out1", "advanced.speakers.speakerA", "mute"]) {
      expect(await s.controller.handleWrite(id, true), id).toBe(expected);
    }
  });

  test("a device-wide setting the device took is sent and read back", async () => {
    const s = await withSettings();
    expect(await s.controller.handleWrite("multiroom.party", true)).toBe("sent");
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["setPartyMode", "getFuncStatus"]);
  });

  // An HTTP error status is the device's answer: a write is refused and read back, and nobody asks whether the
  // device is still there — it just answered.
  test("a write answered with an HTTP error status is refused and read back, no liveness check", async () => {
    const s = setup(wx10, { ...(ysp as Record<string, unknown>), power: "on", disable_flags: 0 });
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    s.client.failWrites = new HttpStatusError("device refused /main/setPower?power=standby (HTTP 503)", 503);
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("power", false)).toBe("refused");
    await flush();
    expect(s.client.calls.map(c => c.method)).toEqual(["power", "getStatus"]);
    expect(dropped).toBe(0);
  });

  test("a zone status answered with an HTTP error status is proof of life", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    let dropped = 0;
    s.controller.onDrop(() => dropped++);
    (s.client as unknown as { getStatus: () => Promise<never> }).getStatus = () =>
      Promise.reject(new HttpStatusError("device refused /main/getStatus (HTTP 503)", 503));
    for (let run = 0; run < 4; run++) {
      s.fire.keepalive?.();
      await flush();
    }
    await s.controller.verifyAlive();
    expect(dropped).toBe(0);
  });

  // The CD-NT670D plays the disc: repeat is set directly only on the network player (API 1.19+) — the write is
  // dropped, and says so.
  test("repeat on a CD is not sent — unavailable, with a debug line", async () => {
    const s = setup(cdNt670d, { response_code: 0, power: "on", volume: 20, mute: false, input: "cd" });
    s.client.deviceInfo = { model_name: "CD-NT670D", system_version: "1.0", api_version: 2.11 };
    await s.controller.start();
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("player.repeat", 2)).toBe("unavailable");
    await flush();
    expect(s.client.calls.filter(c => c.method.startsWith("set"))).toEqual([]);
    expect(s.debugs).toContainEqual("living: player.repeat not sent — only the network player sets it directly");
  });

  test("a transport key while the zone plays no media source is not sent — unavailable", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"] }], netusb: {} }, { power: "on", input: "hdmi1" });
    await s.controller.start();
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("player.play", true)).toBe("unavailable");
    expect(s.client.calls).toEqual([]);
    expect(s.debugs).toContainEqual("living: player.play not sent — main is not playing a media source");
  });

  test("an equalizer band without the other two reported is not sent — unavailable", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power", "equalizer"] }] }, { power: "on", equalizer: {} });
    await s.controller.start();
    expect(await s.controller.handleWrite("sound.equalizer.low", 3)).toBe("unavailable");
    expect(s.client.calls.some(c => c.method === "setEqualizer")).toBe(false);
  });

  test("the controller's other drops are unavailable and leave a trace", async () => {
    const features = {
      zone: [{ id: "main", func_list: ["power", "cursor", "volume"], cursor_list: ["up", "down"] }],
      distribution: { version: 2 },
    };
    const s = setup(features, { ...(ysp as Record<string, unknown>), disable_flags: 1 });
    await s.controller.start();
    s.client.calls.length = 0;
    s.debugs.length = 0;
    // a key the zone does not declare, a value no command takes, a function the zone reports not operable
    expect(await s.controller.handleWrite("remote.cursor", "left")).toBe("unavailable");
    expect(await s.controller.handleWrite("sleep", "soon")).toBe("unavailable");
    expect(await s.controller.handleWrite("volume", 20)).toBe("unavailable");
    // a menu write on a device without a menu, a group name that is no text, a partner nobody configured
    expect(await s.controller.handleWrite("player.browse.source", "netRadio")).toBe("unavailable");
    expect(await s.controller.handleWrite("multiroom.group.name", 7)).toBe("unavailable");
    expect(await s.controller.handleWrite("multiroom.group.linkDevice", "10.9.9.9")).toBe("unavailable");
    expect(s.client.calls.filter(c => c.method.startsWith("set") || c.method.startsWith("control"))).toEqual([]);
    expect(s.debugs.filter(line => line.includes("not sent") || line.includes("write dropped"))).toHaveLength(5);
  });

  test("a menu key is handed to the menu engine — its outcome cannot be said, so it is never repeated elsewhere", async () => {
    const s = setup({ zone: [{ id: "main", func_list: ["power"], input_list: ["net_radio"] }], netusb: {} }, ysp);
    await s.controller.start();
    expect(await s.controller.handleWrite("player.browse.source", "netRadio")).toBe("unclear");
  });

  test("the group writes say what became of them", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const s = setup(features, ysp);
    await s.controller.start();
    expect(await s.controller.handleWrite("multiroom.group.name", "Wohnzimmer")).toBe("sent");
    expect(await s.controller.handleWrite("multiroom.group.leave", true)).toBe("sent");
    s.client.failWrites = new YxcRefusalError("/dist/setGroupName", 5);
    expect(await s.controller.handleWrite("multiroom.group.name", "Küche")).toBe("refused");
  });
});

// One resolution for a scene write on all three protocols: a whole number of 1 or more, or a title. MusicCast — the
// first owner of `scene.recall` wherever it answers — recalled scene 2 for 1.5 and sent recallScene(0) for 0, while
// YNCA and XML dropped both (review 2026-10-05, A26).
describe("a scene write resolves the same way as on YNCA and XML (review 2026-10-05, A26)", () => {
  const features = { zone: [{ id: "main", func_list: ["power", "scene"], input_list: ["hdmi1"], scene_num: 8 }] };

  test.each([1.5, 0, -1, "1.5", "", true])("%j names no scene: nothing is sent, the write says so", async value => {
    const s = setup(features, { power: "on", input: "hdmi1" });
    await s.controller.start();
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("scene.recall", value)).toBe("unavailable");
    expect(s.client.calls.filter(c => c.method === "recallScene")).toEqual([]);
    expect(
      s.debugs.some(line => line.startsWith(`living: scene "${String(value)}" is not one this device declares`)),
    ).toBe(true);
  });

  test("a whole number, as number or text, recalls that scene", async () => {
    const s = setup(features, { power: "on", input: "hdmi1" });
    await s.controller.start();
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("scene.recall", 2)).toBe("sent");
    expect(await s.controller.handleWrite("scene.recall", " 3 ")).toBe("sent");
    expect(s.client.calls.filter(c => c.method === "recallScene")).toEqual([
      { method: "recallScene", args: [2, "main"] },
      { method: "recallScene", args: [3, "main"] },
    ]);
  });
});

// A script linking kitchen and bath wrote multiroom.group.linkDevice twice in a row: both writes read "no group yet"
// and drew their own random group id, so the kitchen ended in an orphaned group (review 2026-10-05, A14).
describe("MusicCast Link changes wait for each other (review 2026-10-05, A14)", () => {
  test("two linkDevice writes in a row build ONE group", async () => {
    const features = { zone: [{ id: "main", func_list: ["power"] }], distribution: { version: 2 } };
    const kitchen = makeFakeClient(wx30, {});
    const bath = makeFakeClient(wx30, {});
    const s = setup(features, ysp, { "10.0.0.3": kitchen, "10.0.0.4": bath }, undefined, { host: "10.0.0.1" });
    s.client.distRole = "none";
    await s.controller.start();
    let roster: string[] = [];
    (s.client as unknown as Record<string, unknown>).setServerInfo = (info: {
      group_id: string;
      client_list?: string[];
    }): Promise<unknown> => {
      roster = [...roster, ...(info.client_list ?? [])];
      s.client.distInfo = {
        role: "server",
        group_id: info.group_id,
        client_list: roster.map(ip => ({ ip_address: ip })),
        status: "working",
      };
      return Promise.resolve({ response_code: 0 });
    };
    const outcomes = await Promise.all([
      s.controller.handleWrite("multiroom.group.linkDevice", "10.0.0.3"),
      s.controller.handleWrite("multiroom.group.linkDevice", "10.0.0.4"),
    ]);
    await flush();
    expect(outcomes).toEqual(["sent", "sent"]);
    const groupOf = (device: FakeClient): unknown =>
      (device.calls.find(c => c.method === "setClientInfo")?.args[0] as { group_id: string } | undefined)?.group_id;
    expect(groupOf(kitchen)).toMatch(/^[0-9A-F]{32}$/);
    expect(groupOf(bath)).toBe(groupOf(kitchen));
    expect(roster).toEqual(["10.0.0.3", "10.0.0.4"]);
  });
});

// Zone 2 in standby, its input still on the old net_radio: the favourite went to zone 2 (review 2026-10-05, A45).
describe("a recall goes to a switched-on zone (review 2026-10-05, A45)", () => {
  test("a favourite does not go to a zone in standby whose old input matches the network source", async () => {
    const s = setup(rxV481, { power: "on", volume: 60, input: "hdmi1", actual_volume: { mode: "numeric", value: 30 } });
    s.client.statusByZone = {
      main: { power: "on", volume: 60, input: "hdmi1", actual_volume: { mode: "numeric", value: 30 } },
      zone2: { power: "standby", volume: 81, input: "net_radio", actual_volume: { mode: "numeric", value: 40.5 } },
    };
    s.client.playInfo = { input: "net_radio", playback: "stop" };
    await s.controller.start();
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("player.netPlayer.preset", 3)).toBe("sent");
    expect(s.client.calls.find(c => c.method === "recallPreset")?.args).toEqual([3, "main"]);
    // Switched on, zone 2 is the one listening.
    s.client.statusByZone = {
      ...s.client.statusByZone,
      zone2: { power: "on", volume: 81, input: "net_radio", actual_volume: { mode: "numeric", value: 40.5 } },
    };
    s.fire.push?.({ zone2: { power: "on" } });
    await flush();
    s.client.calls.length = 0;
    await s.controller.handleWrite("player.netPlayer.preset", 3);
    expect(s.client.calls.find(c => c.method === "recallPreset")?.args).toEqual([3, "zone2"]);
  });
});

// The YSP-1600 reports disable_flags 3 (volume and mute not operable) in standby. A script writing "power on, then
// volume" had its volume dropped on the remembered standby flags — push working or not (review 2026-10-05, A18).
describe("a stale standby flag is checked against the zone first (review 2026-10-05, A18)", () => {
  test("power on, then volume: the volume goes out once the zone says it is operable", async () => {
    const s = setup(wx10, ysp, {}, () => true);
    await s.controller.start();
    (s.client as unknown as Record<string, unknown>).power = (on: boolean): Promise<unknown> => {
      s.client.status = on ? { ...(ysp as Record<string, unknown>), power: "on", disable_flags: 0 } : ysp;
      s.client.calls.push({ method: "power", args: [on, "main"] });
      return Promise.resolve({ response_code: 0 });
    };
    s.client.calls.length = 0;
    const [power, volume] = await Promise.all([
      s.controller.handleWrite("power", true),
      s.controller.handleWrite("volume", 25),
    ]);
    expect([power, volume]).toEqual(["sent", "sent"]);
    expect(s.client.calls).toContainEqual({ method: "setVolumeTo", args: [25, "main"] });
    expect(s.debugs.some(line => line.includes("not operable"))).toBe(false);
  });

  test("a zone still in standby keeps the function closed — not sent, the device's value back", async () => {
    const s = setup(wx10, ysp);
    await s.controller.start();
    s.acks.length = 0;
    s.client.calls.length = 0;
    expect(await s.controller.handleWrite("volume", 25)).toBe("unavailable");
    expect(s.client.calls.map(c => c.method)).toEqual(["getStatus"]);
    expect(s.acks).toContainEqual({ id: "living.volume", value: 30 });
  });
});

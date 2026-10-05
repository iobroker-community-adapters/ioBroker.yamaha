import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YxcDeviceController } from "./device-controller";
import { CommandGate } from "../lifecycle/command-gate";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";
import { PushLiveness } from "./push-liveness";
import type { ObjectDef } from "../catalog/types";
import { TransportConnectionAdapter } from "../lifecycle/transport-connection-adapter";
import { presentSystemEntries, systemWrite, YXC_SYSTEM_CATALOG } from "./system-catalog";
import { tName } from "../i18n";

/**
 * Regression tests of the MusicCast data layer's findings of the code review 2026-10-05 — each one the review's proof
 * test with its expectation inverted, driven through the real controller against the RX-V6A's recorded answers.
 */

const RXV6A = JSON.parse(readFileSync(join(__dirname, "../../../test/fixtures/inventory/rxv6a.json"), "utf8")) as {
  yxc: { answers: Record<string, unknown> };
};

/**
 * A client answering from a fixture's recorded answers, recording every call as [method, args].
 *
 * @param answers the recorded answers by endpoint (`system/getFeatures`, `main/getStatus`, …)
 * @returns the client and its calls
 */
function fixtureClient(answers: Record<string, unknown>): { client: never; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const reply = (method: string, args: unknown[]): unknown => {
    switch (method) {
      case "getFeatures":
        return answers["system/getFeatures"];
      case "getDeviceInfo":
        return answers["system/getDeviceInfo"];
      case "getNameText":
        return answers["system/getNameText"];
      case "getFuncStatus":
        return answers["system/getFuncStatus"];
      case "getStatus":
        return answers[`${String(args[0])}/getStatus`];
      case "getPlayInfo":
        return answers[args[0] === "tuner" ? "tuner/getPlayInfo" : "netusb/getPlayInfo"];
      case "getDistributionInfo":
        return answers["dist/getDistributionInfo"];
      case "getSignalInfo":
        return answers[`${String(args[0])}/getSignalInfo`];
      default:
        return undefined;
    }
  };
  const client = new Proxy(
    {},
    {
      // `forUser` (the user-priority twin of the read-back, review 2026-10-05, A58) is this same recording client.
      get: (_target, method: string, receiver: unknown) =>
        method === "then"
          ? undefined
          : method === "forUser"
            ? (): unknown => receiver
            : (...args: unknown[]): Promise<unknown> => {
                calls.push([method, args]);
                return Promise.resolve(reply(method, args) ?? { response_code: 0 });
              },
    },
  );
  return { client: client as never, calls };
}

/**
 * Start a controller on a fixture's answers.
 *
 * @param answers the recorded answers
 * @returns the controller, the client's calls and the objects it built
 */
async function startController(answers: Record<string, unknown>): Promise<{
  controller: YxcDeviceController;
  calls: Array<[string, unknown[]]>;
  defs: Map<string, ObjectDef>;
}> {
  const { client, calls } = fixtureClient(answers);
  const defs = new Map<string, ObjectDef>();
  const controller = new YxcDeviceController("rx", {
    client,
    clientFor: () => undefined,
    partnerIps: () => [],
    gate: new CommandGate({
      minSpacingMs: 0,
      timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
    }),
    probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
    pushLiveness: new PushLiveness(),
    registerPush: () => () => undefined,
    scheduleKeepalive: () => () => undefined,
    upsertObject: (id: string, def: ObjectDef) => {
      defs.set(id, def);
      return Promise.resolve();
    },
    setStateAck: () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
  });
  expect(await controller.start()).toBe(true);
  return { controller, calls, defs };
}

describe("review 2026-10-05 — the MusicCast write mapping through the controller", () => {
  // A26: the review's cross/scene-number proof — MusicCast, first owner of `scene.recall`, recalled scene 2 for 1.5
  // and sent recallScene(0) for 0, where the shared resolver of YNCA and XML drops both.
  test("scene.recall 1.5 and 0 reach no device", async () => {
    const { controller, calls } = await startController(RXV6A.yxc.answers);
    calls.length = 0;
    expect(await controller.handleWrite("scene.recall", 1.5)).toBe("unavailable");
    expect(await controller.handleWrite("scene.recall", 0)).toBe("unavailable");
    expect(calls.filter(([method]) => method === "recallScene")).toEqual([]);
    expect(await controller.handleWrite("scene.recall", 2)).toBe("sent");
    expect(calls.filter(([method]) => method === "recallScene")).toEqual([["recallScene", [2, "main"]]]);
    controller.close();
  });

  // A49: the review's yxc-data/volume-unsettled proof — a seek read the main zone back, not the network player.
  test("a seek reads the network player's play info back, not the main zone", async () => {
    const { controller, calls } = await startController(RXV6A.yxc.answers);
    calls.length = 0;
    expect(await controller.handleWrite("player.netPlayer.playPosition", 30)).toBe("sent");
    await vi.waitFor(() => expect(calls.map(([method]) => method)).toContain("getPlayInfo"));
    expect(calls[0]).toEqual(["setPlayPosition", [30]]);
    expect(calls.filter(([method, args]) => method === "getStatus" && args[0] === "main")).toEqual([]);
    controller.close();
  });
});

// A16: `multiroom.zoneB.volumeSync` is a device-wide setting written in tree form; the transport adapter must hand the
// write on under that id (CORE's part). The entry itself reads and writes the one getFuncStatus pair.
describe("review 2026-10-05 — Zone B on MusicCast", () => {
  test("multiroom.zoneB.volumeSync maps to zone_b_volume_sync both ways", async () => {
    const entry = YXC_SYSTEM_CATALOG.find(candidate => candidate.state === "multiroom.zoneB.volumeSync");
    expect(entry?.field).toBe("zone_b_volume_sync");
    expect(presentSystemEntries({ zone_b_volume_sync: false }).map(e => e.state)).toEqual([
      "multiroom.zoneB.volumeSync",
    ]);
    expect(entry?.fromStatus(true)).toBe(true);
    const calls: Array<[string, unknown[]]> = [];
    const client = new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          (...args: unknown[]): Promise<unknown> => {
            calls.push([method, args]);
            return Promise.resolve({ response_code: 0 });
          },
      },
    );
    await systemWrite(entry!, "on").run?.(client as never);
    expect(calls).toEqual([["setZoneBVolumeSync", [true]]]);
  });

  // An RX-V481 serves its Zone B as `zone2` (YXC Basic Rev 1.10 §4.2): under `multiroom.zoneB` its datapoints keep the
  // zone form — the zone's power switch, named "Power" — as YNCA and XML build Zone B now (review, A27).
  test("the RX-V481's Zone B keeps the zone form under multiroom.zoneB", async () => {
    const answers = {
      "system/getFeatures": JSON.parse(readFileSync(join(__dirname, "__fixtures__", "RX_V481_285_208.json"), "utf8")),
      "system/getDeviceInfo": { response_code: 0, model_name: "RX-V481", api_version: 2.0 },
      "main/getStatus": { response_code: 0, power: "on", volume: 60, mute: false, input: "hdmi1" },
      "zone2/getStatus": { response_code: 0, power: "standby", volume: 40, mute: false, input: "net_radio" },
    };
    const { client } = fixtureClient(answers);
    const adapter = new TransportConnectionAdapter("yxc", "rx", () => undefined);
    adapter.bind(
      new YxcDeviceController("rx", {
        client,
        aliasZone: (from, to) => adapter.aliasZone(from, to),
        gate: new CommandGate({
          minSpacingMs: 0,
          timers: {
            schedule: (h, ms) => setTimeout(h, ms),
            cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>),
          },
        }),
        probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
        pushLiveness: new PushLiveness(),
        registerPush: () => () => undefined,
        scheduleKeepalive: () => () => undefined,
        upsertObject: adapter.interceptUpsert,
        setStateAck: adapter.interceptSetStateAck,
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      }),
    );
    expect(await adapter.connect()).toBe(true);
    const objects = adapter.buildObjects();
    const power = objects.find(o => o.id === "multiroom.zoneB.power");
    expect(power?.common.role).toBe("switch.power.zone");
    expect(power?.common.name).toEqual(tName("power"));
    expect(objects.find(o => o.id === "multiroom.zoneB.volume")?.common.role).toBe("level.volume");
    expect(objects.some(o => o.id.startsWith("multiroom.zone2."))).toBe(false);
    adapter.close();
  });
});

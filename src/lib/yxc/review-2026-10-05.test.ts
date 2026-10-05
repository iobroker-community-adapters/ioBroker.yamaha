import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YxcDeviceController } from "./device-controller";
import { CommandGate } from "../lifecycle/command-gate";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";
import { PushLiveness } from "./push-liveness";
import type { ObjectDef } from "../catalog/types";

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
      get: (_target, method: string) =>
        method === "then"
          ? undefined
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

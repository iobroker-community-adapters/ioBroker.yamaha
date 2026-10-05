import { LinkGroup } from "./link-group";
import { distributionSummary } from "./command-mapper";
import type { YxcClientLike } from "./client-contract";
import { CommandGate } from "../lifecycle/command-gate";
import wx30 from "./__fixtures__/WX30_317_208.json";

const flush = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * A command gate whose waits end only when the test says so (the group build's read-back pacing).
 *
 * @returns the gate and a function that lets every pending wait end
 */
function manualGate(): { gate: CommandGate; elapse: () => Promise<void> } {
  const pending: Array<() => void> = [];
  const gate = new CommandGate({ minSpacingMs: 0, timers: { schedule: h => pending.push(h), cancel: () => {} } });
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

/** One recorded client call, on any device. */
interface Call {
  device: string;
  method: string;
  args: unknown[];
}

/**
 * A recording client for one device; `replies` answer by method name.
 *
 * @param device the name the calls are recorded under
 * @param calls where the calls go (shared across devices, so their order shows)
 * @param replies the answers by method
 * @returns the client
 */
function recording(
  device: string,
  calls: Call[],
  replies: Record<string, (args: unknown[]) => unknown> = {},
): YxcClientLike {
  return new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]): Promise<unknown> => {
          calls.push({ device, method, args });
          try {
            return Promise.resolve(replies[method]?.(args) ?? { response_code: 0 });
          } catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
    },
  ) as YxcClientLike;
}

/**
 * A server device whose distribution follows what it is told: setServerInfo builds its roster, the build reports
 * `status` (working unless the test says otherwise).
 *
 * @param partners the configured partner devices by address
 * @param gate the gate
 * @returns the link group, the shared call log and the server's group state
 */
function server(
  partners: Record<string, YxcClientLike>,
  gate: CommandGate = new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  }),
): {
  group: LinkGroup;
  calls: Call[];
  state: { groupId: string; roster: string[]; status: string };
  gate: CommandGate;
} {
  const calls: Call[] = [];
  const state = { groupId: "", roster: [] as string[], status: "working" };
  const client = recording("server", calls, {
    getDistributionInfo: () => ({
      response_code: 0,
      role: state.groupId ? "server" : "none",
      group_id: state.groupId,
      client_list: state.roster.map(ip => ({ ip_address: ip })),
      status: state.status,
    }),
    setServerInfo: ([info]) => {
      const {
        group_id: id,
        client_list: list = [],
        type,
      } = info as {
        group_id: string;
        client_list?: string[];
        type?: string;
      };
      state.groupId = id;
      state.roster =
        id === "" ? [] : type === "remove" ? state.roster.filter(ip => !list.includes(ip)) : [...state.roster, ...list];
      return { response_code: 0 };
    },
  });
  let dist = distributionSummary(undefined);
  const group = new LinkGroup({
    deviceId: "living",
    client,
    clientFor: ip => partners[ip],
    partnerIps: () => Object.keys(partners),
    host: "10.0.0.1",
    gate,
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    refresh: async () => {
      dist = distributionSummary(await client.getDistributionInfo());
      return dist;
    },
    summary: () => dist,
    features: () => ({ version: 2, compatibleClients: [2] }),
  });
  return { group, calls, state, gate };
}

describe("LinkGroup — one change at a time (review 2026-10-05, A14)", () => {
  // Unqueued, both writes read "no group yet" and drew a random group id each: the kitchen ended in an orphaned
  // group, and the build was polled for three minutes without a word.
  test("two quick links put both devices into ONE group", async () => {
    const calls: Call[] = [];
    const kitchen = recording("kitchen", calls, { getFeatures: () => wx30 });
    const bath = recording("bath", calls, { getFeatures: () => wx30 });
    const s = server({ "10.0.0.3": kitchen, "10.0.0.4": bath });
    const outcomes = await Promise.all([s.group.link("10.0.0.3"), s.group.link("10.0.0.4")]);
    await flush();
    expect(outcomes).toEqual(["sent", "sent"]);
    const groupOf = (device: string): unknown =>
      (calls.find(c => c.device === device && c.method === "setClientInfo")?.args[0] as { group_id: string }).group_id;
    expect(groupOf("kitchen")).toMatch(/^[0-9A-F]{32}$/);
    expect(groupOf("bath")).toBe(groupOf("kitchen"));
    expect(s.state.groupId).toBe(groupOf("kitchen"));
    expect(s.state.roster).toEqual(["10.0.0.3", "10.0.0.4"]);
    // The second joins a group of one: distribution number 1 (YXC Advanced §9.1.4).
    expect(s.calls.filter(c => c.method === "startDistribution").map(c => c.args[0])).toEqual([0, 1]);
  });

  test("a leave right after a link waits for it — and leaves the group the link built", async () => {
    const calls: Call[] = [];
    const kitchen = recording("kitchen", calls, { getFeatures: () => wx30 });
    const s = server({ "10.0.0.3": kitchen });
    const [linked, left] = await Promise.all([s.group.link("10.0.0.3"), s.group.leave()]);
    expect([linked, left]).toEqual(["sent", "sent"]);
    const order = s.calls.map(c => c.method);
    expect(order.indexOf("stopDistribution")).toBeGreaterThan(order.indexOf("startDistribution"));
    // The server's clean-up, and its configured client released — not a client's leave.
    expect(s.calls).toContainEqual({ device: "server", method: "setServerInfo", args: [{ group_id: "" }] });
    expect(calls.filter(c => c.device === "kitchen" && c.method === "setClientInfo").at(-1)?.args).toEqual([
      { group_id: "" },
    ]);
    expect(s.state.groupId).toBe("");
  });

  // The device answers a change during the build with "Linking in progress" (response code 200): the queue waits
  // until the group works, while the link itself is answered at once.
  test("a link holds the queue until its group works; its own answer does not wait", async () => {
    const calls: Call[] = [];
    const kitchen = recording("kitchen", calls, { getFeatures: () => wx30 });
    const { gate, elapse } = manualGate();
    const s = server({ "10.0.0.3": kitchen }, gate);
    s.state.status = "building";
    const linked = s.group.link("10.0.0.3");
    const renamed = s.group.rename("Wohnzimmer");
    expect(await linked).toBe("sent");
    await flush();
    expect(s.calls.some(c => c.method === "setGroupName")).toBe(false);
    s.state.status = "working";
    await elapse();
    expect(await renamed).toBe("sent");
    expect(s.calls.some(c => c.method === "setGroupName")).toBe(true);
  });

  test("a change still queued when the connection closes is not sent", async () => {
    const calls: Call[] = [];
    const kitchen = recording("kitchen", calls, { getFeatures: () => wx30 });
    const { gate } = manualGate();
    const s = server({ "10.0.0.3": kitchen }, gate);
    s.state.status = "building";
    const linked = s.group.link("10.0.0.3");
    const left = s.group.leave();
    expect(await linked).toBe("sent");
    gate.close();
    expect(await left).toBe("unavailable");
    expect(s.calls.some(c => c.method === "stopDistribution")).toBe(false);
  });

  test("the leave a client owes after its input change is skipped when a change before it already left", async () => {
    const calls: Call[] = [];
    let groupId = "9A237BF5AB80ED3C7251DFF49825CA42";
    const client = recording("client", calls, {
      getDistributionInfo: () => ({ response_code: 0, role: groupId ? "client" : "none", group_id: groupId }),
      setClientInfo: ([info]) => {
        groupId = (info as { group_id: string }).group_id;
        return { response_code: 0 };
      },
    });
    let dist = distributionSummary({ role: "client", group_id: groupId });
    const group = new LinkGroup({
      deviceId: "kitchen",
      client,
      gate: manualGate().gate,
      log: { debug: () => {}, info: () => {}, warn: () => {} },
      refresh: async () => {
        dist = distributionSummary(await client.getDistributionInfo());
        return dist;
      },
      summary: () => dist,
      features: () => undefined,
    });
    expect(await group.leave()).toBe("sent");
    group.leaveAfterInputChange();
    await flush();
    expect(calls.filter(c => c.method === "setClientInfo")).toHaveLength(1);
  });
});

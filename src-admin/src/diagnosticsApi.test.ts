import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceListError,
  InstanceUnavailableError,
  isReport,
  makeDiagnosticsApi,
  type DiagnosticsSocket,
  type StateHandler,
} from "./diagnosticsApi";

/**
 * A socket whose instance never answers, with the instance's `alive` state under the test's control.
 *
 * @param alive the value the subscription reports first (undefined: it reports nothing)
 */
function silentInstance(alive?: boolean): {
  socket: DiagnosticsSocket;
  setAlive(val: boolean): void;
  watchers: Set<StateHandler>;
} {
  const watchers = new Set<StateHandler>();
  return {
    watchers,
    setAlive: val => watchers.forEach(handler => handler("system.adapter.yamaha.0.alive", { val })),
    socket: {
      sendTo: () => new Promise(() => {}),
      subscribeState: (id, handler) => {
        expect(id).toBe("system.adapter.yamaha.0.alive");
        watchers.add(handler);
        // Like the admin connection: the current value first, after a round trip.
        return alive === undefined ? undefined : Promise.resolve().then(() => handler(id, { val: alive }));
      },
      unsubscribeState: (_id, handler) => {
        watchers.delete(handler!);
      },
    },
  };
}

function socketReturning(value: unknown): { socket: DiagnosticsSocket; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    socket: {
      sendTo: (instance: string, command: string, data: unknown) => {
        calls.push([instance, command, data]);
        return Promise.resolve(value);
      },
    },
  };
}

describe("makeDiagnosticsApi", () => {
  it("asks the instance for its devices", async () => {
    const { socket, calls } = socketReturning({ devices: [{ value: "rx-v6a-2b3c", label: "RX", connected: true }] });
    const devices = await makeDiagnosticsApi(socket, "yamaha.1").listDevices();
    expect(calls[0]).toEqual(["yamaha.1", "diagnostics", { action: "list" }]);
    expect(devices).toHaveLength(1);
  });

  it("tells a broken list call apart from an empty list", async () => {
    await expect(
      makeDiagnosticsApi(socketReturning(undefined).socket, "yamaha.0").listDevices(),
    ).rejects.toBeInstanceOf(DeviceListError);
    const failing: DiagnosticsSocket = { sendTo: () => Promise.reject(new Error("no connection")) };
    await expect(makeDiagnosticsApi(failing, "yamaha.0").listDevices()).rejects.toThrow("no connection");
    expect(await makeDiagnosticsApi(socketReturning({ devices: [] }).socket, "yamaha.0").listDevices()).toEqual([]);
  });

  it("passes the selected device to the export and hands the answer back", async () => {
    const { socket, calls } = socketReturning({ fileName: "f.json", content: "{}" });
    const res = await makeDiagnosticsApi(socket, "yamaha.0").exportReport("rx-v6a-2b3c");
    expect(calls[0]).toEqual(["yamaha.0", "diagnostics", { action: "export", device: "rx-v6a-2b3c" }]);
    expect(isReport(res) && res.fileName).toBe("f.json");
  });

  it("turns a shapeless answer into an error, never into an empty download", async () => {
    const res = await makeDiagnosticsApi(socketReturning("nonsense").socket, "yamaha.0").exportReport("x");
    expect(isReport(res)).toBe(false);
  });

  it("hands on the error the adapter answers instead of a list", async () => {
    const api = makeDiagnosticsApi(socketReturning({ error: "diagnostics failed: boom" }).socket, "yamaha.0");
    await expect(api.listDevices()).rejects.toThrow(new DeviceListError("diagnostics failed: boom"));
  });
});

// Review 2026-10-05, B2: `sendTo` of the admin connection never times out — a stopped instance kept the card
// loading for good, a restart during a report kept its button locked.
describe("askInstance (through the API)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says at once that the instance is not running, instead of waiting for its answer", async () => {
    const { socket, watchers } = silentInstance(false);
    const list = makeDiagnosticsApi(socket, "yamaha.0").listDevices();
    await expect(list).rejects.toEqual(new InstanceUnavailableError("notRunning"));
    expect(watchers.size).toBe(0);
  });

  it("ends a report's wait when the instance stops (or restarts) in the middle of it", async () => {
    const { socket, setAlive, watchers } = silentInstance(true);
    const report = makeDiagnosticsApi(socket, "yamaha.0").exportReport("rx-v6a-2b3c");
    await Promise.resolve();
    await Promise.resolve();
    setAlive(false);
    await expect(report).rejects.toMatchObject({ reason: "stopped" });
    expect(watchers.size).toBe(0);
  });

  it("gives up after the timeout when the instance runs but does not answer", async () => {
    vi.useFakeTimers();
    const { socket, watchers } = silentInstance(true);
    const report = makeDiagnosticsApi(socket, "yamaha.0", { listMs: 15_000, exportMs: 180_000 }).exportReport("x");
    const verdict = expect(report).rejects.toEqual(new InstanceUnavailableError("noAnswer", 180));
    await vi.advanceTimersByTimeAsync(180_000);
    await verdict;
    expect(watchers.size).toBe(0);
  });

  it("gives up after the timeout on a socket without a state subscription", async () => {
    vi.useFakeTimers();
    const socket: DiagnosticsSocket = { sendTo: () => new Promise(() => {}) };
    const list = makeDiagnosticsApi(socket, "yamaha.0", { listMs: 15_000, exportMs: 180_000 }).listDevices();
    const verdict = expect(list).rejects.toMatchObject({ reason: "noAnswer", seconds: 15 });
    await vi.advanceTimersByTimeAsync(15_000);
    await verdict;
  });

  it("stops watching the instance once the answer is there", async () => {
    const watchers = new Set<StateHandler>();
    const socket: DiagnosticsSocket = {
      sendTo: () => Promise.resolve({ devices: [] }),
      subscribeState: (_id, handler) => {
        watchers.add(handler);
      },
      unsubscribeState: (_id, handler) => {
        watchers.delete(handler!);
      },
    };
    expect(await makeDiagnosticsApi(socket, "yamaha.0").listDevices()).toEqual([]);
    expect(watchers.size).toBe(0);
  });
});

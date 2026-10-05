import { describe, expect, it } from "vitest";
import { DeviceListError, isReport, makeDiagnosticsApi, type DiagnosticsSocket } from "./diagnosticsApi";

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
});

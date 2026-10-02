import { describe, expect, test, vi } from "vitest";

// Y-13: before a device is deleted the admin asks, and says that its datapoints go with it. Then it is gone for good —
// excluded from every later search — and one log line names the device and the number of datapoints deleted.

vi.mock("@iobroker/adapter-core", () => ({
  Adapter: class {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "yamaha.0";
    public config: Record<string, unknown> = {};
    public objects = new Map<string, Record<string, unknown>>();
    public on = vi.fn();
    public getAdapterObjectsAsync = vi.fn(() => {
      const out: Record<string, unknown> = {};
      for (const [id, object] of this.objects) {
        out[`yamaha.0.${id}`] = structuredClone(object);
      }
      return Promise.resolve(out);
    });
    public delObjectAsync = vi.fn((id: string, options?: { recursive?: boolean }) => {
      const key = id.replace("yamaha.0.", "");
      for (const existing of [...this.objects.keys()]) {
        if (existing === key || (options?.recursive && existing.startsWith(`${key}.`))) {
          this.objects.delete(existing);
        }
      }
      return Promise.resolve();
    });
    public setState = vi.fn(() => Promise.resolve());
    public setStateChangedAsync = vi.fn(() => Promise.resolve({ notChanged: false }));
    public setTimeout = vi.fn(() => ({ kind: "timeout" }));
    public clearTimeout = vi.fn();
    constructor(_opts: unknown) {}
  },
  I18n: { init: vi.fn(() => Promise.resolve(undefined)) },
  getAbsoluteInstanceDataDir: () => "/tmp/yamaha-data",
}));

const files = vi.hoisted(() => ({
  discovered: [] as Array<{ id: string; ip: string; identity?: { serial?: string } }>,
  excluded: [] as Array<{ id: string; ip?: string; identity?: { serial?: string } }>,
}));
vi.mock("../lib/discovered-store", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    isExcluded: real.isExcluded,
    readDiscovered: vi.fn(() => Promise.resolve(files.discovered)),
    writeDiscovered: vi.fn((_deps: unknown, devices: typeof files.discovered) => {
      files.discovered = devices;
      return Promise.resolve();
    }),
    readIgnored: vi.fn(() => Promise.resolve([])),
    writeIgnored: vi.fn(() => Promise.resolve()),
    readExcluded: vi.fn(() => Promise.resolve(files.excluded)),
    writeExcluded: vi.fn((_deps: unknown, entries: typeof files.excluded) => {
      files.excluded = [...entries];
      return Promise.resolve();
    }),
  };
});
vi.mock("../lib/discovered-store-deps", () => ({
  discoveredStoreDeps: () => ({}),
  ignoredStoreDeps: () => ({}),
  excludedStoreDeps: () => ({}),
}));

import { Yamaha } from "../main";
import { YamahaDeviceManagement } from "../device-management";
import { isExcluded } from "../lib/discovered-store";

interface Action {
  id: string;
  confirmation?: unknown;
}

function managerOver(owner: { removeDevice: ReturnType<typeof vi.fn> }): YamahaDeviceManagement {
  const adapter = {
    namespace: "yamaha.0",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn(),
    setTimeout: vi.fn(() => ({ kind: "timeout" })),
    getForeignObjectAsync: vi.fn((id: string) =>
      Promise.resolve(
        id === "system.adapter.yamaha.0"
          ? { native: { devices: [] } }
          : { common: { name: "Kitchen" }, native: { identity: { serial: "0B11AA2B3C" } } },
      ),
    ),
    getForeignStateAsync: vi.fn(() => Promise.resolve(null)),
    extendForeignObjectAsync: vi.fn(() => Promise.resolve()),
    writeDeviceObject: vi.fn(() => Promise.resolve()),
    removeDevice: owner.removeDevice,
    rediscoverNow: vi.fn(),
    setVolumePercent: vi.fn(() => Promise.resolve()),
  };
  return new YamahaDeviceManagement(adapter as never);
}

describe("Y-13 delete asks first, then the device is gone for good, with one log line", () => {
  test("the delete action asks before it runs, and the question says the datapoints go with the device", async () => {
    files.discovered = [{ id: "wx-030-2b3c", ip: "10.0.0.5" }];
    const dm = managerOver({ removeDevice: vi.fn(() => Promise.resolve()) });
    const cards: Array<{ actions: Action[] }> = [];
    await (dm as unknown as { loadDevices(ctx: unknown): Promise<void> }).loadDevices({
      addDevice: (card: { actions: Action[] }) => cards.push(card),
      setTotalDevices: () => undefined,
    });
    const del = cards[0]?.actions.find(action => action.id === "delete");
    const question = (del?.confirmation as { en?: string } | undefined)?.en ?? "";
    expect(question).toMatch(/delete/i);
    expect(question).toMatch(/datapoints/i);
  });

  test("deleted means gone for good: removed, forgotten and kept out of every later search", async () => {
    files.discovered = [{ id: "wx-030-2b3c", ip: "10.0.0.5", identity: { serial: "0B11AA2B3C" } }];
    files.excluded = [];
    const removeDevice = vi.fn(() => Promise.resolve());
    const dm = managerOver({ removeDevice });
    await (dm as unknown as { deleteDevice(id: string): Promise<unknown> }).deleteDevice("wx-030-2b3c");
    expect(removeDevice).toHaveBeenCalledWith("wx-030-2b3c");
    expect(files.discovered).toEqual([]);
    // Found again — under its old address or a new one — it does not come back.
    expect(isExcluded([], files.excluded, { id: "wx-030-2b3c", ip: "10.0.0.5" })).toBe(true);
    expect(isExcluded([], files.excluded, { id: "other", ip: "10.0.0.99", identity: { serial: "0B11AA2B3C" } })).toBe(
      true,
    );
  });

  test("one log line names the device and the number of datapoints deleted", async () => {
    const adapter = new Yamaha() as unknown as {
      objects: Map<string, Record<string, unknown>>;
      removeDevice(id: string): Promise<void>;
      log: { info: ReturnType<typeof vi.fn> };
    };
    adapter.objects.set("kitchen", { type: "device", common: {} });
    adapter.objects.set("kitchen.info", { type: "channel", common: {} });
    adapter.objects.set("kitchen.info.connection", { type: "state", common: {} });
    adapter.objects.set("kitchen.power", { type: "state", common: {} });
    adapter.objects.set("kitchen.volume", { type: "state", common: {} });
    adapter.objects.set("living.power", { type: "state", common: {} });
    await adapter.removeDevice("kitchen");
    const lines = adapter.log.info.mock.calls.map(call => String(call[0]));
    expect(lines.filter(line => line.includes("kitchen"))).toEqual([
      "kitchen: device deleted — removed 3 datapoint(s)",
    ]);
    expect([...adapter.objects.keys()]).toEqual(["living.power"]);
  });
});

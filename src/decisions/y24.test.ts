import { describe, expect, test, vi } from "vitest";

// Y-24: what the adapter remembers about a device never becomes a datapoint. It is kept on the device object,
// out of sight of the user's object list, and no protocol builds a state for it.

vi.mock("@iobroker/adapter-core", () => ({
  Adapter: class {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "yamaha.0";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    public objectWrites: Array<{ id: string; obj: Record<string, unknown> }> = [];
    public stateWrites: string[] = [];
    public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      this.objectWrites.push({ id, obj });
      return Promise.resolve();
    });
    public setForeignObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      this.objectWrites.push({ id, obj });
      return Promise.resolve();
    });
    public setState = vi.fn((id: string) => {
      this.stateWrites.push(id);
      return Promise.resolve();
    });
    public setStateChangedAsync = vi.fn((id: string) => {
      this.stateWrites.push(id);
      return Promise.resolve({ notChanged: false });
    });
    public timers: Array<() => void> = [];
    public setTimeout = vi.fn((cb: () => void) => {
      this.timers.push(cb);
      return { kind: "timeout" };
    });
    public clearTimeout = vi.fn();
    public getObjectAsync = vi.fn(() => Promise.resolve({ type: "device", common: { name: "living" }, native: {} }));
    constructor(_opts: unknown) {}
  },
  I18n: { init: vi.fn(() => Promise.resolve(undefined)) },
  getAbsoluteInstanceDataDir: () => "/tmp/yamaha-data",
}));

import { Yamaha } from "../main";
import { PROFILE_KEY, type DeviceProfileStore } from "../lib/lifecycle/capability-profile";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { YNCA_CATALOG } from "../lib/ynca/catalog";
import { XML_AMP_CATALOG } from "../lib/xml/catalog";

interface Internals {
  objectWrites: Array<{ id: string; obj: Record<string, unknown> }>;
  stateWrites: string[];
  timers: Array<() => void>;
  deviceRecords: Map<string, { id: string; ip: string }>;
  readyDevices: Set<string>;
  loadDeviceProfile(deviceId: string): Promise<DeviceProfileStore>;
}

describe("Y-24 what the adapter remembers is no datapoint", () => {
  test("a learned profile is written into the device object's native part, never as a state", async () => {
    const adapter = new Yamaha() as unknown as Internals;
    adapter.deviceRecords.set("living", { id: "living", ip: "10.0.0.6" });
    adapter.readyDevices.add("living");
    // The adapter's own wiring: the profile it loads for a device persists through it.
    const store = await adapter.loadDeviceProfile("living");
    store.probeMemory.set("yxcIdentity", "RX-V6A|1.0");
    store.setTree({ shared: { power: ["yxc", "ynca"] }, transports: ["yxc", "ynca"], firmware: {} });
    for (const fire of adapter.timers.splice(0)) {
      fire();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    const profileWrites = adapter.objectWrites.filter(w => JSON.stringify(w.obj).includes(PROFILE_KEY));
    expect(profileWrites.length).toBeGreaterThan(0);
    for (const write of profileWrites) {
      expect(write.id.replace("yamaha.0.", "")).toBe("living");
      expect(Object.keys(write.obj)).toEqual(["native"]);
      expect(typeof (write.obj.native as Record<string, unknown>)[PROFILE_KEY]).toBe("string");
    }
    expect(adapter.stateWrites).toEqual([]);
  });

  test("no protocol builds a datapoint for remembered device knowledge", () => {
    const ids = [
      ...YNCA_CATALOG.map(entry => entry.id),
      ...XML_AMP_CATALOG.map(entry => entry.state),
      ...mapYxcToObjects({
        zones: [{ id: "main", funcs: ["power", "volume"], inputs: ["hdmi1"] }],
        media: ["netusb", "tuner"],
        hasDistribution: true,
        tuner: { bands: ["fm"], funcs: ["fm"], presetType: "common" },
      }).map(o => o.id),
    ];
    expect(ids.filter(id => /profile|capabilit|probe|cache|learned/i.test(id))).toEqual([]);
  });
});

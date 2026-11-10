import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Y-24: what the adapter remembers about a device never becomes a datapoint. It is kept in a file in the instance
// data directory — never a state, never the native part of an object — and no protocol builds a state for it.

const dataDir = vi.hoisted(() => ({ path: "" }));
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
  getAbsoluteInstanceDataDir: () => dataDir.path,
}));

import * as mainModule from "../main";
const { Yamaha } = mainModule as unknown as { Yamaha: new () => ioBroker.Adapter };
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
  afterAll(() => rmSync(dataDir.path, { recursive: true, force: true }));

  test("a learned profile goes into a file in the instance data directory, never into a state or native", async () => {
    dataDir.path = mkdtempSync(join(tmpdir(), "yamaha-y24-"));
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
    const files = (): string[] => readdirSync(dataDir.path).map(name => readFileSync(join(dataDir.path, name), "utf8"));
    await vi.waitFor(() => expect(files().some(text => text.includes("RX-V6A|1.0"))).toBe(true));
    expect(adapter.objectWrites.filter(w => JSON.stringify(w.obj).includes("RX-V6A|1.0"))).toEqual([]);
    expect(
      adapter.objectWrites.filter(
        w => typeof (w.obj.native as Record<string, unknown> | undefined)?.[PROFILE_KEY] === "string",
      ),
    ).toEqual([]);
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

import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Y-27: how devices are searched for is set in the admin — mixed, manual only (no automatic search at all) or
// automatic only. How a device got into the list does not matter: nothing marks it. The setting sits on the main tab of
// exactly two tabs, and the main tab is called "Configuration" as in govee (krobi 2026-10-05 22:47 "the main part is
// called configuration (as in govee), exactly so wanted with 2 tabs").

vi.mock("@iobroker/adapter-core", () => ({
  Adapter: class {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "yamaha.0";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    constructor(_opts: unknown) {}
  },
  I18n: { init: vi.fn(() => Promise.resolve(undefined)) },
  getAbsoluteInstanceDataDir: () => "/tmp/yamaha-data",
}));

vi.mock("../lib/discovered-store", () => ({
  isExcluded: () => false,
  readDiscovered: vi.fn(() => Promise.resolve([{ id: "wx-030-2b3c", ip: "10.0.0.5" }])),
  writeDiscovered: vi.fn(() => Promise.resolve()),
  readIgnored: vi.fn(() => Promise.resolve([])),
  writeIgnored: vi.fn(() => Promise.resolve()),
  readExcluded: vi.fn(() => Promise.resolve([])),
  writeExcluded: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/discovered-store-deps", () => ({
  discoveredStoreDeps: () => ({}),
  ignoredStoreDeps: () => ({}),
  excludedStoreDeps: () => ({}),
}));

import { Yamaha } from "../main";
import { YamahaDeviceManagement } from "../device-management";
import { buildDeviceForm } from "../device-management-helpers";
import type { DeviceRecord } from "../lib/types";

type ConfigItem = { type?: string; label?: string; options?: Array<{ value: string }>; default?: string };
const ADMIN = join(__dirname, "..", "..", "admin");
const jsonConfig = JSON.parse(readFileSync(join(ADMIN, "jsonConfig.json"), "utf-8")) as {
  type?: string;
  items: Record<string, ConfigItem & { items?: Record<string, ConfigItem> }>;
};
const config = { items: jsonConfig.items._main?.items ?? {} };

/** The main tab's name in every language — govee's words. */
const CONFIGURATION: Record<string, string> = {
  en: "Configuration",
  de: "Konfiguration",
  ru: "Конфигурация",
  pt: "Configuração",
  nl: "Configuratie",
  fr: "Configuration",
  it: "Configurazione",
  es: "Configuración",
  pl: "Konfiguracja",
  uk: "Конфігурація",
  "zh-cn": "配置",
};

function searches(mode: string | undefined, table: DeviceRecord[]): boolean {
  const adapter = new Yamaha() as unknown as {
    config: Record<string, unknown>;
    searchesTheNetwork(configured: readonly DeviceRecord[]): boolean;
  };
  adapter.config = mode === undefined ? {} : { discovery: mode };
  return adapter.searchesTheNetwork(table);
}

const TYPED: DeviceRecord = { id: "rx-v473", ip: "10.0.0.8", source: "manual" };

describe("Y-27 the device search is a setting: mixed, manual only or automatic only", () => {
  test("the settings have exactly two tabs, the main one called Configuration in every language", () => {
    expect(jsonConfig.type).toBe("tabs");
    expect(Object.keys(jsonConfig.items)).toEqual(["_main", "_expert"]);
    const key = jsonConfig.items._main.label ?? "";
    for (const [lang, text] of Object.entries(CONFIGURATION)) {
      const words = JSON.parse(readFileSync(join(ADMIN, "i18n", `${lang}.json`), "utf-8")) as Record<string, string>;
      expect([lang, words[key]]).toEqual([lang, text]);
    }
  });

  test("the admin offers exactly the three settings, on the main tab", () => {
    const discovery = config.items.discovery;
    expect(discovery?.type).toBe("select");
    expect(discovery?.options?.map(option => option.value)).toEqual(["auto", "always", "never"]);
  });

  test("manual only: no automatic search at all, whatever the list holds", () => {
    expect(searches("never", [])).toBe(false);
    expect(searches("never", [TYPED])).toBe(false);
  });

  test("mixed: the search runs next to the devices entered by hand", () => {
    expect(searches("always", [TYPED])).toBe(true);
    expect(searches("always", [])).toBe(true);
  });

  test("automatic: the search runs while the user entered no device by hand", () => {
    expect(searches("auto", [])).toBe(true);
    expect(searches(undefined, [])).toBe(true);
    expect(searches("auto", [TYPED])).toBe(false);
  });

  test("a found card and a typed card look alike: no marker, the same actions", async () => {
    const dm = new YamahaDeviceManagement({
      namespace: "yamaha.0",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      getForeignObjectAsync: vi.fn((id: string) =>
        Promise.resolve(
          id === "system.adapter.yamaha.0" ? { native: { devices: [{ id: "rx-v473", ip: "10.0.0.8" }] } } : null,
        ),
      ),
      getForeignStateAsync: vi.fn(() => Promise.resolve(null)),
    } as never);
    const cards: Array<{ id: string; indicators: Array<{ id: string }>; actions: Array<{ id: string }> }> = [];
    await (dm as unknown as { loadDevices(ctx: unknown): Promise<void> }).loadDevices({
      addDevice: (card: (typeof cards)[number]) => cards.push(card),
      setTotalDevices: () => undefined,
    });
    expect(cards.map(card => card.id).sort()).toEqual(["rx-v473", "wx-030-2b3c"]);
    const [typed, found] = [cards.find(c => c.id === "rx-v473")!, cards.find(c => c.id === "wx-030-2b3c")!];
    expect(found.indicators.map(i => i.id)).toEqual(typed.indicators.map(i => i.id));
    expect(found.actions.map(a => a.id)).toEqual(typed.actions.map(a => a.id));
    expect(typed.indicators.map(i => i.id).filter(id => /source|origin|manual|discover/i.test(id))).toEqual([]);
  });

  test("nothing marks how a device got into the list", () => {
    const form = buildDeviceForm([]) as unknown as { items: Record<string, unknown> };
    expect(Object.keys(form.items).filter(key => /source|origin|manual|discover|auto/i.test(key))).toEqual([]);
    expect(Object.keys(config.items).filter(key => /source|origin|marker/i.test(key))).toEqual([]);
  });
});

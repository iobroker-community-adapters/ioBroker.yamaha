import { volumeIndicatorIcon } from "./lib/device-type";
import type { Mock } from "vitest";
// t() returns the key (with its arguments when it has any) so the tests assert on
// the message CHOICE, not on wording.
vi.mock("./lib/i18n", () => ({ t: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key) }));

// The discovered-devices store is a JSON file in the instance data dir — replaced
// by an in-memory pair so the manager's auto-mode is testable without the disk.
type ExcludedEntry = { id: string; ip?: string; identity?: { serial?: string; mac?: string } };
const store = vi.hoisted(() => ({
  devices: [] as Array<{ id: string; ip: string }>,
  ignored: [] as string[],
  excluded: [] as Array<{ id: string; ip?: string; identity?: { serial?: string; mac?: string } }>,
}));
vi.mock("./lib/discovered-store", () => ({
  readDiscovered: vi.fn(() => Promise.resolve(store.devices)),
  writeDiscovered: vi.fn((_deps: unknown, devices: Array<{ id: string; ip: string }>) => {
    store.devices = devices;
    return Promise.resolve();
  }),
  readIgnored: vi.fn(() => Promise.resolve(store.ignored)),
  writeIgnored: vi.fn((_deps: unknown, ids: string[]) => {
    store.ignored = [...ids];
    return Promise.resolve();
  }),
  readExcluded: vi.fn(() => Promise.resolve(store.excluded)),
  writeExcluded: vi.fn((_deps: unknown, entries: ExcludedEntry[]) => {
    store.excluded = [...entries];
    return Promise.resolve();
  }),
}));
vi.mock("./lib/discovered-store-deps", () => ({
  discoveredStoreDeps: () => ({}),
  ignoredStoreDeps: () => ({}),
  excludedStoreDeps: () => ({}),
}));

import { buildDeviceForm, findClash, rowId } from "./device-management-helpers";
import { YamahaDeviceManagement } from "./device-management";
import { writeDiscovered, writeExcluded, writeIgnored } from "./lib/discovered-store";
import { LABEL_RANK, parseDevices } from "./lib/pure-helpers";

/**
 * What a read stub answers with: a COPY of the stored value, never the stored object itself.
 *
 * With a shared reference, a change the adapter makes on what it just read would already sit in
 * the store — and no assertion could then tell a missing write from a done one (fleet rule
 * `read-stub-copy`, measured on hassemu 2026-09-17). Absent stays `null`, as the real API answers.
 *
 * @param value the stored value, if any
 * @returns a detached copy, or null
 */
function copyOf<T>(value: T | undefined): T | null {
  return value === undefined || value === null ? null : structuredClone(value);
}

describe("findClash", () => {
  const rows = [
    { name: "Living room", ip: "192.168.1.10" },
    { name: "Kitchen", ip: "192.168.1.11" },
  ];

  it("flags a duplicate ip", () => {
    expect(findClash(rows, { name: "New", ip: "192.168.1.11" }, -1)).toBe("duplicateDevice");
  });

  it("returns null when the ip is new and valid", () => {
    expect(findClash(rows, { name: "New", ip: "192.168.1.12" }, -1)).toBeNull();
  });

  it("excludes the edited row so its own ip does not clash with itself", () => {
    expect(findClash(rows, { name: "Living room", ip: "192.168.1.10" }, 0)).toBeNull();
  });

  it("rejects a malformed ip", () => {
    expect(findClash(rows, { name: "New", ip: "not-an-ip" }, -1)).toBe("invalidIp");
  });

  it("rejects a name that maps to the reserved 'info' object id — as a NAME problem, not an IP one", () => {
    expect(findClash(rows, { name: "info", ip: "192.168.1.12" }, -1)).toBe("invalidName");
  });

  it("rejects a different name that sanitizes to the same id as another row — as a duplicate", () => {
    // "Living room" and "Living*room" both sanitize to "Living_room": distinct names, same tree.
    expect(findClash(rows, { name: "Living*room", ip: "192.168.1.12" }, -1)).toBe("duplicateDevice");
  });

  it("falls back to the ip as the id when the name is blank", () => {
    expect(findClash(rows, { name: "", ip: "192.168.1.12" }, -1)).toBeNull();
  });
});

describe("buildDeviceForm", () => {
  it("builds a name + ip panel and embeds the used ips into the ip validator", () => {
    const form = buildDeviceForm(["192.168.1.10"]) as unknown as {
      type: string;
      items: { name: { type: string }; ip: { type: string; validator: string } };
    };
    expect(form.type).toBe("panel");
    expect(form.items.name.type).toBe("text");
    expect(form.items.ip.type).toBe("text");
    // the already-used ip must be part of the "not in use" validator expression
    expect(form.items.ip.validator).toContain("192.168.1.10");
    // the embedded IP regex must be the correct single-backslash form, not an over-escaped copy
    // that would match a literal "\d" and permanently disable the OK button
    expect(form.items.ip.validator).toContain("/^(\\d{1,3}\\.){3}\\d{1,3}$/");
    expect(form.items.ip.validator).not.toContain("\\\\d");
  });
});

// ---------------------------------------------------------------------------
// The device-manager backend. Everything above is pure; the class owns the
// read/modify/write cycle on the user's device table and the discovery store.
// ---------------------------------------------------------------------------

/**
 * An in-memory `system.adapter.yamaha.0` config object plus the live info states.
 *
 * @param devices Device list stored in native.devices
 * @param states Info states the mock answers getForeignStateAsync from
 * @param objects Foreign objects the mock answers getForeignObjectAsync from
 */
function mockAdapter(
  devices: unknown = [],
  states: Record<string, unknown> = {},
  objects: Record<string, unknown> = {},
): any {
  let stored: unknown = devices;
  // What the backend schedules on the adapter's timer — run by hand, so a test can prove
  // what happened BEFORE the handler answered and what only after.
  const deferred: Array<() => void> = [];
  return {
    namespace: "yamaha.0",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn(),
    setTimeout: vi.fn((cb: () => void, _ms: number) => {
      deferred.push(cb);
      return { kind: "timeout" };
    }),
    _runDeferred: () => {
      for (const cb of deferred.splice(0)) {
        cb();
      }
    },
    getForeignObjectAsync: vi.fn((id: string) =>
      // A COPY, never the stored object — see `read-stub-copy`: a shared reference would put a
      // change the code makes on what it read into the store before any write happened.
      Promise.resolve(id === "system.adapter.yamaha.0" ? { native: { devices: stored } } : copyOf(objects[id])),
    ),
    extendForeignObjectAsync: vi.fn((id: string, patch: Record<string, any>) => {
      // Two kinds of write reach this: the device TABLE on the instance object, and a device
      // object's own common (the display name the edit dialog sets).
      if (patch.native && "devices" in patch.native) {
        stored = patch.native.devices;
      } else {
        const previous = (objects[id] ?? {}) as Record<string, any>;
        objects[id] = {
          ...previous,
          ...patch,
          common: { ...(previous.common ?? {}), ...(patch.common ?? {}) },
        };
      }
      return Promise.resolve();
    }),
    getForeignStateAsync: vi.fn((id: string) =>
      Promise.resolve(id in states ? ({ val: states[id], ack: true } as ioBroker.State) : null),
    ),
    // The adapter methods the backend reaches for: stop a device and drop its tree, and switch
    // one device's volume presentation while it runs.
    removeDevice: vi.fn(() => Promise.resolve()),
    rediscoverNow: vi.fn(),
    setVolumePercent: vi.fn((id: string, on: boolean) => {
      const full = `yamaha.0.${id}`;
      const previous = (objects[full] ?? {}) as Record<string, any>;
      objects[full] = { ...previous, native: { ...(previous.native ?? {}), volumeAsPercent: on } };
      return Promise.resolve();
    }),
    _stored: () => stored as Array<{ name?: string; ip: string }>,
  };
}

/**
 * A mock ActionContext with configurable form / confirmation answers.
 *
 * @param opts Canned answers for the dialogs
 * @param opts.form What showForm resolves with
 * @param opts.confirm What showConfirmation resolves with (default true)
 */
function mockContext(opts: { form?: unknown; confirm?: boolean } = {}): {
  showForm: Mock;
  showConfirmation: Mock;
  showMessage: Mock;
} {
  return {
    showForm: vi.fn((_schema: unknown, _options: unknown) => Promise.resolve(opts.form)),
    showConfirmation: vi.fn((_text: unknown) => Promise.resolve(opts.confirm ?? true)),
    showMessage: vi.fn((_text: unknown) => Promise.resolve(undefined)),
  };
}

type MockCtx = ReturnType<typeof mockContext>;
interface DmAction {
  id: string;
  icon: string;
  confirmation?: unknown;
  handler: (...args: any[]) => Promise<unknown>;
}
interface Card {
  id: string;
  name: string;
  identifier: string;
  icon: string;
  model: { stateId: string };
  status: { connection: { stateId: string } };
  indicators: Array<{
    id: string;
    value: { stateId: string } | boolean;
    text?: unknown;
    hideIfEmpty?: boolean;
    icon?: string;
    tooltip?: unknown;
  }>;
  actions: DmAction[];
  controls?: unknown[];
}
/**
 * The state a state-bound indicator follows. Asserted, not assumed: since the percent badge
 * carries a literal value, the type is a union — and an indicator that lost its binding must
 * fail here instead of comparing `undefined` with `undefined`.
 *
 * @param indicator the indicator to read
 * @returns the bound state id
 */
function stateIdOf(indicator: Card["indicators"][number]): string {
  const value = indicator.value;
  if (typeof value !== "object" || typeof value.stateId !== "string") {
    throw new Error(`indicator ${indicator.id} is not bound to a state`);
  }
  return value.stateId;
}

interface DmInternals {
  loadDevices(ctx: { addDevice: (info: unknown) => void }): Promise<void>;
  getInstanceInfo(): { apiVersion: string; identifierLabel: unknown; actions: DmAction[] };
  addDevice(ctx: MockCtx): Promise<{ refresh: boolean }>;
  editDevice(cardId: string, ctx: MockCtx): Promise<{ refresh: "devices" }>;
  deleteDevice(cardId: string): Promise<{ delete: string }>;
  excludedDevices(ctx: MockCtx): Promise<{ refresh: boolean }>;
}
/** Subset of the generated jsonConfig panel the tests inspect. */
interface FormSchema {
  items: Record<string, { validator?: string }>;
}

describe("YamahaDeviceManagement", () => {
  let adapter: ReturnType<typeof mockAdapter>;
  let dm: YamahaDeviceManagement;

  function make(
    devices: unknown = [],
    states: Record<string, unknown> = {},
    objects: Record<string, unknown> = {},
  ): DmInternals {
    adapter = mockAdapter(devices, states, objects);
    dm = new YamahaDeviceManagement(adapter);
    return dm as unknown as DmInternals;
  }

  async function cards(
    devices: unknown,
    states: Record<string, unknown> = {},
    objects: Record<string, unknown> = {},
  ): Promise<Card[]> {
    const i = make(devices, states, objects);
    const out: Card[] = [];
    await i.loadDevices({ addDevice: (c: unknown) => out.push(c as Card) });
    return out;
  }

  beforeEach(() => {
    store.devices = [];
    store.ignored = [];
    store.excluded = [];
    vi.clearAllMocks();
  });

  /** Let every promise the handler left behind settle (the deferred table write chains one). */
  const flushPromises = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  const living = { name: "Living room", ip: "192.168.1.10" };
  const kitchen = { name: "Kitchen", ip: "192.168.1.11" };

  it("shows the manual table and the discovered devices together", async () => {
    store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
    const out = await cards([living, kitchen]);
    // The list follows what the adapter RUNS, and since 2.9.0 that is the union of both —
    // a filled table no longer turns the network search off.
    expect(out.map(c => c.id)).toEqual(["Living_room", "Kitchen", "rx-v685"]);
    expect(out.map(c => c.identifier)).toEqual(["192.168.1.10", "192.168.1.11", "192.168.1.20"]);
  });

  it("two table rows that sanitise to one id give one card, not two", async () => {
    // Both become "Living_Room", and the object tree has exactly one of those — a second card
    // would offer to edit and delete a device that shares its whole tree with the first.
    const out = await cards([
      { name: "Living Room", ip: "192.168.1.10" },
      { name: "Living.Room", ip: "192.168.1.11" },
    ]);
    expect(out.map(c => c.id)).toEqual(["Living_Room"]);
    expect(out[0].identifier).toBe("192.168.1.10");
  });

  it("the typed address wins when both stores know the same device", async () => {
    store.devices = [{ id: "Living_room", ip: "192.168.1.99" }];
    const out = await cards([living]);
    expect(out).toHaveLength(1);
    expect(out[0].identifier).toBe("192.168.1.10");
  });

  it("shows the discovered devices when the table is empty", async () => {
    store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
    const out = await cards([]);
    // The card list has to follow what the adapter actually RUNS — an empty table
    // means auto mode, and showing nothing would look like a broken instance.
    expect(out.map(c => c.id)).toEqual(["rx-v685"]);
    expect(out[0].identifier).toBe("192.168.1.20");
  });

  it("survives a device table that is not a list", async () => {
    // A hand-edited config (or an old instance) can leave anything here. Reading
    // it raw would make .filter throw and take the whole manager view down.
    store.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    expect(await cards("nonsense")).toHaveLength(1);
    expect(await cards(undefined)).toHaveLength(1);
  });

  it("keeps a manual row without a name usable by falling back to its IP", async () => {
    const out = await cards([{ ip: "192.168.1.30" }]);
    expect(out[0].id).toBe("192_168_1_30");
    expect(out[0].name).toBe("192.168.1.30");
  });

  it("drops table rows that carry no IP", async () => {
    const out = await cards([{ name: "Ghost" }, { name: "Empty", ip: "" }, living, null]);
    // The IP is the only thing that can be connected to; a row without one would
    // become a card that can never work.
    expect(out.map(c => c.id)).toEqual(["Living_room"]);
  });

  it("skips a second row that maps to the same object id", async () => {
    const out = await cards([living, { name: "Living*room", ip: "192.168.1.99" }]);
    // Two cards on one object tree would show each other's live values.
    expect(out.map(c => c.id)).toEqual(["Living_room"]);
  });

  it("never lets a device take the adapter's own info branch", async () => {
    const out = await cards([{ name: "info", ip: "192.168.1.40" }]);
    expect(out).toEqual([]);
  });

  it("binds every live line to that device's own states", async () => {
    const out = await cards([living]);
    expect(out[0].model.stateId).toBe("yamaha.0.Living_room.info.model");
    expect(out[0].status.connection.stateId).toBe("yamaha.0.Living_room.info.connection");
    // hideIfEmpty is what makes the card show only the protocols this device is
    // connected over instead of three permanent grey badges.
    const transports = out[0].indicators.filter(i => i.id.startsWith("transport-"));
    expect(transports.map(stateIdOf)).toEqual([
      "yamaha.0.Living_room.info.transports.ynca",
      "yamaha.0.Living_room.info.transports.yxc",
      "yamaha.0.Living_room.info.transports.xml",
    ]);
    expect(transports.every(i => i.hideIfEmpty)).toBe(true);
  });

  it("paints the device-class silhouette from the reported model", async () => {
    const plain = await cards([living]);
    const withModel = await cards([living], { "yamaha.0.Living_room.info.model": "WX-021" });
    expect(withModel[0].icon).not.toBe(plain[0].icon);
  });

  it("offers edit and delete on every card, whichever store it came from", async () => {
    expect((await cards([living]))[0].actions.map(a => a.id)).toEqual(["edit", "delete"]);
    store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
    // A found device can be given the fixed address the user just assigned it — that is what
    // makes it a manual device (editDevice moves the record).
    expect((await cards([]))[0].actions.map(a => a.id)).toEqual(["edit", "delete"]);
  });

  it("carries no marker for where the address came from — the card is about the device, not the table", async () => {
    // 2.9.x showed a pencil or a magnifier; removed on request 2026-09-15.
    expect((await cards([living]))[0].indicators.map(i => i.id)).not.toContain("device-source");
    store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
    expect((await cards([]))[0].indicators.map(i => i.id)).not.toContain("device-source");
  });

  it("declares the v3 API and a single add action", () => {
    const info = make([]).getInstanceInfo();
    expect(info.apiVersion).toBe("v3");
    expect(info.identifierLabel).toBe("ipLabel");
    expect(info.actions.map(a => a.id)).toEqual(["add", "excluded"]);
  });

  describe("add", () => {
    it("appends the device and trims what the user typed", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "  Bedroom  ", ip: " 192.168.1.50 " } });
      await expect(i.addDevice(ctx)).resolves.toEqual({ refresh: true });
      expect(adapter._stored()).toEqual([living, { name: "Bedroom", ip: "192.168.1.50" }]);
    });

    // A name that is the address marks a migrated row, which follows the device and rewrites the
    // table; a typed one must stay where it was typed (audit 2026-09-24, A6).
    it("stores a typed row whose name is its IP without a name — it stays a typed row", async () => {
      const i = make([]);
      await i.addDevice(mockContext({ form: { name: "192.168.1.50", ip: "192.168.1.50" } }));
      expect(adapter._stored()).toEqual([{ name: "", ip: "192.168.1.50" }]);
      expect(parseDevices(adapter._stored())[0]).toMatchObject({ id: "192_168_1_50", source: "manual" });
    });

    it("passes the IPs already in use into the dialog validator", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.addDevice(ctx);
      const schema = ctx.showForm.mock.calls[0][0] as FormSchema;
      expect(schema.items.ip.validator).toContain("192.168.1.10");
      expect(schema.items.ip.validator).toContain("192.168.1.11");
    });

    it("writes nothing on cancel or a blank IP", async () => {
      for (const form of [undefined, { ip: "   " }, { name: "X" }, { ip: 42 }]) {
        const i = make([living]);
        await i.addDevice(mockContext({ form }));
        expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
      }
    });

    it("refuses a clash and says so instead of writing it", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "New", ip: "192.168.1.10" } });
      await i.addDevice(ctx);
      // The dialog validator can be bypassed; the backend check is what keeps two
      // cards off one receiver.
      expect(ctx.showMessage).toHaveBeenCalledWith("duplicateDevice");
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("refuses a malformed IP", async () => {
      const i = make([]);
      const ctx = mockContext({ form: { name: "X", ip: "not-an-ip" } });
      await i.addDevice(ctx);
      expect(ctx.showMessage).toHaveBeenCalledWith("invalidIp");
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });
  });

  describe("edit", () => {
    it("pre-fills the form and replaces exactly that row", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: { name: "Kitchen", ip: "192.168.1.99" } });
      await expect(i.editDevice("Kitchen", ctx)).resolves.toEqual({ refresh: "devices" });
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ data: { name: "Kitchen", ip: "192.168.1.11" } });
      expect(adapter._stored()).toEqual([living, { name: "Kitchen", ip: "192.168.1.99" }]);
    });

    it("leaves the edited row out of the dialog's in-use list", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.editDevice("Kitchen", ctx);
      const schema = ctx.showForm.mock.calls[0][0] as FormSchema;
      // Otherwise opening a device and pressing OK unchanged greys the button out:
      // it clashes with itself and the row can never be edited.
      expect(schema.items.ip.validator).not.toContain("192.168.1.11");
      expect(schema.items.ip.validator).toContain("192.168.1.10");
    });

    it("does not clash a row with its own IP, but still refuses another's", async () => {
      const i = make([living, kitchen]);
      const ok = mockContext({ form: { name: "Kitchen", ip: "192.168.1.11" } });
      await i.editDevice("Kitchen", ok);
      expect(ok.showMessage).not.toHaveBeenCalled();

      const clash = make([living, kitchen]);
      const ctx = mockContext({ form: { name: "Kitchen", ip: "192.168.1.10" } });
      await clash.editDevice("Kitchen", ctx);
      expect(ctx.showMessage).toHaveBeenCalledWith("duplicateDevice");
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("a found device given a fixed address MOVES into the table and keeps its id", async () => {
      store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
      const i = make([]);
      const ctx = mockContext({ form: { name: "Living room", ip: "192.168.1.99" } });
      await expect(i.editDevice("rx-v685", ctx)).resolves.toEqual({ refresh: "devices" });
      // Moved, not copied: left in both stores the next search would carry the found address
      // back over the typed one.
      expect(store.devices).toEqual([]);
      // The row's name IS the id, so the object tree stays where it is; what the user typed
      // becomes the display name at the device object.
      expect(adapter._stored()).toEqual([{ name: "rx-v685", ip: "192.168.1.99" }]);
      // The marker rides in the SAME write: it tells the next start that this is the
      // established name (so the header write does not put the bare id back) and it carries the
      // user rank, which no name a device reports for itself can outrank.
      expect(adapter.extendForeignObjectAsync).toHaveBeenCalledWith("yamaha.0.rx-v685", {
        common: { name: "Living room" },
        native: { label: "Living room", labelRank: LABEL_RANK.user },
      });
    });

    it("a found device WITHOUT a name keeps its id — the id is its old address", async () => {
      // The search reads the name off the device; a receiver that reports none gets its id from
      // the address it had then. Re-deriving the id on an address change would move the whole
      // object tree, and cleanupStaleObjects would delete the one left behind.
      store.devices = [{ id: "192_168_1_20", ip: "192.168.1.20" }];
      const i = make([]);
      await i.editDevice("192_168_1_20", mockContext({ form: { name: "", ip: "192.168.1.99" } }));
      expect(adapter._stored()).toEqual([{ name: "192_168_1_20", ip: "192.168.1.99" }]);
      expect(rowId(adapter._stored()[0])).toBe("192_168_1_20");
    });

    it("a found device whose name alone changes stays discovered", async () => {
      store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
      const i = make([]);
      await i.editDevice("rx-v685", mockContext({ form: { name: "Kitchen", ip: "192.168.1.20" } }));
      // Nothing about the address changed, so there is nothing to pin — only the label moves.
      expect(store.devices).toEqual([{ id: "rx-v685", ip: "192.168.1.20" }]);
      expect(adapter._stored()).toEqual([]);
      expect(adapter.extendForeignObjectAsync).toHaveBeenCalledWith("yamaha.0.rx-v685", {
        common: { name: "Kitchen" },
        native: { label: "Kitchen", labelRank: LABEL_RANK.user },
      });
    });

    it("renaming a manual device does not move its object tree", async () => {
      const i = make([living]);
      await i.editDevice("Living_room", mockContext({ form: { name: "Lounge", ip: "192.168.1.10" } }));
      // The id comes from the row's name, so the row keeps the id and the new label goes to the
      // device object — before 2.9.0 this renamed the id and left the whole tree behind.
      expect(rowId(adapter._stored()[0])).toBe("Living_room");
      expect(adapter.extendForeignObjectAsync).toHaveBeenCalledWith("yamaha.0.Living_room", {
        common: { name: "Lounge" },
        native: { label: "Lounge", labelRank: LABEL_RANK.user },
      });
    });

    it("does nothing for a card that is no longer in the table", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "Ghost", ip: "192.168.1.77" } });
      await expect(i.editDevice("ghost", ctx)).resolves.toEqual({ refresh: "devices" });
      // A stale manager view must not open a form that would then append a device.
      expect(ctx.showForm).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("writes nothing on cancel or a blank IP", async () => {
      const i = make([living]);
      await i.editDevice("Living_room", mockContext({ form: undefined }));
      await i.editDevice("Living_room", mockContext({ form: { ip: "  " } }));
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("asks the UI for confirmation on the card itself, naming the datapoints", async () => {
      // dm-utils `confirmation` on the descriptor: the UI asks BEFORE the handler runs. No
      // message round-trip inside the handler — the one the restart of the manual branch
      // used to cut off, leaving the progress bar spinning.
      const out = await cards([living]);
      const del = out[0].actions.find(a => a.id === "delete");
      expect(del?.confirmation).toEqual({ key: "dmDeleteConfirm", args: ["Living room"] });
    });

    it("manual row: excludes first, removes the tree, answers, and only then rewrites the table", async () => {
      const i = make([living, kitchen], {}, { "yamaha.0.Kitchen": { native: { identity: { serial: "0E897553" } } } });
      const order: string[] = [];
      (writeExcluded as Mock).mockImplementation(() => {
        order.push("exclude");
        return Promise.resolve();
      });
      adapter.removeDevice.mockImplementation(() => {
        order.push("remove");
        return Promise.resolve();
      });
      adapter.extendForeignObjectAsync.mockImplementation((_id: string, patch: Record<string, any>) => {
        if (patch.native && "devices" in patch.native) {
          order.push("table");
        }
        return Promise.resolve();
      });
      // The SECOND row on purpose: deleting the first one cannot tell "the chosen
      // row" from "the first row" apart.
      await expect(i.deleteDevice("Kitchen")).resolves.toEqual({ delete: "Kitchen" });
      // The table is NOT written inside the handler: that write restarts the instance, and a
      // handler that awaits it never answers.
      expect(order).toEqual(["exclude", "remove"]);
      expect(writeExcluded).toHaveBeenCalledWith({}, [
        { id: "Kitchen", ip: "192.168.1.11", identity: { serial: "0E897553" } },
      ]);
      // A manual card lives in the table alone — the discovery store is not touched.
      expect(writeDiscovered).not.toHaveBeenCalled();
      adapter._runDeferred();
      await flushPromises();
      expect(order).toEqual(["exclude", "remove", "table"]);
      expect(adapter.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.yamaha.0", {
        native: { devices: [living] },
      });
    });

    it("manual row without a known identity is excluded by its address", async () => {
      const i = make([living, kitchen]);
      await i.deleteDevice("Kitchen");
      expect(writeExcluded).toHaveBeenCalledWith({}, [{ id: "Kitchen", ip: "192.168.1.11" }]);
    });

    it("discovered card: excludes first, forgets the record, then removes the tree", async () => {
      store.devices = [
        { id: "rx-v685", ip: "192.168.1.20" },
        { id: "wx-021", ip: "192.168.1.21" },
      ];
      const i = make([]);
      const order: string[] = [];
      (writeExcluded as Mock).mockImplementation(() => {
        order.push("exclude");
        return Promise.resolve();
      });
      (writeDiscovered as Mock).mockImplementation((_deps: unknown, devices: Array<{ id: string; ip: string }>) => {
        order.push("store");
        store.devices = devices;
        return Promise.resolve();
      });
      adapter.removeDevice.mockImplementation(() => {
        order.push("remove");
        return Promise.resolve();
      });
      await expect(i.deleteDevice("rx-v685")).resolves.toEqual({ delete: "rx-v685" });
      // Exclusion before anything slow: a search running right now must read it.
      expect(order).toEqual(["exclude", "store", "remove"]);
      expect(store.devices).toEqual([{ id: "wx-021", ip: "192.168.1.21" }]);
      expect(adapter.removeDevice).toHaveBeenCalledWith("rx-v685");
      // No table write, no restart for a discovered card.
      expect(adapter.setTimeout).not.toHaveBeenCalled();
    });

    it("keeps the legacy id list in step so a rollback to 2.11.0 still excludes", async () => {
      store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
      store.ignored = ["Old"];
      const i = make([]);
      await i.deleteDevice("rx-v685");
      expect(writeIgnored).toHaveBeenCalledWith({}, ["Old", "rx-v685"]);
    });

    it("an unknown card id changes nothing", async () => {
      const i = make([living]);
      await expect(i.deleteDevice("Ghost")).resolves.toEqual({ delete: "Ghost" });
      expect(writeExcluded).not.toHaveBeenCalled();
      expect(writeIgnored).not.toHaveBeenCalled();
      expect(adapter.removeDevice).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("adding the same device by hand lifts an earlier exclusion, by id or by address", async () => {
      store.ignored = ["Bedroom"];
      store.excluded = [
        { id: "Bedroom", ip: "192.168.1.30" },
        { id: "Other", ip: "192.168.1.30" },
        { id: "Keep", ip: "192.168.1.31" },
      ];
      const i = make([]);
      await i.addDevice(mockContext({ form: { name: "Bedroom", ip: "192.168.1.30" } }));
      expect(writeIgnored).toHaveBeenCalledWith({}, []);
      expect(writeExcluded).toHaveBeenCalledWith({}, [{ id: "Keep", ip: "192.168.1.31" }]);
    });

    it("adding a device that was never excluded writes no exclusion file", async () => {
      store.excluded = [{ id: "Keep", ip: "192.168.1.31" }];
      const i = make([]);
      await i.addDevice(mockContext({ form: { name: "Bedroom", ip: "192.168.1.30" } }));
      expect(writeExcluded).not.toHaveBeenCalled();
    });
  });

  it("an adapter that lacks one of the three owner methods gets no owner — the backend never calls into a partial surface", async () => {
    // The device manager reaches into the running adapter for three things; a partial surface
    // (an older adapter build, a test double) must not pass as the owner and then throw.
    store.excluded = [{ id: "Kitchen", ip: "192.168.1.11" }];
    const i = make([]);
    delete adapter.rediscoverNow;
    await expect(i.excludedDevices(mockContext({ form: { Kitchen: true } }))).resolves.toEqual({ refresh: true });
    expect(writeExcluded).toHaveBeenCalledWith({}, []);
  });

  describe("excluded devices", () => {
    it("lists every exclusion, lifts the ticked ones from both stores, and searches again", async () => {
      store.excluded = [{ id: "Kitchen", ip: "192.168.1.11" }];
      store.ignored = ["Kitchen", "Old"];
      const i = make([]);
      const ctx = mockContext({ form: { Kitchen: true, Old: false } });
      await expect(i.excludedDevices(ctx)).resolves.toEqual({ refresh: true });
      const schema = ctx.showForm.mock.calls[0][0] as { items: Record<string, { type: string; label: string }> };
      expect(Object.keys(schema.items)).toEqual(["Kitchen", "Old"]);
      expect(schema.items.Kitchen).toMatchObject({ type: "checkbox", label: "Kitchen (192.168.1.11)" });
      expect(schema.items.Old).toMatchObject({ type: "checkbox", label: "Old" });
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ title: "dmExcludedTitle" });
      expect(writeExcluded).toHaveBeenCalledWith({}, []);
      expect(writeIgnored).toHaveBeenCalledWith({}, ["Old"]);
      // The running adapter forgets the session's delete and searches at once — otherwise the
      // device came back only at the next restart (or never, with `always` and every device online).
      expect(adapter.rediscoverNow).toHaveBeenCalledWith(["Kitchen"]);
    });

    it("says so when nothing is excluded", async () => {
      const i = make([]);
      const ctx = mockContext({});
      await expect(i.excludedDevices(ctx)).resolves.toEqual({ refresh: false });
      expect(ctx.showMessage).toHaveBeenCalledWith("dmExcludedNone");
      expect(ctx.showForm).not.toHaveBeenCalled();
    });

    it("cancel, and a form with nothing ticked, change nothing", async () => {
      store.ignored = ["Old"];
      const i = make([]);
      await i.excludedDevices(mockContext({ form: undefined }));
      await i.excludedDevices(mockContext({ form: { Old: false } }));
      expect(writeIgnored).not.toHaveBeenCalled();
      expect(writeExcluded).not.toHaveBeenCalled();
      expect(adapter.rediscoverNow).not.toHaveBeenCalled();
    });
  });

  it("titles the card with the device object's name, not the ip in the table", async () => {
    // The upgrade from the previous adapter puts the receiver's ip in the table; the
    // object carries the readable name the adapter learned from the device.
    const [card] = await cards(
      [{ name: "192.168.178.25", ip: "192.168.178.25" }],
      {},
      { "yamaha.0.192_168_178_25": { common: { name: "Wohnzimmer" } } },
    );
    expect(card.name).toBe("Wohnzimmer");
    // The table entry itself stays put — the object id is derived from it.
    expect(adapter._stored()).toEqual([{ name: "192.168.178.25", ip: "192.168.178.25" }]);
  });

  it("keeps the table name when the object carries nothing better", async () => {
    const [card] = await cards([living]);
    expect(card.name).toBe("Living room");
  });
  // 2.8.0 shipped this as ONE instance checkbox, so it hit every receiver on the instance at once.
  // It is a per-device decision now, and it lives in ONE place: the add/edit dialog. 2.9.1 also
  // put a switch control on the card itself; that one showed the wrong position while the dialog
  // showed the right one, and two ways to set one value is one too many.
  describe("volume in percent, per device", () => {
    it("the card carries no switch control of its own", async () => {
      const on = await cards([living], {}, { "yamaha.0.Living_room": { native: { volumeAsPercent: true } } });
      // The switch is set where name and address are set. A control here would be a second,
      // independently-read copy of the same value — exactly what went wrong in 2.9.1.
      expect(on[0].controls ?? []).toEqual([]);
    });

    it("but the card SHOWS the setting: a speaker with a percent sign and the live volume as 'NN %'", async () => {
      const on = await cards([living], {}, { "yamaha.0.Living_room": { native: { volumeAsPercent: true } } });
      const volume = on[0].indicators.find(i => i.id === "volume");
      expect(volume).toMatchObject({
        value: { stateId: "yamaha.0.Living_room.volume" },
        showValue: true,
        unit: "%",
        hideIfEmpty: false,
        tooltip: "volumeAsPercent",
      });
      expect(volume?.icon).toBe(volumeIndicatorIcon(true));
      expect(volume?.icon).toMatch(/^data:image\/svg\+xml;base64,/);
      // 0 % is a value, not "nothing": the glyph must not grey out at the bottom of the scale.
      expect(volume).toMatchObject({ color: "primary", colorOn: "primary" });
    });

    it("and in the device's own scale it shows the plain speaker, without a number", async () => {
      const off = await cards([living], {}, { "yamaha.0.Living_room": { native: {} } });
      const volume = off[0].indicators.find(i => i.id === "volume");
      expect(volume).toMatchObject({ value: true, hideIfEmpty: false, tooltip: "volumeDeviceScale" });
      expect(volume?.icon).toBe(volumeIndicatorIcon(false));
      expect(volume).not.toHaveProperty("showValue");
      expect(volume).not.toHaveProperty("unit");
      expect(off[0].indicators.map(i => i.id)).not.toContain("volume-percent");
    });

    it("a device added through the dialog starts with the answer the user gave", async () => {
      const i = make([]);
      const ctx = mockContext({ form: { name: "Bedroom", ip: "192.168.1.50", volumeAsPercent: true } });
      await i.addDevice(ctx);
      // No object exists yet, so the dialog seeds one instead of asking the adapter to rebuild
      // datapoints that are not there.
      expect(adapter.extendForeignObjectAsync).toHaveBeenCalledWith("yamaha.0.Bedroom", {
        type: "device",
        common: { name: "Bedroom" },
        native: { volumeAsPercent: true },
      });
    });

    it("the edit dialog shows the current setting and applies a change", async () => {
      const i = make([living], {}, { "yamaha.0.Living_room": { native: { volumeAsPercent: true } } });
      const ctx = mockContext({ form: { name: "Living room", ip: "192.168.1.10", volumeAsPercent: false } });
      await i.editDevice("Living_room", ctx);
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ data: { volumeAsPercent: true } });
      expect(adapter.setVolumePercent).toHaveBeenCalledWith("Living_room", false);
    });

    it("an unchanged switch is not written again", async () => {
      const i = make([living], {}, { "yamaha.0.Living_room": { native: { volumeAsPercent: false } } });
      await i.editDevice(
        "Living_room",
        mockContext({ form: { name: "", ip: "192.168.1.10", volumeAsPercent: false } }),
      );
      expect(adapter.setVolumePercent).not.toHaveBeenCalled();
    });
  });
});

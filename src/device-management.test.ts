import type { Mock } from "vitest";
// t() returns the key (with its arguments when it has any) so the tests assert on
// the message CHOICE, not on wording.
vi.mock("./lib/i18n", () => ({ t: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key) }));

// The discovered-devices store is a JSON file in the instance data dir — replaced
// by an in-memory pair so the manager's auto-mode is testable without the disk.
const store = vi.hoisted(() => ({ devices: [] as Array<{ id: string; ip: string }> }));
vi.mock("./lib/discovered-store", () => ({
  readDiscovered: vi.fn(() => Promise.resolve(store.devices)),
  writeDiscovered: vi.fn((_deps: unknown, devices: Array<{ id: string; ip: string }>) => {
    store.devices = devices;
    return Promise.resolve();
  }),
}));
vi.mock("./lib/discovered-store-deps", () => ({ discoveredStoreDeps: () => ({}) }));

import { buildDeviceForm, findClash } from "./device-management-helpers";
import { YamahaDeviceManagement } from "./device-management";
import { readDiscovered, writeDiscovered } from "./lib/discovered-store";

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
  return {
    namespace: "yamaha.0",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn(),
    getForeignObjectAsync: vi.fn((id: string) =>
      Promise.resolve(id === "system.adapter.yamaha.0" ? { native: { devices: stored } } : (objects[id] ?? null)),
    ),
    extendForeignObjectAsync: vi.fn((_id: string, patch: { native: { devices: unknown } }) => {
      stored = patch.native.devices;
      return Promise.resolve();
    }),
    getForeignStateAsync: vi.fn((id: string) =>
      Promise.resolve(id in states ? ({ val: states[id], ack: true } as ioBroker.State) : null),
    ),
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
  handler: (...args: any[]) => Promise<unknown>;
}
interface Card {
  id: string;
  name: string;
  identifier: string;
  icon: string;
  model: { stateId: string };
  status: { connection: { stateId: string } };
  indicators: Array<{ id: string; value: { stateId: string }; hideIfEmpty?: boolean }>;
  actions: DmAction[];
}
interface DmInternals {
  loadDevices(ctx: { addDevice: (info: unknown) => void }): Promise<void>;
  getInstanceInfo(): { apiVersion: string; identifierLabel: unknown; actions: DmAction[] };
  addDevice(ctx: MockCtx): Promise<{ refresh: boolean }>;
  editDevice(cardId: string, ctx: MockCtx): Promise<{ refresh: "devices" }>;
  deleteDevice(cardId: string, ctx: MockCtx): Promise<{ refresh: "devices" }>;
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
    vi.clearAllMocks();
  });

  const living = { name: "Living room", ip: "192.168.1.10" };
  const kitchen = { name: "Kitchen", ip: "192.168.1.11" };

  it("shows the manual table when it is filled", async () => {
    const out = await cards([living, kitchen]);
    expect(out.map(c => c.id)).toEqual(["Living_room", "Kitchen"]);
    expect(out.map(c => c.identifier)).toEqual(["192.168.1.10", "192.168.1.11"]);
    expect(readDiscovered).not.toHaveBeenCalled();
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
    expect(out[0].indicators.map(i => i.value.stateId)).toEqual([
      "yamaha.0.Living_room.info.transports.ynca",
      "yamaha.0.Living_room.info.transports.yxc",
      "yamaha.0.Living_room.info.transports.xml",
    ]);
    expect(out[0].indicators.every(i => i.hideIfEmpty)).toBe(true);
  });

  it("paints the device-class silhouette from the reported model", async () => {
    const plain = await cards([living]);
    const withModel = await cards([living], { "yamaha.0.Living_room.info.model": "WX-021" });
    expect(withModel[0].icon).not.toBe(plain[0].icon);
  });

  it("offers edit only on a manual card, delete on both", async () => {
    expect((await cards([living]))[0].actions.map(a => a.id)).toEqual(["edit", "delete"]);
    store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
    // A discovered device is re-found on the next scan — editing it would be undone.
    expect((await cards([]))[0].actions.map(a => a.id)).toEqual(["delete"]);
  });

  it("declares the v3 API and a single add action", () => {
    const info = make([]).getInstanceInfo();
    expect(info.apiVersion).toBe("v3");
    expect(info.identifierLabel).toBe("ipLabel");
    expect(info.actions.map(a => a.id)).toEqual(["add"]);
  });

  describe("add", () => {
    it("appends the device and trims what the user typed", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "  Bedroom  ", ip: " 192.168.1.50 " } });
      await expect(i.addDevice(ctx)).resolves.toEqual({ refresh: true });
      expect(adapter._stored()).toEqual([living, { name: "Bedroom", ip: "192.168.1.50" }]);
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
    it("removes exactly the selected manual row after confirmation", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ confirm: true });
      // The SECOND row on purpose: deleting the first one cannot tell "the chosen
      // row" from "the first row" apart.
      await expect(i.deleteDevice("Kitchen", ctx)).resolves.toEqual({ refresh: "devices" });
      expect(ctx.showConfirmation).toHaveBeenCalledWith({ key: "dmDeleteConfirm", args: ["Kitchen"] });
      expect(adapter._stored()).toEqual([living]);
    });

    it("keeps the row when the user declines", async () => {
      const i = make([living, kitchen]);
      await i.deleteDevice("Living_room", mockContext({ confirm: false }));
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("does not even ask for a manual card that is gone", async () => {
      const i = make([living]);
      const ctx = mockContext({ confirm: true });
      await i.deleteDevice("ghost", ctx);
      expect(ctx.showConfirmation).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("forgets a discovered device so the next scan does not resurrect it", async () => {
      store.devices = [
        { id: "rx-v685", ip: "192.168.1.20" },
        { id: "wx-021", ip: "192.168.1.21" },
      ];
      const i = make([]);
      await expect(i.deleteDevice("rx-v685", mockContext({ confirm: true }))).resolves.toEqual({ refresh: "devices" });
      // Deleting only the objects would let the standby-protection merge bring the
      // device back on the next start — the user could never get rid of it.
      expect(writeDiscovered).toHaveBeenCalledWith({}, [{ id: "wx-021", ip: "192.168.1.21" }]);
    });

    it("keeps a discovered device when the user declines, and asks nothing for an unknown one", async () => {
      store.devices = [{ id: "rx-v685", ip: "192.168.1.20" }];
      const i = make([]);
      await i.deleteDevice("rx-v685", mockContext({ confirm: false }));
      expect(writeDiscovered).not.toHaveBeenCalled();

      const ctx = mockContext({ confirm: true });
      await i.deleteDevice("ghost", ctx);
      expect(ctx.showConfirmation).not.toHaveBeenCalled();
      expect(writeDiscovered).not.toHaveBeenCalled();
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
});

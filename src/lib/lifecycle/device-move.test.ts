import {
  copyDeviceTree,
  enumMembersUnder,
  movedAliasTarget,
  movedId,
  rewriteMovedObject,
  type DeviceMoveDeps,
} from "./device-move";

const NS = "yamaha.0";

/** The in-memory database of one test, and the move's calls over it. */
interface Database {
  /** What the database holds, and the order of the object writes. */
  db: {
    objects: Map<string, ioBroker.Object>;
    states: Map<string, ioBroker.State>;
    written: string[];
  };
  /** The calls a move makes. */
  deps: DeviceMoveDeps;
}

/**
 * An in-memory objects/states database with the calls a move uses.
 *
 * @param objects the objects it holds, by full id
 * @param states the states it holds, by full id
 * @returns the database and the move's calls over it
 */
function database(objects: Record<string, unknown>, states: Record<string, unknown> = {}): Database {
  const db = {
    objects: new Map(Object.entries(objects)) as Map<string, ioBroker.Object>,
    states: new Map(Object.entries(states)) as Map<string, ioBroker.State>,
    written: [] as string[],
  };
  const byPrefix = <T>(map: Map<string, T>, prefix: string): Record<string, T> =>
    Object.fromEntries([...map].filter(([id]) => id.startsWith(prefix)));
  const deps: DeviceMoveDeps = {
    namespace: NS,
    objects: () => Promise.resolve(byPrefix(db.objects, `${NS}.`)),
    states: pattern => Promise.resolve(byPrefix(db.states, pattern.replace(/\*$/, ""))),
    setObject: (id, obj) => {
      db.objects.set(id, JSON.parse(JSON.stringify(obj)) as ioBroker.Object);
      db.written.push(id);
      return Promise.resolve();
    },
    extendObject: (id, patch) => {
      const prev = db.objects.get(id) ?? ({} as ioBroker.Object);
      db.objects.set(id, {
        ...prev,
        native: { ...(prev.native ?? {}), ...((patch.native as Record<string, unknown>) ?? {}) },
      } as ioBroker.Object);
      db.written.push(id);
      return Promise.resolve();
    },
    setState: (id, state) => {
      db.states.set(id, state as ioBroker.State);
      return Promise.resolve();
    },
    aliases: () => Promise.resolve(byPrefix(db.objects, "alias.")),
    setForeignObject: (id, obj) => {
      db.objects.set(id, JSON.parse(JSON.stringify(obj)) as ioBroker.Object);
      return Promise.resolve();
    },
  };
  return { db, deps };
}

/** The tree of an upgraded 2.x installation: "Büro" was given the id `B_ro`. */
function upgradedTree(): Record<string, unknown> {
  return {
    [`${NS}.B_ro`]: {
      type: "device",
      common: { name: "Büro", statusStates: { onlineId: `${NS}.B_ro.info.connection` } },
      native: {
        label: "Büro",
        labelRank: 2,
        identity: { mac: "00A0DED4F504" },
        movingTo: "WX-030_00A0DED4F504",
        capabilityProfile: JSON.stringify({ schema: 4, pendingPurge: ["B_ro.tuner.band", "B_ro.info.x"] }),
      },
    },
    [`${NS}.B_ro.info`]: { type: "channel", common: { name: "Info" }, native: {} },
    [`${NS}.B_ro.info.connection`]: { type: "state", common: { name: "Connected", type: "boolean" }, native: {} },
    [`${NS}.B_ro.volume`]: {
      type: "state",
      common: {
        name: "Volume",
        type: "number",
        custom: { "influxdb.0": { enabled: true, aliasId: "" }, "history.0": { enabled: false } },
      },
      native: {},
    },
    [`${NS}.B_roth`]: { type: "device", common: { name: "Other" }, native: {} },
    [`${NS}.info.connection`]: { type: "state", common: { name: "Adapter" }, native: {} },
    "enum.rooms.office": {
      type: "enum",
      common: { name: "Office", members: [`${NS}.B_ro`, `${NS}.B_ro.volume`, "hm-rpc.0.X.1.STATE"] },
      native: {},
    },
    "alias.0.office.volume": {
      type: "state",
      common: { name: "Vol", alias: { id: `${NS}.B_ro.volume` } },
      native: {},
    },
    "alias.0.office.power": {
      type: "state",
      common: { name: "Pwr", alias: { id: { read: `${NS}.B_ro.power`, write: "javascript.0.x" } } },
      native: {},
    },
    "alias.0.other": { type: "state", common: { name: "O", alias: { id: `${NS}.B_roth.power` } }, native: {} },
  };
}

describe("movedId", () => {
  test("moves the device and everything below it — nothing that only starts with its name", () => {
    expect(movedId(`${NS}.B_ro`, `${NS}.B_ro`, `${NS}.W`)).toBe(`${NS}.W`);
    expect(movedId(`${NS}.B_ro.info.connection`, `${NS}.B_ro`, `${NS}.W`)).toBe(`${NS}.W.info.connection`);
    expect(movedId(`${NS}.B_roth.power`, `${NS}.B_ro`, `${NS}.W`)).toBeUndefined();
  });
});

describe("movedAliasTarget", () => {
  test("follows a plain target and each half of a read/write pair", () => {
    expect(movedAliasTarget(`${NS}.B_ro.volume`, `${NS}.B_ro`, `${NS}.W`)).toBe(`${NS}.W.volume`);
    expect(movedAliasTarget({ read: `${NS}.B_ro.power`, write: "js.0.x" }, `${NS}.B_ro`, `${NS}.W`)).toEqual({
      read: `${NS}.W.power`,
      write: "js.0.x",
    });
    expect(movedAliasTarget(`${NS}.B_roth.power`, `${NS}.B_ro`, `${NS}.W`)).toBeUndefined();
    expect(movedAliasTarget(undefined, `${NS}.B_ro`, `${NS}.W`)).toBeUndefined();
  });
});

describe("rewriteMovedObject", () => {
  test("points the reachability link, the purge memory and the journal at the new id", () => {
    const tree = upgradedTree();
    const { object } = rewriteMovedObject(
      `${NS}.B_ro`,
      tree[`${NS}.B_ro`] as ioBroker.Object,
      "B_ro",
      "WX-030_00A0DED4F504",
      NS,
    );
    const common = object.common as { name: string; statusStates: { onlineId: string } };
    const native = object.native as Record<string, unknown>;
    expect(common.statusStates.onlineId).toBe(`${NS}.WX-030_00A0DED4F504.info.connection`);
    expect(JSON.parse(native.capabilityProfile as string).pendingPurge).toEqual([
      "WX-030_00A0DED4F504.tuner.band",
      "WX-030_00A0DED4F504.info.x",
    ]);
    expect(native.movingTo).toBeUndefined();
    // A name the device reported travels as it is.
    expect(common.name).toBe("Büro");
    expect(native.label).toBe("Büro");
  });

  test("a placeholder name becomes the new placeholder, not a name the user seems to have typed", () => {
    const { object } = rewriteMovedObject(
      `${NS}.10_10_0_17`,
      { type: "device", common: { name: "10_10_0_17" }, native: { label: "10_10_0_17", labelRank: 3 } } as never,
      "10_10_0_17",
      "R-N500_AABBCCDDEEFF",
      NS,
    );
    expect((object.common as { name: string }).name).toBe("R-N500_AABBCCDDEEFF");
    expect(object.native).toEqual({});
  });

  test("an enabled recording keeps its series under the old id, a disabled one is left alone", () => {
    const tree = upgradedTree();
    const { object, history } = rewriteMovedObject(
      `${NS}.B_ro.volume`,
      tree[`${NS}.B_ro.volume`] as ioBroker.Object,
      "B_ro",
      "W",
      NS,
    );
    expect(history).toBe(1);
    expect((object.common as { custom: unknown }).custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: `${NS}.B_ro.volume` },
      "history.0": { enabled: false },
    });
  });

  test("an alias id the user set stays", () => {
    const { object, history } = rewriteMovedObject(
      `${NS}.B_ro.volume`,
      { type: "state", common: { custom: { "sql.0": { enabled: true, aliasId: "my.series" } } }, native: {} } as never,
      "B_ro",
      "W",
      NS,
    );
    expect(history).toBe(0);
    expect((object.common as { custom: unknown }).custom).toEqual({ "sql.0": { enabled: true, aliasId: "my.series" } });
  });
});

describe("copyDeviceTree", () => {
  test("carries objects, values and alias targets to the new id — rooms are the delete's business", async () => {
    const { db, deps } = database(upgradedTree(), {
      [`${NS}.B_ro.volume`]: { val: 42, ack: true, ts: 1000, lc: 900, q: 0 },
      [`${NS}.B_ro.info.connection`]: { val: true, ack: true, ts: 2000, lc: 2000 },
      [`${NS}.B_roth.power`]: { val: true, ack: true, ts: 1, lc: 1 },
    });
    const report = await copyDeviceTree(deps, "B_ro", "WX-030_00A0DED4F504");
    const to = `${NS}.WX-030_00A0DED4F504`;
    expect(report).toEqual({ datapoints: 2, enums: 0, aliases: 2, history: 1 });
    expect(db.objects.get(to)?.native).toMatchObject({ idScheme: 3, identity: { mac: "00A0DED4F504" } });
    expect(db.objects.get(`${to}.info`)?.type).toBe("channel");
    expect(db.states.get(`${to}.volume`)).toEqual({ val: 42, ack: true, ts: 1000, lc: 900, q: 0 });
    expect(db.states.get(`${to}.info.connection`)).toEqual({ val: true, ack: true, ts: 2000, lc: 2000 });
    // Untouched here: an id written before the delete would be taken away by it (enum-carry.ts).
    expect(db.objects.get("enum.rooms.office")?.common.members).toEqual([
      `${NS}.B_ro`,
      `${NS}.B_ro.volume`,
      "hm-rpc.0.X.1.STATE",
    ]);
    expect((db.objects.get("alias.0.office.volume")?.common as { alias: unknown }).alias).toEqual({
      id: `${to}.volume`,
    });
    expect((db.objects.get("alias.0.office.power")?.common as { alias: unknown }).alias).toEqual({
      id: { read: `${to}.power`, write: "javascript.0.x" },
    });
    // A device whose id merely starts with the same letters is not touched.
    expect(db.objects.has(`${NS}.WX-030_00A0DED4F504th`)).toBe(false);
    expect((db.objects.get("alias.0.other")?.common as { alias: unknown }).alias).toEqual({
      id: `${NS}.B_roth.power`,
    });
    // The old tree is still there — deleting it is the caller's last step.
    expect(db.objects.has(`${NS}.B_ro.volume`)).toBe(true);
  });

  test("writes the device object last, and marks it final only after everything below it", async () => {
    const { db, deps } = database(upgradedTree());
    await copyDeviceTree(deps, "B_ro", "W");
    const to = `${NS}.W`;
    const firstDeviceWrite = db.written.indexOf(to);
    expect(db.written.slice(0, firstDeviceWrite)).toEqual([`${to}.info`, `${to}.volume`, `${to}.info.connection`]);
    expect(db.written.at(-1)).toBe(to);
  });

  test("an interrupted move is completed without copying a finished tree twice", async () => {
    const { db, deps } = database(upgradedTree(), { [`${NS}.B_ro.volume`]: { val: 42, ack: true, ts: 1, lc: 1 } });
    await copyDeviceTree(deps, "B_ro", "W");
    db.states.set(`${NS}.W.volume`, { val: 7, ack: true, ts: 5, lc: 5 } as ioBroker.State);
    db.written.length = 0;
    const again = await copyDeviceTree(deps, "B_ro", "W");
    expect(again.datapoints).toBe(0);
    expect(db.written).toEqual([]);
    expect(db.states.get(`${NS}.W.volume`)?.val).toBe(7);
  });

  test("a copy cut short before the mark is done again", async () => {
    const { db, deps } = database(upgradedTree());
    // The first run wrote one child and stopped — no mark on the new device object.
    db.objects.set(`${NS}.W.info`, { type: "channel", common: { name: "Info" }, native: {} } as ioBroker.Object);
    const report = await copyDeviceTree(deps, "B_ro", "W");
    expect(report.datapoints).toBe(2);
    expect(db.objects.get(`${NS}.W`)?.native).toMatchObject({ idScheme: 3 });
  });
});

describe("enumMembersUnder", () => {
  test("names every id of the moved tree that a room or function lists, and nothing else", () => {
    const enums = upgradedTree();
    expect(enumMembersUnder(enums, `${NS}.B_ro`)).toEqual([`${NS}.B_ro`, `${NS}.B_ro.volume`]);
    expect(enumMembersUnder({ "enum.x": { common: { members: [`${NS}.B_roth.power`] } } }, `${NS}.B_ro`)).toEqual([]);
    expect(enumMembersUnder(undefined, `${NS}.B_ro`)).toEqual([]);
  });
});

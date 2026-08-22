import {
  legacyDeviceRow,
  mergeDiscovered,
  parseDevices,
  renamedObjectIds,
  sanitizeId,
  staleObjects,
  stripNamespace,
} from "./pure-helpers";

describe("legacyDeviceRow", () => {
  test("carries over the old single ip when the table is empty", () => {
    expect(legacyDeviceRow({ ip: "1.2.3.4" })).toEqual({ name: "1.2.3.4", ip: "1.2.3.4" });
  });

  test("handles the capitalized legacy IP key", () => {
    expect(legacyDeviceRow({ IP: "1.2.3.4" })).toEqual({ name: "1.2.3.4", ip: "1.2.3.4" });
  });

  test("does nothing when the devices table is already populated", () => {
    expect(legacyDeviceRow({ ip: "1.2.3.4", devices: [{ name: "a", ip: "5.6.7.8" }] })).toBeUndefined();
  });

  test("does nothing without a legacy ip", () => {
    expect(legacyDeviceRow({ devices: [] })).toBeUndefined();
  });

  test("strips a :port suffix (the old HTTP lib accepted host:port; our transports must not)", () => {
    expect(legacyDeviceRow({ ip: "1.2.3.4:80" })).toEqual({ name: "1.2.3.4", ip: "1.2.3.4" });
  });

  test("carries a hostname over unchanged (the old adapter resolved names too)", () => {
    expect(legacyDeviceRow({ ip: "receiver.fritz.box" })).toEqual({
      name: "receiver.fritz.box",
      ip: "receiver.fritz.box",
    });
    expect(legacyDeviceRow({ ip: " receiver.fritz.box:8080 " })).toEqual({
      name: "receiver.fritz.box",
      ip: "receiver.fritz.box",
    });
  });
});

describe("upgrade path from the original 0.5.4 adapter (the ~800 existing installs)", () => {
  // The COMPLETE object tree the original adapter created: all 46 unique ids from its
  // io-package.json instanceObjects (verified against the live community master), plus the
  // ids its soef layer created dynamically at runtime (inputEnum, SystemConfig.features,
  // Realtime.online/reconnect/raw and one Realtime.<SUBUNIT>.<FUNC> per received YNCA line).
  const NS = "yamaha.0";
  const legacyRelativeIds = [
    // channels/devices
    "Commands",
    "Realtime",
    "SystemConfig",
    // instanceObjects states
    "Realtime.MAIN.PWR",
    "SystemConfig.name",
    "SystemConfig.version",
    "Commands.xmlCommand",
    "Commands.command",
    "Commands.webradio",
    "Commands.volumeUp",
    "Commands.volumeDown",
    "Commands.adjustVolume",
    "Commands.toggleMute",
    "Commands.stop",
    "Commands.pause",
    "Commands.skip",
    "Commands.rewind",
    "Commands.partyModeVolumeUp",
    "Commands.partyModeVolumeDown",
    "Commands.InputTo",
    "Commands.zone",
    "volume",
    "input",
    "surround",
    "mute",
    "power",
    "refresh",
    "YPAOVolume",
    "extraBass",
    "adaptiveDRC",
    "partyMode",
    "hdmiOut1",
    "hdmiOut2",
    "pureDirect",
    "bass",
    "treble",
    "subwooferLevel",
    "dialogLift",
    "dialogLevel",
    "scene",
    "zone1",
    "zone2",
    "zone3",
    "zone4",
    "powerAllZones",
    "sleep",
    // runtime-created by the old soef layer
    "inputEnum",
    "SystemConfig.features",
    "Realtime.online",
    "Realtime.reconnect",
    "Realtime.raw",
    "Realtime.MAIN",
    "Realtime.MAIN.VOL",
    "Realtime.ZONE2",
    "Realtime.ZONE2.PWR",
    "Realtime.SYS",
    "Realtime.SYS.MODELNAME",
  ];

  test("migrating the old config and cleaning up removes EVERY legacy object and keeps info", () => {
    // Step 1: the old native config carries one receiver ip — it becomes the device table row.
    const row = legacyDeviceRow({ ip: "192.168.1.50", intervall: 120, useRealtime: true });
    expect(row).toEqual({ name: "192.168.1.50", ip: "192.168.1.50" });
    const devices = parseDevices([row]);
    expect(devices).toEqual([{ id: "192_168_1_50", ip: "192.168.1.50" }]);

    // Step 2: start-up cleanup sees the full legacy tree plus our own info objects.
    const existing = [`${NS}.info`, `${NS}.info.connection`, ...legacyRelativeIds.map(id => `${NS}.${id}`)];
    const deviceIds = new Set(devices.map(d => d.id));
    const stale = staleObjects(existing, deviceIds, NS);

    // EVERY legacy object is removed — none survives, none is missed…
    expect(new Set(stale)).toEqual(new Set(legacyRelativeIds.map(id => `${NS}.${id}`)));
    // …the adapter's own info branch is untouched…
    expect(stale).not.toContain(`${NS}.info`);
    expect(stale).not.toContain(`${NS}.info.connection`);
    // …and children are deleted before their parents (deepest first).
    expect(stale.indexOf(`${NS}.Realtime.MAIN.PWR`)).toBeLessThan(stale.indexOf(`${NS}.Realtime.MAIN`));
    expect(stale.indexOf(`${NS}.Realtime.MAIN`)).toBeLessThan(stale.indexOf(`${NS}.Realtime`));
  });

  test("the migrated device's new subtree is never touched by the cleanup", () => {
    const existing = [
      `${NS}.192_168_1_50`,
      `${NS}.192_168_1_50.power`,
      `${NS}.192_168_1_50.info.connection`,
      `${NS}.power`, // legacy leftover
    ];
    const stale = staleObjects(existing, new Set(["192_168_1_50"]), NS);
    expect(stale).toEqual([`${NS}.power`]);
  });

  test("an empty old ip migrates nothing and the cleanup deletes nothing (no-wipe guard)", () => {
    // ip "" was the old default before its discovery filled it — no row, no devices, and
    // the empty-table guard must keep the whole tree until discovery finds the receiver.
    expect(legacyDeviceRow({ ip: "" })).toBeUndefined();
    const existing = legacyRelativeIds.map(id => `${NS}.${id}`);
    expect(staleObjects(existing, new Set(), NS)).toEqual([]);
  });
});

describe("mergeDiscovered", () => {
  test("turns a fresh discovery into device records", () => {
    expect(mergeDiscovered([], [{ ip: "1.1.1.1", name: "Living" }])).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
  });

  test("keeps a known device the scan did not find this run (standby)", () => {
    expect(mergeDiscovered([{ id: "Living", ip: "1.1.1.1" }], [])).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
  });

  test("keeps the known id and ip when the same device is rediscovered", () => {
    expect(mergeDiscovered([{ id: "Living", ip: "1.1.1.1" }], [{ ip: "1.1.1.1", name: "Renamed" }])).toEqual([
      { id: "Living", ip: "1.1.1.1" },
    ]);
  });

  test("adds a newly discovered address to the known ones", () => {
    expect(mergeDiscovered([{ id: "Living", ip: "1.1.1.1" }], [{ ip: "2.2.2.2", name: "Kitchen" }])).toEqual([
      { id: "Living", ip: "1.1.1.1" },
      { id: "Kitchen", ip: "2.2.2.2" },
    ]);
  });

  test("falls back to the ip as id when a device advertises no name", () => {
    expect(mergeDiscovered([], [{ ip: "3.3.3.3", name: "" }])).toEqual([{ id: "3_3_3_3", ip: "3.3.3.3" }]);
  });

  test("skips a discovery whose id would collide with a kept device — and reports it", () => {
    const collisions: Array<[string, string]> = [];
    expect(
      mergeDiscovered([{ id: "Living", ip: "1.1.1.1" }], [{ ip: "9.9.9.9", name: "Living" }], (dropped, takenId) =>
        collisions.push([dropped, takenId]),
      ),
    ).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
    expect(collisions).toEqual([["Living", "Living"]]);
  });
});

describe("staleObjects", () => {
  test("keeps info and configured devices, deletes the rest deepest-first", () => {
    const existing = [
      "yamaha.0.info",
      "yamaha.0.info.connection",
      "yamaha.0.living",
      "yamaha.0.living.power",
      "yamaha.0.oldDevice",
      "yamaha.0.oldDevice.legacyState",
    ];
    expect(staleObjects(existing, new Set(["living"]), "yamaha.0")).toEqual([
      "yamaha.0.oldDevice.legacyState",
      "yamaha.0.oldDevice",
    ]);
  });

  test("keeps a configured device even before its subtree exists, and never touches info", () => {
    expect(staleObjects(["yamaha.0.info", "yamaha.0.living"], new Set(["living"]), "yamaha.0")).toEqual([]);
  });

  test("deletes nothing when no devices are configured (never wipe on an empty table)", () => {
    const existing = ["yamaha.0.info", "yamaha.0.living.power", "yamaha.0.old.state"];
    expect(staleObjects(existing, new Set(), "yamaha.0")).toEqual([]);
  });
});

describe("parseDevices", () => {
  test("maps a configured entry to a device record", () => {
    expect(parseDevices([{ name: "Living", ip: "1.2.3.4" }])).toEqual([{ id: "Living", ip: "1.2.3.4" }]);
  });

  test("drops a duplicate id and the reserved 'info' name (would share one object tree) — and reports them", () => {
    const collisions: Array<[string, string]> = [];
    const result = parseDevices(
      [
        { name: "Living Room", ip: "1.1.1.1" },
        { name: "Living.Room", ip: "2.2.2.2" }, // sanitises to the same id → dropped
        { name: "info", ip: "3.3.3.3" }, // reserved → dropped
      ],
      (dropped, takenId) => collisions.push([dropped, takenId]),
    );
    expect(result).toEqual([{ id: "Living_Room", ip: "1.1.1.1" }]);
    expect(collisions).toEqual([
      ["Living.Room", "Living_Room"],
      ["info", "info"],
    ]);
  });

  test("falls back to the ip as id when the name is blank, drops rows without an ip", () => {
    const result = parseDevices([
      { name: "ok", ip: "1.1.1.1" },
      { name: "", ip: "2.2.2.2" }, // blank name -> ip as id
      { name: "no-ip" }, // no ip -> dropped
      { ip: "3.3.3.3" }, // no name -> ip as id
      "garbage",
      null,
    ]);
    expect(result.map(d => d.id)).toEqual(["ok", "2_2_2_2", "3_3_3_3"]);
  });

  test("returns an empty array for non-array input", () => {
    expect(parseDevices(undefined)).toEqual([]);
    expect(parseDevices(null)).toEqual([]);
    expect(parseDevices("nope")).toEqual([]);
  });

  test("sanitizes the device name into an id-safe id", () => {
    expect(parseDevices([{ name: "Wohn AV", ip: "1.2.3.4" }])[0]?.id).toBe("Wohn_AV");
  });
});

describe("sanitizeId", () => {
  test("replaces id-unsafe characters with underscores", () => {
    expect(sanitizeId("Wohnzimmer AV")).toBe("Wohnzimmer_AV");
    expect(sanitizeId("a.b/c")).toBe("a_b_c");
  });

  test("leaves an already-safe id unchanged", () => {
    expect(sanitizeId("Living-Room_1")).toBe("Living-Room_1");
  });
});

describe("stripNamespace", () => {
  test("removes the adapter namespace prefix from a full state id", () => {
    expect(stripNamespace("yamaha.0.living.power", "yamaha.0")).toBe("living.power");
  });

  test("handles a nested state path", () => {
    expect(stripNamespace("yamaha.0.living.zone2.power", "yamaha.0")).toBe("living.zone2.power");
  });
});

describe("renamedObjectIds", () => {
  test("returns the old renamed states present under a configured device", () => {
    const existing = [
      "yamaha.0.living.system.model",
      "yamaha.0.living.system",
      "yamaha.0.living.hdmiOut",
      "yamaha.0.living.directMode",
      "yamaha.0.living.power",
      "yamaha.0.other.system.model",
    ];
    const result = renamedObjectIds(existing, new Set(["living"]), "yamaha.0");
    expect(result).toContain("yamaha.0.living.system.model"); // under the old system channel
    expect(result).toContain("yamaha.0.living.system"); // the old system channel itself
    expect(result).toContain("yamaha.0.living.hdmiOut"); // exact rename -> hdmi.output
    expect(result).toContain("yamaha.0.living.directMode"); // exact rename -> direct
    expect(result).not.toContain("yamaha.0.living.power"); // not renamed
    expect(result).not.toContain("yamaha.0.other.system.model"); // not a configured device
    // deepest first: the state under system before the system channel itself
    expect(result.indexOf("yamaha.0.living.system.model")).toBeLessThan(result.indexOf("yamaha.0.living.system"));
  });

  test("regroups old flat media/dab/dist channels away, keeping the new grouped ids", () => {
    const existing = [
      "yamaha.0.living.spotify.playback", // old flat source → gone
      "yamaha.0.living.spotify",
      "yamaha.0.living.dab.band", // old flat dab → gone
      "yamaha.0.living.dist.role", // old dist → gone
      "yamaha.0.living.cd.play", // old flat cd → gone
      "yamaha.0.living.player.spotify.playback", // new grouped id → kept
      "yamaha.0.living.tuner.dab.band", // new grouped dab → kept
      "yamaha.0.living.tuner.band", // tuner core, unchanged → kept
      "yamaha.0.living.multiroom.group.role", // new multiroom group folder → kept
      "yamaha.0.living.power", // amp core → kept
    ];
    const result = renamedObjectIds(existing, new Set(["living"]), "yamaha.0");
    expect(result).toEqual(
      expect.arrayContaining([
        "yamaha.0.living.spotify.playback",
        "yamaha.0.living.dab.band",
        "yamaha.0.living.dist.role",
        "yamaha.0.living.cd.play",
      ]),
    );
    expect(result).not.toContain("yamaha.0.living.player.spotify.playback");
    expect(result).not.toContain("yamaha.0.living.tuner.dab.band");
    expect(result).not.toContain("yamaha.0.living.tuner.band");
    expect(result).not.toContain("yamaha.0.living.multiroom.group.role");
    expect(result).not.toContain("yamaha.0.living.power");
  });

  test("returns nothing when the old renamed state is absent", () => {
    expect(renamedObjectIds(["yamaha.0.living.info.model"], new Set(["living"]), "yamaha.0")).toEqual([]);
  });

  test("prunes the old bare sound/advanced states, on MAIN and on a zoned copy alike", () => {
    const existing = [
      "yamaha.0.living.enhancer", // old bare MAIN state → gone (now sound.enhancer)
      "yamaha.0.living.zone2.enhancer", // old bare zoned state → gone (zone2 is renamed channel)
      "yamaha.0.living.maxVolume", // old bare state → gone (now advanced.maxVolume)
      "yamaha.0.living.speakers.pattern", // old subtree → gone (now advanced.speakers.pattern)
      "yamaha.0.living.sound.enhancer", // new grouped id → kept
      "yamaha.0.living.zone2.sound.enhancer", // old zone2 prefix → gone (zone2 renamed to multiroom.zone2)
      "yamaha.0.living.zone2.volume", // old zone2 prefix → gone (zone2 renamed to multiroom.zone2)
      "yamaha.0.living.advanced.maxVolume", // new grouped id → kept
      "yamaha.0.living.advanced.speakers.pattern", // new grouped id → kept
      "yamaha.0.living.multiroom.zone2.sound.enhancer", // new multiroom-prefixed zoned id → kept
      "yamaha.0.living.multiroom.zone2.volume", // new multiroom-prefixed zoned amp core → kept
    ];
    const result = renamedObjectIds(existing, new Set(["living"]), "yamaha.0");
    expect(result).toEqual(
      expect.arrayContaining([
        "yamaha.0.living.enhancer",
        "yamaha.0.living.zone2.enhancer",
        "yamaha.0.living.zone2.sound.enhancer",
        "yamaha.0.living.zone2.volume",
        "yamaha.0.living.maxVolume",
        "yamaha.0.living.speakers.pattern",
      ]),
    );
    expect(result).not.toContain("yamaha.0.living.sound.enhancer");
    expect(result).not.toContain("yamaha.0.living.advanced.maxVolume");
    expect(result).not.toContain("yamaha.0.living.advanced.speakers.pattern");
    expect(result).not.toContain("yamaha.0.living.multiroom.zone2.sound.enhancer");
    expect(result).not.toContain("yamaha.0.living.multiroom.zone2.volume");
  });

  test("moves the MusicCast-Link states into multiroom.group and sweeps the zone-junk copies", () => {
    const existing = [
      // v1.0.0 pre-group ids → gone (moved into multiroom.group)
      "yamaha.0.living.multiroom.role",
      "yamaha.0.living.multiroom.groupId",
      "yamaha.0.living.multiroom.groupName",
      "yamaha.0.living.multiroom.serverZone",
      "yamaha.0.living.multiroom.clientList",
      "yamaha.0.living.multiroom.linkClient",
      "yamaha.0.living.multiroom.leaveGroup",
      "yamaha.0.living.multiroom.distributionEnable",
      // short-lived pre-cut id (mislabeled "active") → gone
      "yamaha.0.living.multiroom.group.streamingActive",
      // stray per-zone copies of device-global states → gone (channel + states)
      "yamaha.0.living.multiroom.zone2.multiroom",
      "yamaha.0.living.multiroom.zone2.multiroom.party",
      "yamaha.0.living.multiroom.zone2.multiroom.distributionEnable",
      // the new ids and the untouched all-zones states → kept
      "yamaha.0.living.multiroom.group.role",
      "yamaha.0.living.multiroom.group.linkedDevices",
      "yamaha.0.living.multiroom.party",
      "yamaha.0.living.multiroom.masterPower",
      "yamaha.0.living.multiroom.zone2.power",
    ];
    const result = renamedObjectIds(existing, new Set(["living"]), "yamaha.0");
    expect(result).toEqual(
      expect.arrayContaining([
        "yamaha.0.living.multiroom.role",
        "yamaha.0.living.multiroom.groupId",
        "yamaha.0.living.multiroom.groupName",
        "yamaha.0.living.multiroom.serverZone",
        "yamaha.0.living.multiroom.clientList",
        "yamaha.0.living.multiroom.linkClient",
        "yamaha.0.living.multiroom.leaveGroup",
        "yamaha.0.living.multiroom.distributionEnable",
        "yamaha.0.living.multiroom.group.streamingActive",
        "yamaha.0.living.multiroom.zone2.multiroom",
        "yamaha.0.living.multiroom.zone2.multiroom.party",
        "yamaha.0.living.multiroom.zone2.multiroom.distributionEnable",
      ]),
    );
    expect(result).not.toContain("yamaha.0.living.multiroom.group.role");
    expect(result).not.toContain("yamaha.0.living.multiroom.group.linkedDevices");
    expect(result).not.toContain("yamaha.0.living.multiroom.party");
    expect(result).not.toContain("yamaha.0.living.multiroom.masterPower");
    expect(result).not.toContain("yamaha.0.living.multiroom.zone2.power");
    // children before their channel, so the deletes cascade cleanly
    expect(result.indexOf("yamaha.0.living.multiroom.zone2.multiroom.party")).toBeLessThan(
      result.indexOf("yamaha.0.living.multiroom.zone2.multiroom"),
    );
  });
});

describe("mergeDiscovered id collisions among the remembered devices", () => {
  it("drops a remembered device that would take another one's object id", () => {
    const merged = mergeDiscovered(
      [
        { id: "RX-V685", ip: "192.168.1.20" },
        { id: "RX-V685", ip: "192.168.1.21" },
      ],
      [],
    );
    // The store is written by earlier runs and can carry two entries that collapse
    // onto one id (a renamed receiver, a re-used name). Keeping both would put two
    // devices on one object tree, each overwriting the other's values.
    expect(merged).toEqual([{ id: "RX-V685", ip: "192.168.1.20" }]);
  });

  it("never lets a remembered device take the adapter's own info branch", () => {
    expect(mergeDiscovered([{ id: "info", ip: "192.168.1.20" }], [])).toEqual([]);
  });
});

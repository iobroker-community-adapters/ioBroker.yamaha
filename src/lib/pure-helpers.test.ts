import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogToObjects } from "./catalog/build-objects";
import { YNCA_CATALOG } from "./ynca/catalog";
import { XML_AMP_CATALOG } from "./xml/catalog";
import { parseYxcFeatures } from "./yxc/capability";
import { mapYxcToObjects } from "./yxc/object-mapper";
import {
  isUsefulDeviceName,
  LABEL_RANK,
  legacyDeviceRow,
  mergeDiscovered,
  childlessChannelIds,
  neverWrittenStateIds,
  nextDeviceLabel,
  parseDevices,
  RENAMED_CHANNELS,
  RENAMED_STATE_IDS,
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

  test("keeps the known id when the device renamed itself — the id carries the whole object tree", () => {
    // The address is already claimed by the remembered record, so the new name does not open a
    // second tree; renaming a receiver must not orphan its history and visualisation bindings.
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

  test("carries a new address over when the same device moved (DHCP), instead of dropping it", () => {
    // Keyed by address this was a dead end: the remembered record kept 1.1.1.1, the same
    // receiver found at 9.9.9.9 produced the same id, and the id clash dropped it — the device
    // stayed offline for good. Identity is the id, so the address simply follows.
    const collisions: Array<[string, string]> = [];
    expect(
      mergeDiscovered([{ id: "Living", ip: "1.1.1.1" }], [{ ip: "9.9.9.9", name: "Living" }], (dropped, takenId) =>
        collisions.push([dropped, takenId]),
      ),
    ).toEqual([{ id: "Living", ip: "9.9.9.9" }]);
    expect(collisions).toEqual([]);
  });

  test("does not mutate the remembered records handed in", () => {
    const known = [{ id: "Living", ip: "1.1.1.1" }];
    mergeDiscovered(known, [{ ip: "9.9.9.9", name: "Living" }]);
    expect(known).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
  });

  test("skips a DIFFERENT device sitting on an address another record already claims — and reports it", () => {
    const collisions: Array<[string, string]> = [];
    expect(
      mergeDiscovered([{ id: "Living", ip: "1.1.1.1" }], [{ ip: "1.1.1.1", name: "Kitchen" }], (dropped, takenId) =>
        collisions.push([dropped, takenId]),
      ),
    ).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
    expect(collisions).toEqual([["Kitchen", "Living"]]);
  });

  test("never lets a discovery claim the adapter's own info channel", () => {
    const collisions: Array<[string, string]> = [];
    expect(
      mergeDiscovered([], [{ ip: "4.4.4.4", name: "info" }], (dropped, takenId) => collisions.push([dropped, takenId])),
    ).toEqual([]);
    expect(collisions).toEqual([["info", "info"]]);
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
      "yamaha.0.living.player.spotify.playback", // 1.x per-source copy → gone in v2.0.0 too
      "yamaha.0.living.tuner.dab.band", // 1.x dab band → gone (unified onto tuner.band)
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
        "yamaha.0.living.player.spotify.playback",
        "yamaha.0.living.tuner.dab.band",
      ]),
    );
    expect(result).not.toContain("yamaha.0.living.tuner.band");
    expect(result).not.toContain("yamaha.0.living.multiroom.group.role");
    expect(result).not.toContain("yamaha.0.living.power");
  });

  test("v2.0.0 cleanup: block copies, scene names, tuner doubles, equalizer/signal/lipSync moves", () => {
    const existing = [
      // Per-source block copies go; the folders' own states stay.
      "yamaha.0.living.player.netPlayer.playback",
      "yamaha.0.living.player.netPlayer.source",
      "yamaha.0.living.player.netRadio.artist",
      "yamaha.0.living.player.netRadio.preset",
      "yamaha.0.living.player.netRadio.bookmark",
      "yamaha.0.living.player.cd.tray",
      "yamaha.0.living.player.bluetooth.deviceName",
      // Fully-empty source channels vanish entirely.
      "yamaha.0.living.player.tidal",
      "yamaha.0.living.player.tidal.shuffleToggle",
      // Scene names (main and zoned) became the dropdown + scene.list.
      "yamaha.0.living.scene.name3",
      "yamaha.0.living.multiroom.zone2.scene.name1",
      "yamaha.0.living.scene.recall",
      // Tuner doubles and the DAB FM half.
      "yamaha.0.living.tuner.amFrequency",
      "yamaha.0.living.tuner.dab.fmFrequency",
      "yamaha.0.living.tuner.dab.serviceLabel",
      // Equalizer/signal moved into subfolders; lipSync moved into hdmi.
      "yamaha.0.living.sound.equalizerLow",
      "yamaha.0.living.multiroom.zone2.sound.equalizerLow",
      "yamaha.0.living.sound.signalFormat",
      "yamaha.0.living.lipSync.hdmiOut1",
      "yamaha.0.living.lipSync",
      "yamaha.0.living.advanced.speakerA",
      // The new v2 ids must survive.
      "yamaha.0.living.player.playback",
      "yamaha.0.living.multiroom.zone2.player.playback",
      "yamaha.0.living.tuner.frequency",
      "yamaha.0.living.sound.equalizer.low",
      "yamaha.0.living.sound.signal.format",
      "yamaha.0.living.hdmi.lipSyncOut1",
      "yamaha.0.living.advanced.speakers.speakerA",
    ];
    const result = renamedObjectIds(existing, new Set(["living"]), "yamaha.0");
    expect(result).toEqual(
      expect.arrayContaining([
        "yamaha.0.living.player.netPlayer.playback",
        "yamaha.0.living.player.netPlayer.source",
        "yamaha.0.living.player.netRadio.artist",
        "yamaha.0.living.player.tidal",
        "yamaha.0.living.player.tidal.shuffleToggle",
        "yamaha.0.living.scene.name3",
        "yamaha.0.living.multiroom.zone2.scene.name1",
        "yamaha.0.living.tuner.amFrequency",
        "yamaha.0.living.tuner.dab.fmFrequency",
        "yamaha.0.living.sound.equalizerLow",
        "yamaha.0.living.multiroom.zone2.sound.equalizerLow",
        "yamaha.0.living.sound.signalFormat",
        "yamaha.0.living.lipSync.hdmiOut1",
        "yamaha.0.living.lipSync",
        "yamaha.0.living.advanced.speakerA",
      ]),
    );
    for (const kept of [
      "yamaha.0.living.player.netRadio.preset",
      "yamaha.0.living.player.netRadio.bookmark",
      "yamaha.0.living.player.cd.tray",
      "yamaha.0.living.player.bluetooth.deviceName",
      "yamaha.0.living.scene.recall",
      "yamaha.0.living.tuner.dab.serviceLabel",
      "yamaha.0.living.player.playback",
      "yamaha.0.living.multiroom.zone2.player.playback",
      "yamaha.0.living.tuner.frequency",
      "yamaha.0.living.sound.equalizer.low",
      "yamaha.0.living.sound.signal.format",
      "yamaha.0.living.hdmi.lipSyncOut1",
      "yamaha.0.living.advanced.speakers.speakerA",
    ]) {
      expect(result).not.toContain(kept);
    }
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

describe("isUsefulDeviceName", () => {
  it("accepts a name a user gave the device", () => {
    expect(isUsefulDeviceName("Wohnzimmer")).toBe(true);
  });

  it("rejects the zone names a receiver ships with", () => {
    for (const generic of ["Main", "Main Zone", "main zone", "Zone 1", "ZONE1"]) {
      expect(isUsefulDeviceName(generic)).toBe(false);
    }
  });

  it("rejects nothing at all", () => {
    expect(isUsefulDeviceName("")).toBe(false);
    expect(isUsefulDeviceName("   ")).toBe(false);
    expect(isUsefulDeviceName(undefined)).toBe(false);
  });
});

describe("nextDeviceLabel", () => {
  const id = "192_168_178_25";

  it("replaces the ip an upgraded instance carries as the device name", () => {
    // The whole point: after the migration the device is called by its ip.
    expect(nextDeviceLabel(id, id, "RX-V481", LABEL_RANK.model)).toBe("RX-V481");
  });

  it("names a device that has no name object yet", () => {
    expect(nextDeviceLabel(undefined, id, "RX-V481", LABEL_RANK.model)).toBe("RX-V481");
  });

  it("leaves a name the user typed alone", () => {
    expect(nextDeviceLabel("Wohnzimmer AVR", id, "RX-V481", LABEL_RANK.model)).toBeUndefined();
  });

  it("leaves the user's own ip spelling alone — it is not our placeholder", () => {
    // Our placeholder is the id (underscores); "192.168.178.25" with dots was typed.
    expect(nextDeviceLabel("192.168.178.25", id, "RX-V481", LABEL_RANK.model)).toBeUndefined();
  });

  it("upgrades its own model name to the name the device reports", () => {
    expect(nextDeviceLabel("RX-V481", id, "Wohnzimmer", LABEL_RANK.deviceName, "RX-V481", LABEL_RANK.model)).toBe(
      "Wohnzimmer",
    );
  });

  it("does not fall back from the device name to the model", () => {
    expect(
      nextDeviceLabel("Wohnzimmer", id, "RX-V481", LABEL_RANK.model, "Wohnzimmer", LABEL_RANK.deviceName),
    ).toBeUndefined();
  });

  it("writes nothing when the name is already what we would write", () => {
    expect(nextDeviceLabel("RX-V481", id, "RX-V481", LABEL_RANK.model, "RX-V481", LABEL_RANK.model)).toBeUndefined();
  });

  it("ignores a useless candidate", () => {
    expect(nextDeviceLabel(id, id, "Main Zone", LABEL_RANK.deviceName)).toBeUndefined();
    expect(nextDeviceLabel(id, id, "", LABEL_RANK.deviceName)).toBeUndefined();
  });
});

describe("childlessChannelIds (empty folders a tree rework left behind)", () => {
  const ns = "yamaha.0";
  const channel = { type: "channel", common: {} };
  const state = { type: "state", common: {} };

  test("finds folders without any datapoint below them, keeps filled ones and foreign trees", () => {
    const objects = {
      [`${ns}.living`]: { type: "device", common: {} },
      // The live case: v2.0.0 deleted the SERVER source's playback copies and the new tree
      // gives that source no datapoint of its own — the folder stayed behind empty.
      [`${ns}.living.player.server`]: channel,
      // A sibling that kept its own datapoints is untouched.
      [`${ns}.living.player.usb`]: channel,
      [`${ns}.living.player.usb.preset`]: state,
      [`${ns}.living.player`]: channel,
      [`${ns}.living.player.track`]: state,
      // Not this run's device — an offline device keeps its tree.
      [`${ns}.other.player.server`]: channel,
    };
    expect(childlessChannelIds(objects, new Set(["living"]), ns)).toEqual([`${ns}.living.player.server`]);
  });

  test("a folder counts as filled by a datapoint ANY number of levels below it", () => {
    // Only the direct parent being marked would delete `player` although `player.usb.preset`
    // lives under it.
    const objects = {
      [`${ns}.living.player`]: channel,
      [`${ns}.living.player.usb`]: channel,
      [`${ns}.living.player.usb.preset`]: state,
    };
    expect(childlessChannelIds(objects, new Set(["living"]), ns)).toEqual([]);
  });

  test("removes a folder that holds nothing but other empty folders, deepest first", () => {
    const objects = {
      [`${ns}.living.legacy`]: channel,
      [`${ns}.living.legacy.inner`]: channel,
      [`${ns}.living.legacy.inner.deeper`]: channel,
      [`${ns}.living.volume`]: state,
    };
    // Children before parents, so deleting one cannot orphan the next.
    expect(childlessChannelIds(objects, new Set(["living"]), ns)).toEqual([
      `${ns}.living.legacy.inner.deeper`,
      `${ns}.living.legacy.inner`,
      `${ns}.living.legacy`,
    ]);
  });

  test("keeps a device's info folder, which always carries its header datapoints", () => {
    const objects = {
      [`${ns}.living.info`]: channel,
      [`${ns}.living.info.connection`]: state,
      [`${ns}.living.info.transports`]: channel,
      [`${ns}.living.info.transports.ynca`]: state,
    };
    expect(childlessChannelIds(objects, new Set(["living"]), ns)).toEqual([]);
  });

  test("a device that has not connected in this run is left alone entirely", () => {
    const objects = { [`${ns}.living.player.server`]: channel };
    expect(childlessChannelIds(objects, new Set(), ns)).toEqual([]);
  });
});

describe("neverWrittenStateIds (one-time orphan purge per version)", () => {
  const ns = "yamaha.0";
  const stateObj = (read: boolean): { type: string; common: { read: boolean } } => ({
    type: "state",
    common: { read },
  });

  test("finds read-capable states that never carried a value; keeps buttons, filled states and foreign trees", () => {
    const objects = {
      [`${ns}.living.multiroom.zone2.soundProgram`]: stateObj(true), // orphan of an earlier version
      [`${ns}.living.sound.direct`]: stateObj(true), // orphan
      [`${ns}.living.player.play`]: stateObj(false), // button — naturally valueless
      [`${ns}.living.volume`]: stateObj(true), // filled
      [`${ns}.living.tuner.rdsText`]: stateObj(true), // filled with empty text (still a value)
      [`${ns}.living.player`]: { type: "channel", common: {} }, // not a state
      [`${ns}.other.sound.direct`]: stateObj(true), // not a swept device
      // A bulk-enabled history binding does NOT save a never-filled state — there is
      // nothing recorded to lose, junk with a checkbox is still junk (2.0.3).
      [`${ns}.living.multiroom.zone2.sound.ypaoVolume`]: {
        type: "state",
        common: { read: true, custom: { "influxdb.0": { enabled: true } } },
      },
    };
    const states = {
      [`${ns}.living.multiroom.zone2.soundProgram`]: { val: null },
      [`${ns}.living.sound.direct`]: null,
      [`${ns}.living.player.play`]: { val: null },
      [`${ns}.living.volume`]: { val: -40, lc: 123 },
      [`${ns}.living.tuner.rdsText`]: { val: "", lc: 456 },
    };
    expect(neverWrittenStateIds(objects, states, new Set(["living"]), ns).sort()).toEqual([
      `${ns}.living.multiroom.zone2.sound.ypaoVolume`,
      `${ns}.living.multiroom.zone2.soundProgram`,
      `${ns}.living.sound.direct`,
    ]);
  });

  test("edge shapes: missing common counts as readable; lc of 0 counts as never written", () => {
    const objects = {
      [`${ns}.living.hdmi.out2`]: { type: "state" }, // no common at all — still purgeable
      [`${ns}.living.tuner.dab.totalStations`]: stateObj(true),
    };
    const states = {
      [`${ns}.living.hdmi.out2`]: {}, // no val, no lc
      [`${ns}.living.tuner.dab.totalStations`]: { val: null, lc: 0 }, // lc 0 = never
    };
    expect(neverWrittenStateIds(objects, states, new Set(["living"]), ns).sort()).toEqual([
      `${ns}.living.hdmi.out2`,
      `${ns}.living.tuner.dab.totalStations`,
    ]);
    // A value of 0 with a real last-change is a WRITTEN state — never purged.
    expect(
      neverWrittenStateIds(
        objects,
        { [`${ns}.living.tuner.dab.totalStations`]: { val: 0, lc: 5 } },
        new Set(["living"]),
        ns,
      ),
    ).toEqual([`${ns}.living.hdmi.out2`]);
  });
});

describe("the migration tables never touch a datapoint that is still alive", () => {
  /**
   * Every state and channel id the three catalogs can build today. YXC is device-specific,
   * so its side is the union over all bundled capability captures.
   *
   * @returns every id today's object tree can contain
   */
  function liveIds(): Set<string> {
    const ids = new Set<string>();
    for (const object of catalogToObjects(YNCA_CATALOG.map(entry => entry))) {
      ids.add(object.id);
    }
    for (const entry of XML_AMP_CATALOG) {
      ids.add(entry.state);
    }
    const fixtures = join(__dirname, "yxc", "__fixtures__");
    for (const file of readdirSync(fixtures).filter(name => name.endsWith(".json"))) {
      let capabilities;
      try {
        capabilities = parseYxcFeatures(JSON.parse(readFileSync(join(fixtures, file), "utf8")));
      } catch {
        continue; // not a getFeatures capture
      }
      for (const object of mapYxcToObjects(capabilities)) {
        ids.add(object.id);
      }
    }
    // `renamedObjectIds` matches a zone-stripped form too, so both shapes have to be clean.
    for (const id of [...ids]) {
      const stripped = /^multiroom\.zone[234]\.(.*)$/.exec(id);
      if (stripped) {
        ids.add(stripped[1]);
      }
    }
    return ids;
  }

  it("no renamed state id and no renamed channel shadows a live one", () => {
    // These tables delete on EVERY start. An entry that matches an id the adapter still
    // builds would wipe that datapoint (or a whole folder) at every single start, recreate
    // it on connect, and say so in nothing louder than a debug line — the user would just
    // see datapoints and their history disappearing. The tables grow with every tree rework,
    // which is exactly when the mistake gets made.
    const live = liveIds();
    expect(RENAMED_STATE_IDS.filter(id => live.has(id))).toEqual([]);
    const shadowed = RENAMED_CHANNELS.filter(channel =>
      [...live].some(id => id === channel || id.startsWith(`${channel}.`)),
    );
    expect(shadowed).toEqual([]);
  });
});

import { mapYxcToObjects } from "./object-mapper";
import { parseYxcFeatures } from "./capability";
import rxA2070 from "./__fixtures__/RX_A2070_v1.json";
import wx10 from "./__fixtures__/WX10_216_208.json";
import isx18d from "./__fixtures__/ISX_18D_216_208.json";

function ids(fixture: unknown): string[] {
  return mapYxcToObjects(parseYxcFeatures(fixture)).map(o => o.id);
}

describe("mapYxcToObjects", () => {
  test("creates the ONE flat player block when the device offers netusb (v2.0.0)", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("player");
    expect(ids).toContain("player.netPlayer");
    expect(ids).toEqual(expect.arrayContaining(["player.playback", "player.artist", "player.track", "player.source"]));
    // The per-source copies of the block are gone.
    expect(ids).not.toContain("player.netPlayer.playback");
    expect(ids).not.toContain("player.netPlayer.source");
  });

  test("each non-main zone gets its own player block — zones can play different sources", () => {
    const ids = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power"], inputs: [] },
        { id: "zone2", funcs: ["power"], inputs: [] },
      ],
      media: ["netusb"],
    }).map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining(["multiroom.zone2.player", "multiroom.zone2.player.playback", "multiroom.zone2.player.source"]),
    );
    expect(ids).not.toContain("multiroom.zone3.player");
  });

  test("control datapoints are writable: toggles, tray, tuner band/frequency, preset", () => {
    const withPlayers = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: [] }],
      media: ["netusb", "cd", "tuner"],
    });
    const w = (id: string): boolean | undefined => withPlayers.find(o => o.id === id)?.common.write;
    expect(w("player.repeatToggle")).toBe(true);
    expect(w("player.shuffleToggle")).toBe(true);
    expect(w("player.netPlayer.preset")).toBe(true);
    expect(w("player.cd.tray")).toBe(true);
    expect(w("tuner.band")).toBe(true);
    expect(w("tuner.frequency")).toBe(true);
  });

  test("equalizer bands are writable when the device reports an equalizer", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power", "equalizer"], inputs: [] }], media: [] });
    const low = objs.find(o => o.id === "sound.equalizer.low");
    expect(low?.common.write).toBe(true);
    // A writable number is `level`, not the read-only `value`.
    expect(low?.common.role).toBe("level");
    expect(objs.find(o => o.id === "sound.equalizer.mid")?.common.write).toBe(true);
    expect(objs.find(o => o.id === "sound.equalizer.high")?.common.write).toBe(true);
  });

  test("a device reporting a distribution block gets the MusicCast group folder under multiroom", () => {
    const objs = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: [] }],
      media: [],
      hasDistribution: true,
    });
    const ids = objs.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "multiroom",
        "multiroom.group",
        "multiroom.group.role",
        "multiroom.group.id",
        "multiroom.group.name",
        "multiroom.group.serverZone",
        "multiroom.group.linkedDevices",
      ]),
    );
    // The folder itself tells the scope: a group of linked devices, not zones.
    const group = objs.find(o => o.id === "multiroom.group");
    expect(group?.type).toBe("channel");
    expect(group?.common.name).toBe("MusicCast group (linked devices)");
    // Group name is read-only (the library's setGroupName payload is unverified).
    expect(objs.find(o => o.id === "multiroom.group.name")?.common.write).toBe(false);
  });

  test("a distribution device exposes the leave button and the link-device input", () => {
    const objs = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: [] }],
      media: [],
      hasDistribution: true,
    });
    const leave = objs.find(o => o.id === "multiroom.group.leave");
    expect(leave?.common.role).toBe("button");
    expect(leave?.common.write).toBe(true);
    const link = objs.find(o => o.id === "multiroom.group.linkDevice");
    expect(link?.common.write).toBe(true);
    expect(link?.common.read).toBe(false);
  });

  test("a main-only device still gets the multiroom channel from the always-present dist/party states", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: [] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("multiroom");
    expect(ids).toContain("multiroom.group.streamingEnabled");
    expect(ids).toContain("multiroom.partyEnable");
  });

  test("a zoned device never gets zone-prefixed copies of the device-global multiroom states", () => {
    const objs = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power"], inputs: [] },
        { id: "zone2", funcs: ["power"], inputs: [] },
      ],
      media: [],
      hasDistribution: true,
    });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("multiroom.zone2.power");
    expect(ids.filter(id => /^multiroom\.zone\d\.multiroom/.test(id))).toEqual([]);
  });

  test("the player block exposes repeat, shuffle, elapsed/total time and album art (F2 parity)", () => {
    const ids = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] }).map(
      o => o.id,
    );
    expect(ids).toEqual(
      expect.arrayContaining(["player.repeat", "player.shuffle", "player.elapsedTime", "player.totalTime", "player.albumArt"]),
    );
  });

  test("creates the tuner channel with band, frequency and RDS when the device offers a tuner", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["tuner"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("tuner");
    expect(ids).toEqual(expect.arrayContaining(["tuner.band", "tuner.frequency", "tuner.rdsText"]));
  });

  test("a cd device gets the flat player block plus a slim drive-own cd folder (v2.0.0)", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("player.cd");
    expect(ids).toEqual(
      expect.arrayContaining(["player.playback", "player.artist", "player.album", "player.track", "player.play", "player.stop"]),
    );
    // What the disc PLAYS lives in the flat block — no per-source copy remains.
    expect(ids).not.toContain("player.cd.playback");
    expect(ids).not.toContain("player.cd.play");
  });

  test("a transport button is a write-only boolean button", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const play = objs.find(o => o.id === "player.play");
    expect(play?.common.type).toBe("boolean");
    expect(play?.common.role).toBe("button.play");
    expect(play?.common.write).toBe(true);
    expect(play?.common.read).toBe(false);
  });

  test("maps main-zone functions to top-level states", () => {
    expect(ids(rxA2070)).toEqual(expect.arrayContaining(["power", "volume", "mute", "soundProgram", "input"]));
  });

  test("always-present amp fields (max volume, input text) are created for an active zone", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: [] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("advanced.maxVolume");
    expect(ids).toContain("inputText");
    expect(ids).toContain("multiroom.group.streamingEnabled");
  });

  test("creates intermediate channel objects for dotted amp catalog state IDs", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: [] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("advanced");
    expect(objs.find(o => o.id === "advanced")?.type).toBe("channel");
    expect(objs.find(o => o.id === "advanced")?.common.name).toBe("Advanced");
    expect(ids.indexOf("advanced")).toBeLessThan(ids.indexOf("advanced.maxVolume"));
  });

  test("creates the sound channel when sound.* states exist", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power", "equalizer"], inputs: [] }], media: [] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("sound");
    expect(objs.find(o => o.id === "sound")?.type).toBe("channel");
    expect(objs.find(o => o.id === "sound")?.common.name).toBe("Sound");
    expect(ids.indexOf("sound")).toBeLessThan(ids.indexOf("sound.equalizer.low"));
  });

  test("creates zone-prefixed intermediate channels for additional zones", () => {
    const objs = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power"], inputs: [] },
        { id: "zone2", funcs: ["power", "equalizer"], inputs: [] },
      ],
      media: [],
    });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("multiroom.zone2.sound");
    expect(objs.find(o => o.id === "multiroom.zone2.sound")?.common.name).toBe("Sound");
    expect(ids).toContain("multiroom.zone2.advanced");
  });

  test("maps an additional zone as a channel with its own states", () => {
    const list = ids(rxA2070);
    expect(list).toContain("multiroom.zone2");
    expect(list).toContain("multiroom.zone2.power");
  });

  test("a MusicCast speaker has main states but no second zone", () => {
    const list = ids(wx10);
    expect(list).toContain("power");
    expect(list).not.toContain("multiroom.zone2");
  });

  test("adds an input state only when the zone actually has inputs", () => {
    const caps = { zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: [] };
    expect(mapYxcToObjects(caps).map(o => o.id)).not.toContain("input");
  });

  test("power is a writable boolean with a power role", () => {
    const power = mapYxcToObjects(parseYxcFeatures(rxA2070)).find(o => o.id === "power");
    expect(power?.common.type).toBe("boolean");
    expect(power?.common.role).toBe("switch.power");
    expect(power?.common.write).toBe(true);
  });

  test("the volume state carries min/max/step from the device range", () => {
    const vol = mapYxcToObjects(parseYxcFeatures(rxA2070)).find(o => o.id === "volume");
    expect(vol?.common.min).toBe(0);
    expect(vol?.common.max).toBe(161);
    expect(vol?.common.step).toBe(1);
  });
});

describe("mapYxcToObjects tree hygiene", () => {
  test("a zone that advertises no function and no input gets no tree at all", () => {
    // Every entry set contains the "always" status fields, so without this check a
    // zone the device merely lists (a disabled Zone 4) would get a full datapoint
    // tree that never carries a value.
    const objs = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power"], inputs: [] },
        { id: "zone4", funcs: [], inputs: [] },
      ],
      media: [],
    });
    const idList = objs.map(o => o.id);
    expect(idList.some(id => id.startsWith("multiroom.zone4"))).toBe(false);
    expect(idList).toContain("power");
  });

  test("a zone that offers only inputs still gets its tree", () => {
    const objs = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power"], inputs: [] },
        { id: "zone2", funcs: [], inputs: ["hdmi1"] },
      ],
      media: [],
    });
    expect(objs.map(o => o.id)).toContain("multiroom.zone2.input");
  });

  test("creates every channel exactly once, however many zones or blocks need it", () => {
    const objs = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power", "equalizer"], inputs: [] },
        { id: "zone2", funcs: ["power", "equalizer"], inputs: [] },
        { id: "zone3", funcs: ["power", "equalizer"], inputs: [] },
      ],
      media: [],
      hasDistribution: true,
    });
    const channels = objs.filter(o => o.type === "channel").map(o => o.id);
    // A duplicate channel definition is a second write of the same object on every
    // start — and the later one wins, so a name can silently change.
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels).toContain("multiroom");
    // The MusicCast-Link states live in their own folder so the tree itself says
    // what the scope is: directly under multiroom = whole device, group = the link.
    expect(channels).toContain("multiroom.group");
    expect(objs.some(o => o.id === "multiroom.group.role")).toBe(true);
  });

  test("device-reported value lists become dropdowns on their states", () => {
    const objs = mapYxcToObjects(parseYxcFeatures(rxA2070));
    const common = (id: string): Record<string, unknown> | undefined =>
      objs.find(o => o.id === id)?.common as Record<string, unknown> | undefined;
    expect(common("input")?.states).toMatchObject({ av1: "av1", airplay: "airplay" });
    expect(common("soundProgram")?.states).toMatchObject({ munich: "munich" });
    expect(common("sound.toneMode")?.states).toEqual({ manual: "manual" });
  });

  test("netusb gets the favourites/recently-played lists and the recall-by-number states", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] });
    const byId = new Map(objs.map(o => [o.id, o]));
    expect(byId.get("player.netPlayer.presets")?.common.write).toBe(false);
    expect(byId.get("player.netPlayer.recent")?.common.write).toBe(false);
    expect(byId.get("player.netPlayer.recallRecent")?.common.write).toBe(true);
    // The playing source is shown on the flat block (read-only); netPlayer.source is gone.
    expect(byId.get("player.source")?.common.write).toBe(false);
    expect(byId.has("player.netPlayer.source")).toBe(false);
  });

  test("the cd player carries track number, totals, disc time and drive status", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const ids = objs.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "player.cd.trackNumber",
        "player.cd.totalTracks",
        "player.cd.discTime",
        "player.cd.deviceStatus",
      ]),
    );
  });

  test("the tuner gets the preset surface: recall, up/down, stored lists, tuned/audio mode", () => {
    const objs = mapYxcToObjects(parseYxcFeatures(isx18d));
    const byId = new Map(objs.map(o => [o.id, o]));
    expect(byId.get("tuner.preset")?.common.write).toBe(true);
    expect(byId.get("tuner.preset")?.common.max).toBe(30); // the ISX-18D's slot count
    expect(byId.get("tuner.presetUp")?.common.role).toBe("button");
    expect(byId.get("tuner.presetDown")?.common.role).toBe("button");
    expect(byId.get("tuner.presets")?.common.role).toBe("json");
    expect(byId.get("tuner.tuned")?.common.write).toBe(false);
    expect(byId.get("tuner.band")?.common.states).toEqual({ fm: "fm", dab: "dab" });
  });

  test("a DAB tuner gets the tuner.dab detail channel on the YNCA-shared ids", () => {
    const ids = mapYxcToObjects(parseYxcFeatures(isx18d)).map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining(["tuner.dab", "tuner.dab.serviceLabel", "tuner.dab.ensembleLabel", "tuner.dab.dls"]),
    );
  });

  test("a clock device gets the read-only clock/alarm block; others get none", () => {
    const withClock = mapYxcToObjects(parseYxcFeatures(isx18d));
    const ids = withClock.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining(["clock", "clock.autoSync", "clock.alarm.on", "clock.alarm.oneday.time"]),
    );
    // Every clock state is display-only — the predecessor's clock writes were dead too.
    for (const obj of withClock.filter(o => o.id.startsWith("clock") && o.type === "state")) {
      expect(obj.common.write).toBe(false);
    }
    // The one-day-only ISX gets no weekly day channels.
    expect(ids).not.toContain("clock.alarm.monday");
    expect(mapYxcToObjects(parseYxcFeatures(rxA2070)).map(o => o.id)).not.toContain("clock");
  });

  test("the alarm volume carries the device's reported range", () => {
    const objs = mapYxcToObjects(parseYxcFeatures(isx18d));
    const volume = objs.find(o => o.id === "clock.alarm.volume");
    expect(volume?.common.min).toBe(5);
    expect(volume?.common.max).toBe(60);
  });
});

describe("scene / remote / signal / netusb-list objects (RX-V6A getFeatures shape)", () => {
  const caps = {
    zones: [
      {
        id: "main",
        funcs: ["power", "scene", "cursor", "menu", "signal_info"],
        inputs: ["hdmi1"],
        sceneNum: 8,
      },
      { id: "zone2", funcs: ["power", "scene"], inputs: ["hdmi1"], sceneNum: 8 },
    ],
    media: ["netusb"],
    netusbFuncs: ["mc_playlist", "play_queue", "recent_info"],
  };

  test("scene.recall exists per declaring zone with the device's scene count as max", () => {
    const objs = mapYxcToObjects(caps);
    const main = objs.find(o => o.id === "scene.recall");
    expect(main?.common.write).toBe(true);
    expect(main?.common.max).toBe(8);
    expect(objs.map(o => o.id)).toContain("multiroom.zone2.scene.recall");
  });

  test("the on-screen remote carries the device-verified vocabularies as dropdowns", () => {
    const objs = mapYxcToObjects(caps);
    const cursor = objs.find(o => o.id === "remote.cursor");
    expect(Object.keys(cursor?.common.states ?? {})).toEqual(["up", "down", "left", "right", "select", "return"]);
    const menu = objs.find(o => o.id === "remote.menu");
    expect(Object.keys(menu?.common.states ?? {})).toEqual([
      "on_screen",
      "top_menu",
      "menu",
      "option",
      "display",
      "home",
    ]);
    // Zone 2 declared neither — no remote states there.
    expect(objs.map(o => o.id)).not.toContain("multiroom.zone2.remote.cursor");
  });

  test("signal-info states exist only for declaring zones; playlists/queue only when declared", () => {
    const objs = mapYxcToObjects(caps).map(o => o.id);
    expect(objs).toContain("sound.signal.format");
    expect(objs).not.toContain("multiroom.zone2.sound.signal.format");
    expect(objs).toContain("player.netPlayer.playlists");
    expect(objs).toContain("player.netPlayer.queue");
    const bare = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: ["hdmi1"] }],
      media: ["netusb"],
    }).map(o => o.id);
    expect(bare).not.toContain("scene.recall");
    expect(bare).not.toContain("remote.cursor");
    expect(bare).not.toContain("player.netPlayer.playlists");
    expect(bare).not.toContain("player.netPlayer.queue");
  });
});

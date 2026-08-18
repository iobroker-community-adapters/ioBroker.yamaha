import { mapYxcToObjects } from "./object-mapper";
import { parseYxcFeatures } from "./capability";
import rxA2070 from "./__fixtures__/RX_A2070_v1.json";
import wx10 from "./__fixtures__/WX10_216_208.json";

function ids(fixture: unknown): string[] {
  return mapYxcToObjects(parseYxcFeatures(fixture)).map(o => o.id);
}

describe("mapYxcToObjects", () => {
  test("creates the network player channel and states when the device offers netusb", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("player.netPlayer");
    expect(ids).toEqual(
      expect.arrayContaining(["player.netPlayer.playback", "player.netPlayer.artist", "player.netPlayer.track"]),
    );
  });

  test("control datapoints are writable: toggles, tray, tuner band/frequency, preset", () => {
    const withPlayers = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: [] }],
      media: ["netusb", "cd", "tuner"],
    });
    const w = (id: string): boolean | undefined => withPlayers.find(o => o.id === id)?.common.write;
    expect(w("player.netPlayer.repeatToggle")).toBe(true);
    expect(w("player.netPlayer.shuffleToggle")).toBe(true);
    expect(w("player.netPlayer.preset")).toBe(true);
    expect(w("player.cd.tray")).toBe(true);
    expect(w("tuner.band")).toBe(true);
    expect(w("tuner.frequency")).toBe(true);
  });

  test("equalizer bands are writable when the device reports an equalizer", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power", "equalizer"], inputs: [] }], media: [] });
    const low = objs.find(o => o.id === "sound.equalizerLow");
    expect(low?.common.write).toBe(true);
    // A writable number is `level`, not the read-only `value`.
    expect(low?.common.role).toBe("level");
    expect(objs.find(o => o.id === "sound.equalizerMid")?.common.write).toBe(true);
    expect(objs.find(o => o.id === "sound.equalizerHigh")?.common.write).toBe(true);
  });

  test("a device reporting a distribution block gets the read-only multiroom channel", () => {
    const objs = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: [] }],
      media: [],
      hasDistribution: true,
    });
    const ids = objs.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "multiroom",
        "multiroom.role",
        "multiroom.groupId",
        "multiroom.groupName",
        "multiroom.serverZone",
        "multiroom.clientList",
      ]),
    );
    // Group name is read-only (the library's setGroupName payload is unverified).
    expect(objs.find(o => o.id === "multiroom.groupName")?.common.write).toBe(false);
  });

  test("a distribution device exposes the leave-group button and the link-client input", () => {
    const objs = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: [] }],
      media: [],
      hasDistribution: true,
    });
    const leave = objs.find(o => o.id === "multiroom.leaveGroup");
    expect(leave?.common.role).toBe("button");
    expect(leave?.common.write).toBe(true);
    const link = objs.find(o => o.id === "multiroom.linkClient");
    expect(link?.common.write).toBe(true);
    expect(link?.common.read).toBe(false);
  });

  test("a main-only device still gets the multiroom channel from the always-present dist/party states", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: [] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("multiroom");
    expect(ids).toContain("multiroom.distributionEnable");
    expect(ids).toContain("multiroom.partyEnable");
  });

  test("the network player exposes repeat, shuffle, elapsed/total time and album art (F2 parity)", () => {
    const ids = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] }).map(
      o => o.id,
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        "player.netPlayer.repeat",
        "player.netPlayer.shuffle",
        "player.netPlayer.elapsedTime",
        "player.netPlayer.totalTime",
        "player.netPlayer.albumArt",
      ]),
    );
  });

  test("creates the tuner channel with band, frequency and RDS when the device offers a tuner", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["tuner"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("tuner");
    expect(ids).toEqual(expect.arrayContaining(["tuner.band", "tuner.frequency", "tuner.rdsText"]));
  });

  test("creates the cd channel with read states and transport buttons when the device offers a cd", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("player.cd");
    expect(ids).toEqual(
      expect.arrayContaining([
        "player.cd.playback",
        "player.cd.artist",
        "player.cd.album",
        "player.cd.track",
        "player.cd.play",
        "player.cd.pause",
        "player.cd.stop",
        "player.cd.next",
        "player.cd.prev",
      ]),
    );
  });

  test("a cd transport button is a write-only boolean button", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const play = objs.find(o => o.id === "player.cd.play");
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
    expect(ids).toContain("multiroom.distributionEnable");
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
    expect(ids.indexOf("sound")).toBeLessThan(ids.indexOf("sound.equalizerLow"));
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

import {
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  stateToYxc,
} from "./command-mapper";
import type { YxcClientLike } from "./client-contract";
import ysp from "./__fixtures__/status/YSP1600_main.json";
import rx from "./__fixtures__/status/RX_A2070_main.json";

/** A recording client: every method call is captured as [name, args] and resolves {}. */
function recordingClient(): { client: YxcClientLike; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const client = new Proxy({} as YxcClientLike, {
    get:
      (_target, prop: string) =>
      (...args: unknown[]) => {
        calls.push([prop, args]);
        return Promise.resolve({});
      },
  });
  return { client, calls };
}

/**
 * Map a write and run its client call, returning the recorded [method, args] — the
 * behavioural check replacing the former method-name-string comparison.
 */
async function ranCall(stateId: string, value: unknown): Promise<[string, unknown[]] | undefined> {
  const command = stateToYxc(stateId, value);
  if (!command || command.kind !== "run") {
    return undefined;
  }
  const { client, calls } = recordingClient();
  await command.run(client);
  return calls[0];
}

describe("parseYxcStatus", () => {
  test("maps a main getStatus to unified amp states", () => {
    // YSP-1600: power=standby, volume=30, mute=false, input=hdmi, sound_program=stereo
    expect(parseYxcStatus(ysp, "main")).toEqual(
      expect.arrayContaining([
        { id: "power", value: false },
        { id: "volume", value: 30 },
        { id: "mute", value: false },
        { id: "input", value: "hdmi" },
        { id: "soundProgram", value: "stereo" },
      ]),
    );
  });

  test("maps power=on to true and reads the raw volume", () => {
    // RX-A2070: power=on, volume=66, input=server
    const updates = parseYxcStatus(rx, "main");
    expect(updates).toContainEqual({ id: "power", value: true });
    expect(updates).toContainEqual({ id: "volume", value: 66 });
    expect(updates).toContainEqual({ id: "input", value: "server" });
  });

  test("prefixes the state id for non-main zones", () => {
    expect(parseYxcStatus(ysp, "zone2")).toContainEqual({ id: "multiroom.zone2.power", value: false });
  });

  test("returns no updates for malformed input or a status without amp fields", () => {
    expect(parseYxcStatus(null, "main")).toEqual([]);
    expect(parseYxcStatus({ response_code: 0 }, "main")).toEqual([]);
  });

  test("reads nested tone control and flat sleep/dialogue/actual-volume", () => {
    const status = {
      tone_control: { mode: "manual", bass: 3, treble: -2 },
      sleep: 60,
      dialogue_level: 2,
      max_volume: 161,
      actual_volume: { mode: "db", value: -47.5, unit: "dB" },
      contents_display: true,
    };
    const u = parseYxcStatus(status, "main");
    expect(u).toContainEqual({ id: "sound.bass", value: 3 });
    expect(u).toContainEqual({ id: "sound.treble", value: -2 });
    expect(u).toContainEqual({ id: "sleep", value: 60 });
    expect(u).toContainEqual({ id: "sound.dialogueLevel", value: 2 });
    expect(u).toContainEqual({ id: "actualVolume", value: -47.5 });
    expect(u).toContainEqual({ id: "sound.contentsDisplay", value: true });
  });

  test("reads the always-present getStatus fields (max volume, input text, distribution, party)", () => {
    const status = { max_volume: 161, input_text: "HDMI-Laptop", distribution_enable: true, party_enable: false };
    const u = parseYxcStatus(status, "main");
    expect(u).toContainEqual({ id: "advanced.maxVolume", value: 161 });
    expect(u).toContainEqual({ id: "inputText", value: "HDMI-Laptop" });
    expect(u).toContainEqual({ id: "multiroom.group.streamingEnabled", value: true });
    expect(u).toContainEqual({ id: "multiroom.partyEnable", value: false });
  });

  test("a zone status never yields zone-prefixed copies of the device-global multiroom states", () => {
    const status = { volume: 80, distribution_enable: true, party_enable: false };
    const ids = parseYxcStatus(status, "zone2").map(u => u.id);
    expect(ids).toContain("multiroom.zone2.volume");
    expect(ids.filter(id => id.includes(".multiroom."))).toEqual([]);
  });

  test("reads the remaining amp fields including the nested equalizer", () => {
    const status = {
      direct: false,
      clear_voice: true,
      bass_extension: true,
      balance: 3,
      adaptive_drc: false,
      extra_bass: true,
      mono: false,
      surround_3d: true,
      dialogue_lift: 2,
      dts_dialogue_control: 1,
      equalizer: { mode: "manual", low: 10, mid: 7, high: 8 },
    };
    const u = parseYxcStatus(status, "main");
    expect(u).toContainEqual({ id: "sound.direct", value: false });
    expect(u).toContainEqual({ id: "sound.clearVoice", value: true });
    expect(u).toContainEqual({ id: "sound.bassExtension", value: true });
    expect(u).toContainEqual({ id: "sound.balance", value: 3 });
    expect(u).toContainEqual({ id: "sound.extraBass", value: true });
    expect(u).toContainEqual({ id: "sound.surround3d", value: true });
    expect(u).toContainEqual({ id: "sound.equalizerLow", value: 10 });
    expect(u).toContainEqual({ id: "sound.equalizerMid", value: 7 });
    expect(u).toContainEqual({ id: "sound.equalizerHigh", value: 8 });
  });
});

describe("stateToYxc control methods (repeat/shuffle/tray, tuner, party, preset)", () => {
  test("toggle buttons run their toggle method", async () => {
    expect(await ranCall("player.netPlayer.repeatToggle", true)).toEqual(["toggleNetRepeat", []]);
    expect(await ranCall("player.netPlayer.shuffleToggle", true)).toEqual(["toggleNetShuffle", []]);
    expect(await ranCall("player.cd.repeatToggle", true)).toEqual(["toggleCDRepeat", []]);
    expect(await ranCall("player.cd.tray", true)).toEqual(["toggleTray", []]);
  });

  test("tuner band/frequency, preset and party become their control commands", async () => {
    expect(await ranCall("tuner.band", "fm")).toEqual(["setBand", ["fm"]]);
    // Frequency needs the controller-cached band, so it stays declarative.
    expect(stateToYxc("tuner.frequency", 100900)).toEqual({ kind: "tunerFreq", value: 100900 });
    expect(await ranCall("player.netPlayer.preset", 3)).toEqual(["recallPreset", [3, "main"]]);
    expect(await ranCall("multiroom.partyEnable", true)).toEqual(["setPartyMode", [true]]);
  });

  test("equalizer bands stay declarative (main and zoned) — the controller supplies the other two", () => {
    // setEqualizer sets low/mid/high together; the controller supplies the other two from
    // the last status, so each state carries only its own band value.
    expect(stateToYxc("sound.equalizerLow", 3)).toEqual({ kind: "equalizer", zone: "main", band: "low", value: 3 });
    expect(stateToYxc("sound.equalizerMid", -2)).toEqual({ kind: "equalizer", zone: "main", band: "mid", value: -2 });
    expect(stateToYxc("sound.equalizerHigh", 5)).toEqual({ kind: "equalizer", zone: "main", band: "high", value: 5 });
    expect(stateToYxc("multiroom.zone2.sound.equalizerLow", 1)).toEqual({
      kind: "equalizer",
      zone: "zone2",
      band: "low",
      value: 1,
    });
  });
});

describe("parseYxcDistribution", () => {
  test("maps getDistributionInfo to the read-only multiroom states", () => {
    expect(
      parseYxcDistribution({
        group_id: "abc",
        group_name: "Kitchen",
        role: "server",
        server_zone: "main",
        client_list: ["1.2.3.5"],
      }),
    ).toEqual([
      { id: "multiroom.group.role", value: "server" },
      { id: "multiroom.group.id", value: "abc" },
      { id: "multiroom.group.name", value: "Kitchen" },
      { id: "multiroom.group.serverZone", value: "main" },
      { id: "multiroom.group.linkedDevices", value: '["1.2.3.5"]' },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcDistribution(null)).toEqual([]);
  });
});

describe("parseYxcPlayInfo", () => {
  test("maps play-info fields to read-only network player states", () => {
    expect(parseYxcPlayInfo({ playback: "play", artist: "A", album: "B", track: "T", extra: 1 })).toEqual([
      { id: "player.netPlayer.artist", value: "A" },
      { id: "player.netPlayer.album", value: "B" },
      { id: "player.netPlayer.track", value: "T" },
      { id: "player.netPlayer.playback", value: 0 },
    ]);
  });

  test("maps play-info fields to a cd source when given the cd prefix", () => {
    expect(parseYxcPlayInfo({ playback: "play", artist: "A", album: "B", track: "T" }, "player.cd")).toEqual([
      { id: "player.cd.artist", value: "A" },
      { id: "player.cd.album", value: "B" },
      { id: "player.cd.track", value: "T" },
      { id: "player.cd.playback", value: 0 },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcPlayInfo(null)).toEqual([]);
  });

  test("reads repeat, shuffle, elapsed/total time and album art (verified against captures)", () => {
    expect(
      parseYxcPlayInfo({
        playback: "play",
        repeat: "one",
        shuffle: "off",
        play_time: 42,
        total_time: 215,
        albumart_url: "/cover.jpg",
      }),
    ).toEqual([
      // Typed like the YNCA sources: repeat as the media.mode.repeat code, shuffle boolean.
      { id: "player.netPlayer.repeat", value: 1 },
      { id: "player.netPlayer.shuffle", value: false },
      { id: "player.netPlayer.playback", value: 0 },
      { id: "player.netPlayer.albumArt", value: "/cover.jpg" },
      { id: "player.netPlayer.elapsedTime", value: 42 },
      { id: "player.netPlayer.totalTime", value: 215 },
    ]);
  });
});

describe("parseYxcTunerInfo", () => {
  test("maps band, the active band's frequency (kHz) and RDS radio text", () => {
    // Real RX-V685 tuner getPlayInfo shape: band + nested per-band freq + rds.
    expect(
      parseYxcTunerInfo({
        band: "fm",
        fm: { preset: 0, freq: 100900, tuned: false },
        am: { preset: 0, freq: 1080 },
        rds: { radio_text_a: "Hit", radio_text_b: "" },
      }),
    ).toEqual([
      { id: "tuner.band", value: "fm" },
      { id: "tuner.frequency", value: 100900 },
      { id: "tuner.rdsText", value: "Hit" },
    ]);
  });

  test("reads the DAB frequency when the active band is dab", () => {
    // RX-A2070 reports band "dab" with the frequency nested under dab.
    expect(parseYxcTunerInfo({ band: "dab", dab: { freq: 180064, service_label: "ENERGY" } })).toEqual([
      { id: "tuner.band", value: "dab" },
      { id: "tuner.frequency", value: 180064 },
    ]);
  });

  test("reads the AM frequency when the active band is am, and tolerates a missing rds block", () => {
    expect(parseYxcTunerInfo({ band: "am", am: { freq: 1440 }, fm: { freq: 0 } })).toEqual([
      { id: "tuner.band", value: "am" },
      { id: "tuner.frequency", value: 1440 },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcTunerInfo(null)).toEqual([]);
  });
});

describe("stateToYxc", () => {
  test("runs network-player transport buttons through their YXC method", async () => {
    expect(await ranCall("player.netPlayer.play", true)).toEqual(["playNet", []]);
    expect(await ranCall("player.netPlayer.next", true)).toEqual(["nextNet", []]);
  });

  test("runs cd transport buttons through setCDPlayback with the YXC action word", async () => {
    expect(await ranCall("player.cd.play", true)).toEqual(["setCDPlayback", ["play"]]);
    expect(await ranCall("player.cd.prev", true)).toEqual(["setCDPlayback", ["previous"]]);
    expect(await ranCall("player.cd.next", true)).toEqual(["setCDPlayback", ["next"]]);
  });

  test("runs subwoofer trim through setSubwooferVolumeTo", async () => {
    expect(await ranCall("subwooferVolume", -3)).toEqual(["setSubwooferVolumeTo", [-3, "main"]]);
  });

  test("runs tone bass/treble and sleep through their setters; read-only fields yield no command", async () => {
    expect(await ranCall("sound.bass", 4)).toEqual(["setBassTo", [4, "main"]]);
    expect(await ranCall("sound.treble", -1)).toEqual(["setTrebleTo", [-1, "main"]]);
    expect(await ranCall("sleep", 60)).toEqual(["sleep", [60, "main"]]);
    expect(stateToYxc("sound.dialogueLevel", 2)).toBeUndefined();
    expect(stateToYxc("actualVolume", -40)).toBeUndefined();
  });

  test("runs the writable amp fields through their YXC setter; read-only ones yield no command", async () => {
    expect(await ranCall("sound.direct", true)).toEqual(["setDirect", [true, "main"]]);
    expect(await ranCall("sound.balance", 3)).toEqual(["setBalance", [3, "main"]]);
    expect(await ranCall("sound.bassExtension", true)).toEqual(["setBassExtension", [true, "main"]]);
    expect(await ranCall("sound.clearVoice", true)).toEqual(["setClearVoice", [true, "main"]]);
    expect(stateToYxc("sound.extraBass", true)).toBeUndefined();
    expect(stateToYxc("sound.surround3d", true)).toBeUndefined();
  });

  test("runs a power write through the power method on main", async () => {
    expect(await ranCall("power", true)).toEqual(["power", [true, "main"]]);
  });

  test("runs a zoned volume write through setVolumeTo with the zone", async () => {
    expect(await ranCall("multiroom.zone2.volume", 40)).toEqual(["setVolumeTo", [40, "zone2"]]);
  });

  test("runs soundProgram through setSound (not setSoundProgram)", async () => {
    expect(await ranCall("soundProgram", "stereo")).toEqual(["setSound", ["stereo", "main"]]);
  });

  test("returns undefined for an unmapped state or unknown zone", () => {
    expect(stateToYxc("nonsense", 1)).toBeUndefined();
    expect(stateToYxc("zone9.power", true)).toBeUndefined();
  });
});

import {
  parseYxcClock,
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcPlaylistNames,
  parseYxcPlayQueue,
  parseYxcPresetList,
  parseYxcRecentList,
  parseYxcSignalInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  parseYxcTunerPresetLists,
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
    // The band is declarative too: the controller must record it right away, because a
    // frequency written straight afterwards is sent against the remembered band.
    expect(stateToYxc("tuner.band", "fm")).toEqual({ kind: "tunerBand", band: "fm" });
    // Frequency needs the controller-cached band, so it stays declarative.
    expect(stateToYxc("tuner.frequency", 100900)).toEqual({ kind: "tunerFreq", value: 100900 });
    // Declarative: a recall also switches its target zone to the source, so the controller
    // picks the zone that is actually listening — the mapper cannot know it.
    expect(stateToYxc("player.netPlayer.preset", 3)).toEqual({ kind: "netusbPreset", value: 3 });
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
  test("maps band, the active band's frequency (kHz), preset/tuned and RDS", () => {
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
      { id: "tuner.preset", value: 0 },
      { id: "tuner.tuned", value: false },
      { id: "tuner.rdsText", value: "Hit" },
      { id: "tuner.rdsTextB", value: "" },
    ]);
  });

  test("reads the DAB frequency and DAB detail states when the active band is dab", () => {
    // RX-A2070 reports band "dab" with the frequency nested under dab; the dab block's
    // detail fields land on the tuner.dab.* ids shared with the YNCA DAB subunit.
    expect(parseYxcTunerInfo({ band: "dab", dab: { freq: 180064, service_label: "ENERGY" } })).toEqual([
      { id: "tuner.band", value: "dab" },
      { id: "tuner.frequency", value: 180064 },
      { id: "tuner.dab.serviceLabel", value: "ENERGY" },
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

describe("stateToYxc button actions", () => {
  /** A client that records the method it was asked for instead of talking HTTP. */
  function recorder(): { calls: string[]; client: never } {
    const calls: string[] = [];
    const client = new Proxy(
      {},
      {
        get: (_t, method: string) =>
          method === "then"
            ? undefined
            : (...args: unknown[]) => {
                calls.push(args.length ? `${method}(${args.join(",")})` : method);
                return Promise.resolve({});
              },
      },
    );
    return { calls, client: client as never };
  }

  const BUTTONS: Array<[string, string]> = [
    ["player.netPlayer.play", "playNet"],
    ["player.netPlayer.pause", "pauseNet"],
    ["player.netPlayer.stop", "stopNet"],
    ["player.netPlayer.next", "nextNet"],
    ["player.netPlayer.prev", "prevNet"],
    ["player.netPlayer.repeatToggle", "toggleNetRepeat"],
    ["player.netPlayer.shuffleToggle", "toggleNetShuffle"],
    ["player.cd.play", "setCDPlayback(play)"],
    ["player.cd.pause", "setCDPlayback(pause)"],
    ["player.cd.stop", "setCDPlayback(stop)"],
    ["player.cd.next", "setCDPlayback(next)"],
    ["player.cd.prev", "setCDPlayback(previous)"],
    ["player.cd.repeatToggle", "toggleCDRepeat"],
    ["player.cd.shuffleToggle", "toggleCDShuffle"],
    ["player.cd.tray", "toggleTray"],
  ];

  test.each(BUTTONS)("%s presses %s on the device", async (stateId, expected) => {
    const command = stateToYxc(stateId, true);
    expect(command, stateId).toBeDefined();
    const { calls, client } = recorder();
    await (command as { kind: "run"; run: (c: never) => Promise<unknown> }).run(client);
    // Every one of these is a media button in the tree. A wrong or missing mapping
    // is a button that does nothing — and "next" firing "previous" is worse.
    expect(calls).toEqual([expected]);
  });

  test("a button fires on any UNACKED write — the ack filter upstream is the guard", () => {
    // Documented as-is: the mapper does not look at the value. What keeps the
    // momentary reset from re-firing the action is the controller's ack filter
    // (device-controller.handleStateChange returns early for ack:true), because
    // the reset is written with ack:true. Should that filter ever move, this
    // test says where the second guard would have to go.
    expect(stateToYxc("player.cd.play", false)).toMatchObject({ kind: "run" });
    expect(stateToYxc("player.netPlayer.next", 0)).toMatchObject({ kind: "run" });
  });
});

describe("preset/recent selection (musiccast-adapter parity)", () => {
  test("parseYxcPresetList keeps stored slots with their number, skips empty ones", () => {
    // Real ISX-18D getPresetInfo shape: empty slots report input "unknown" and no text.
    const update = parseYxcPresetList({
      response_code: 0,
      preset_info: [
        { input: "net_radio", text: "hr3 (Frankfurt am Main/German)", attribute: 0 },
        { input: "server", text: "hr3 Stream", attribute: 30 },
        { input: "unknown", text: "" },
        { input: "net_radio", text: "80s80s DAB+ (Berlin/German)", attribute: 0 },
      ],
    });
    expect(update?.id).toBe("player.netPlayer.presets");
    expect(JSON.parse(String(update?.value))).toEqual([
      { num: 1, input: "net_radio", name: "hr3 (Frankfurt am Main/German)" },
      { num: 2, input: "server", name: "hr3 Stream" },
      { num: 4, input: "net_radio", name: "80s80s DAB+ (Berlin/German)" },
    ]);
    expect(parseYxcPresetList({ response_code: 2 })).toBeUndefined();
  });

  test("parseYxcRecentList maps the recently-played items", () => {
    const update = parseYxcRecentList({
      response_code: 0,
      recent_info: [
        { input: "net_radio", text: "80s80s Deutsch", albumart_url: "http://a/b.png", play_count: 3, attribute: 0 },
        { input: "spotify", text: "Playlist X" },
      ],
    });
    expect(update?.id).toBe("player.netPlayer.recent");
    expect(JSON.parse(String(update?.value))).toEqual([
      { num: 1, input: "net_radio", name: "80s80s Deutsch", albumArt: "http://a/b.png", playCount: 3 },
      { num: 2, input: "spotify", name: "Playlist X" },
    ]);
  });

  test("parseYxcTunerPresetLists keys the slots by band, raw fields kept", () => {
    const update = parseYxcTunerPresetLists({
      fm: { response_code: 0, preset_info: [{ band: "fm", number: 100900 }] },
      dab: { response_code: 4 },
    });
    expect(update?.id).toBe("tuner.presets");
    expect(JSON.parse(String(update?.value))).toEqual({ fm: [{ num: 1, band: "fm", number: 100900 }] });
    expect(parseYxcTunerPresetLists({ fm: { response_code: 4 } })).toBeUndefined();
  });

  test("recall/step writes map to their client calls; the tuner preset stays declarative", async () => {
    expect(stateToYxc("player.netPlayer.recallRecent", 2)).toEqual({ kind: "netusbRecent", value: 2 });
    expect(await ranCall("tuner.presetUp", true)).toEqual(["switchTunerPreset", ["next"]]);
    expect(await ranCall("tuner.presetDown", true)).toEqual(["switchTunerPreset", ["previous"]]);
    // The band comes from controller state, so the command is declarative like tunerFreq.
    expect(stateToYxc("tuner.preset", 5)).toEqual({ kind: "tunerPreset", value: 5 });
    expect(stateToYxc("tuner.preset", null)).toBeUndefined();
  });
});

describe("netusb source and CD detail parsing", () => {
  test("the active network source lands on player.netPlayer.source", () => {
    const updates = parseYxcPlayInfo({ input: "spotify", playback: "play" });
    expect(updates).toContainEqual({ id: "player.netPlayer.source", value: "spotify" });
  });

  test("cd extras: track number, totals, disc time and drive status", () => {
    const updates = parseYxcPlayInfo(
      { track_number: 3, total_tracks: 12, disc_time: 3400, device_status: "ready" },
      "player.cd",
    );
    expect(updates).toEqual(
      expect.arrayContaining([
        { id: "player.cd.trackNumber", value: 3 },
        { id: "player.cd.totalTracks", value: 12 },
        { id: "player.cd.discTime", value: 3400 },
        { id: "player.cd.deviceStatus", value: "ready" },
      ]),
    );
  });
});

describe("parseYxcClock", () => {
  test("maps the capture-verified getSettings shape onto the clock states", () => {
    // Real ISX-18D response.
    const updates = parseYxcClock({
      response_code: 0,
      auto_sync: true,
      format: "24h",
      alarm: {
        alarm_on: false,
        volume: 25,
        fade_interval: 180,
        fade_type: 1,
        mode: "oneday",
        repeat: false,
        oneday: { enable: false, time: "0800", beep: true, playback_type: "resume", resume: { input: "tuner" } },
      },
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        { id: "clock.autoSync", value: true },
        { id: "clock.format", value: "24h" },
        { id: "clock.alarm.on", value: false },
        { id: "clock.alarm.volume", value: 25 },
        { id: "clock.alarm.mode", value: "oneday" },
        { id: "clock.alarm.oneday.enable", value: false },
        { id: "clock.alarm.oneday.time", value: "08:00" },
        { id: "clock.alarm.oneday.beep", value: true },
        { id: "clock.alarm.oneday.playbackType", value: "resume" },
        { id: "clock.alarm.oneday.resumeInput", value: "tuner" },
      ]),
    );
  });

  test("maps a weekly day block and a preset-type alarm", () => {
    const updates = parseYxcClock({
      alarm: {
        monday: { enable: true, time: "0630", playback_type: "preset", preset: { type: "netusb", num: 2 } },
      },
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        { id: "clock.alarm.monday.enable", value: true },
        { id: "clock.alarm.monday.time", value: "06:30" },
        { id: "clock.alarm.monday.playbackType", value: "preset" },
        { id: "clock.alarm.monday.presetType", value: "netusb" },
        { id: "clock.alarm.monday.presetNumber", value: 2 },
      ]),
    );
    expect(parseYxcClock(null)).toEqual([]);
  });
});

describe("scene recall and the on-screen remote (#615, device-verified endpoints)", () => {
  test("scene.recall runs recallScene on the written zone", async () => {
    const { client, calls } = recordingClient();
    const main = stateToYxc("scene.recall", 4);
    expect(main).toMatchObject({ kind: "run" });
    await (main as { kind: "run"; run: (c: YxcClientLike) => Promise<unknown> }).run(client);
    expect(calls).toEqual([["recallScene", [4, "main"]]]);

    calls.length = 0;
    const zone2 = stateToYxc("multiroom.zone2.scene.recall", 2);
    await (zone2 as { kind: "run"; run: (c: YxcClientLike) => Promise<unknown> }).run(client);
    expect(calls).toEqual([["recallScene", [2, "zone2"]]]);
  });

  test("remote.cursor and remote.menu run the verified control endpoints", async () => {
    const { client, calls } = recordingClient();
    const cursor = stateToYxc("remote.cursor", "return");
    await (cursor as { kind: "run"; run: (c: YxcClientLike) => Promise<unknown> }).run(client);
    const menu = stateToYxc("remote.menu", "top_menu");
    await (menu as { kind: "run"; run: (c: YxcClientLike) => Promise<unknown> }).run(client);
    expect(calls).toEqual([
      ["controlCursor", ["return", "main"]],
      ["controlMenu", ["top_menu", "main"]],
    ]);
  });

  test("invalid values map to no command at all", () => {
    expect(stateToYxc("scene.recall", null)).toBeUndefined();
    expect(stateToYxc("scene.recall", "abc")).toBeUndefined();
    expect(stateToYxc("remote.cursor", null)).toBeUndefined();
  });
});

describe("signal info / playlists / play queue parsers (capture-verified shapes)", () => {
  test("parseYxcSignalInfo maps the audio block onto the zone's sound states", () => {
    // The captured RX-V6A getSignalInfo shape.
    const updates = parseYxcSignalInfo(
      { response_code: 0, audio: { error: 0, format: "PCM", fs: "48 kHz", bit: "24", bitrate: 0 } },
      "main",
    );
    expect(updates).toEqual([
      { id: "sound.signalFormat", value: "PCM" },
      { id: "sound.signalSampling", value: "48 kHz" },
      { id: "sound.signalBits", value: "24" },
      { id: "sound.signalBitrate", value: 0 },
    ]);
    expect(parseYxcSignalInfo({ response_code: 0 }, "main")).toEqual([]);
    // A zone-2 response lands under the zone prefix.
    expect(parseYxcSignalInfo({ audio: { format: "---" } }, "zone2")).toEqual([
      { id: "multiroom.zone2.sound.signalFormat", value: "---" },
    ]);
  });

  test("parseYxcPlaylistNames turns the name list into the numbered JSON state", () => {
    const update = parseYxcPlaylistNames({ response_code: 0, name_list: ["Playlist 1", "Playlist 2"] });
    expect(update?.id).toBe("player.netPlayer.playlists");
    expect(JSON.parse(String(update?.value))).toEqual([
      { num: 1, name: "Playlist 1" },
      { num: 2, name: "Playlist 2" },
    ]);
    expect(parseYxcPlaylistNames({ response_code: 0 })).toBeUndefined();
  });

  test("parseYxcPlayQueue keeps the playing index and the tracks", () => {
    const update = parseYxcPlayQueue({
      response_code: 0,
      type: "system",
      max_line: 2,
      playing_index: 1,
      index: 0,
      track_info: [{ text: "A" }, { text: "B" }],
    });
    expect(update?.id).toBe("player.netPlayer.queue");
    expect(JSON.parse(String(update?.value))).toEqual({
      playingIndex: 1,
      totalTracks: 2,
      tracks: [{ text: "A" }, { text: "B" }],
    });
    expect(parseYxcPlayQueue({ response_code: 0 })).toBeUndefined();
  });
});

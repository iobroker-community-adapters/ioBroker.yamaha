import { parseYxcPlayInfo, parseYxcStatus, parseYxcTunerInfo, stateToYxc } from "./command-mapper";
import ysp from "./__fixtures__/status/YSP1600_main.json";
import rx from "./__fixtures__/status/RX_A2070_main.json";

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
    expect(parseYxcStatus(ysp, "zone2")).toContainEqual({ id: "zone2.power", value: false });
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
    expect(u).toContainEqual({ id: "bass", value: 3 });
    expect(u).toContainEqual({ id: "treble", value: -2 });
    expect(u).toContainEqual({ id: "sleep", value: 60 });
    expect(u).toContainEqual({ id: "dialogueLevel", value: 2 });
    expect(u).toContainEqual({ id: "actualVolume", value: -47.5 });
    expect(u).toContainEqual({ id: "contentsDisplay", value: true });
  });

  test("reads the always-present getStatus fields (max volume, input text, distribution, party)", () => {
    const status = { max_volume: 161, input_text: "HDMI-Laptop", distribution_enable: true, party_enable: false };
    const u = parseYxcStatus(status, "main");
    expect(u).toContainEqual({ id: "maxVolume", value: 161 });
    expect(u).toContainEqual({ id: "inputText", value: "HDMI-Laptop" });
    expect(u).toContainEqual({ id: "distributionEnable", value: true });
    expect(u).toContainEqual({ id: "partyEnable", value: false });
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
    expect(u).toContainEqual({ id: "direct", value: false });
    expect(u).toContainEqual({ id: "clearVoice", value: true });
    expect(u).toContainEqual({ id: "bassExtension", value: true });
    expect(u).toContainEqual({ id: "balance", value: 3 });
    expect(u).toContainEqual({ id: "extraBass", value: true });
    expect(u).toContainEqual({ id: "surround3d", value: true });
    expect(u).toContainEqual({ id: "equalizerLow", value: 10 });
    expect(u).toContainEqual({ id: "equalizerMid", value: 7 });
    expect(u).toContainEqual({ id: "equalizerHigh", value: 8 });
  });
});

describe("parseYxcPlayInfo", () => {
  test("maps play-info fields to read-only network player states", () => {
    expect(parseYxcPlayInfo({ playback: "play", artist: "A", album: "B", track: "T", extra: 1 })).toEqual([
      { id: "netPlayer.playback", value: "play" },
      { id: "netPlayer.artist", value: "A" },
      { id: "netPlayer.album", value: "B" },
      { id: "netPlayer.track", value: "T" },
    ]);
  });

  test("maps play-info fields to a cd source when given the cd prefix", () => {
    expect(parseYxcPlayInfo({ playback: "play", artist: "A", album: "B", track: "T" }, "cd")).toEqual([
      { id: "cd.playback", value: "play" },
      { id: "cd.artist", value: "A" },
      { id: "cd.album", value: "B" },
      { id: "cd.track", value: "T" },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcPlayInfo(null)).toEqual([]);
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
  test("maps network-player transport buttons to their YXC method", () => {
    expect(stateToYxc("netPlayer.play", true)).toEqual({ method: "playNet", zone: "netusb", value: true });
    expect(stateToYxc("netPlayer.next", true)).toEqual({ method: "nextNet", zone: "netusb", value: true });
  });

  test("maps cd transport buttons to setCDPlayback with the YXC action word", () => {
    expect(stateToYxc("cd.play", true)).toEqual({ method: "setCDPlayback", zone: "cd", value: "play" });
    expect(stateToYxc("cd.prev", true)).toEqual({ method: "setCDPlayback", zone: "cd", value: "previous" });
    expect(stateToYxc("cd.next", true)).toEqual({ method: "setCDPlayback", zone: "cd", value: "next" });
  });

  test("maps subwoofer trim to setSubwooferVolumeTo", () => {
    expect(stateToYxc("subwooferVolume", -3)).toEqual({ method: "setSubwooferVolumeTo", zone: "main", value: -3 });
  });

  test("maps tone bass/treble and sleep to their setters; read-only fields yield no command", () => {
    expect(stateToYxc("bass", 4)).toEqual({ method: "setBassTo", zone: "main", value: 4 });
    expect(stateToYxc("treble", -1)).toEqual({ method: "setTrebleTo", zone: "main", value: -1 });
    expect(stateToYxc("sleep", 60)).toEqual({ method: "sleep", zone: "main", value: 60 });
    expect(stateToYxc("dialogueLevel", 2)).toBeUndefined();
    expect(stateToYxc("actualVolume", -40)).toBeUndefined();
  });

  test("maps the writable amp fields to their YXC setter; read-only ones yield no command", () => {
    expect(stateToYxc("direct", true)).toEqual({ method: "setDirect", zone: "main", value: true });
    expect(stateToYxc("balance", 3)).toEqual({ method: "setBalance", zone: "main", value: 3 });
    expect(stateToYxc("bassExtension", true)).toEqual({ method: "setBassExtension", zone: "main", value: true });
    expect(stateToYxc("clearVoice", true)).toEqual({ method: "setClearVoice", zone: "main", value: true });
    expect(stateToYxc("extraBass", true)).toBeUndefined();
    expect(stateToYxc("equalizerLow", 5)).toBeUndefined();
    expect(stateToYxc("surround3d", true)).toBeUndefined();
  });

  test("maps a power write to the power method on main", () => {
    expect(stateToYxc("power", true)).toEqual({ method: "power", zone: "main", value: true });
  });

  test("maps a zoned volume write to setVolumeTo", () => {
    expect(stateToYxc("zone2.volume", 40)).toEqual({ method: "setVolumeTo", zone: "zone2", value: 40 });
  });

  test("maps soundProgram to setSound (not setSoundProgram)", () => {
    expect(stateToYxc("soundProgram", "stereo")).toEqual({ method: "setSound", zone: "main", value: "stereo" });
  });

  test("returns undefined for an unmapped state or unknown zone", () => {
    expect(stateToYxc("nonsense", 1)).toBeUndefined();
    expect(stateToYxc("zone9.power", true)).toBeUndefined();
  });
});

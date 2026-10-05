import { stateToYxc } from "./command-mapper";
import type { YxcClientLike } from "./client-contract";

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
 *
 * @param stateId Datapoint id being written
 * @param value Value written to it
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
describe("stateToYxc control methods (repeat/shuffle/tray, tuner, party, preset)", () => {
  test("toggle buttons: the tray stays a direct run; repeat/shuffle toggles are zone-routed transports", async () => {
    expect(await ranCall("player.cd.tray", true)).toEqual(["toggleTray", []]);
    expect(stateToYxc("player.repeatToggle", true)).toEqual({
      kind: "playerTransport",
      zone: "main",
      action: "repeatToggle",
    });
    expect(stateToYxc("player.shuffleToggle", true)).toEqual({
      kind: "playerTransport",
      zone: "main",
      action: "shuffleToggle",
    });
  });

  test("tuner band/frequency and preset become their control commands", () => {
    // The band is declarative too: the controller must record it right away, because a
    // frequency written straight afterwards is sent against the remembered band.
    expect(stateToYxc("tuner.band", "fm")).toEqual({ kind: "tunerBand", band: "fm" });
    // Frequency needs the controller-cached band, so it stays declarative.
    expect(stateToYxc("tuner.frequency", 100900)).toEqual({ kind: "tunerFreq", value: 100900 });
    // Declarative: a recall also switches its target zone to the source, so the controller
    // picks the zone that is actually listening — the mapper cannot know it.
    expect(stateToYxc("player.netPlayer.preset", 3)).toEqual({ kind: "netusbPreset", value: 3 });
  });

  test("equalizer bands stay declarative (main and zoned) — the controller supplies the other two", () => {
    // setEqualizer sets low/mid/high together; the controller supplies the other two from
    // the last status, so each state carries only its own band value.
    expect(stateToYxc("sound.equalizer.low", 3)).toEqual({ kind: "equalizer", zone: "main", band: "low", value: 3 });
    expect(stateToYxc("sound.equalizer.mid", -2)).toEqual({ kind: "equalizer", zone: "main", band: "mid", value: -2 });
    expect(stateToYxc("sound.equalizer.high", 5)).toEqual({ kind: "equalizer", zone: "main", band: "high", value: 5 });
    expect(stateToYxc("multiroom.zone2.sound.equalizer.low", 1)).toEqual({
      kind: "equalizer",
      zone: "zone2",
      band: "low",
      value: 1,
    });
  });
});
describe("stateToYxc", () => {
  test("the unified transport buttons are declarative — the controller routes them to the zone's source", () => {
    expect(stateToYxc("player.play", true)).toEqual({ kind: "playerTransport", zone: "main", action: "play" });
    expect(stateToYxc("multiroom.zone2.player.next", true)).toEqual({
      kind: "playerTransport",
      zone: "zone2",
      action: "next",
    });
  });

  test("runs subwoofer trim through setSubwooferVolumeTo", async () => {
    expect(await ranCall("subwooferVolume", -3)).toEqual(["setSubwooferVolumeTo", [-3, "main"]]);
  });

  test("runs tone bass/treble and sleep through their setters; read-only fields yield no command", async () => {
    expect(await ranCall("sound.bass", 4)).toEqual(["setBassTo", [4, "main"]]);
    expect(await ranCall("sound.treble", -1)).toEqual(["setTrebleTo", [-1, "main"]]);
    expect(await ranCall("sleep", 60)).toEqual(["sleep", [60, "main"]]);
    expect(stateToYxc("actualVolume", -40)).toBeUndefined();
    expect(stateToYxc("sound.audioSelect", "auto")).toBeUndefined();
    expect(stateToYxc("sound.contentsDisplay", true)).toBeUndefined();
  });

  test("runs the writable amp fields through their YXC setter", async () => {
    expect(await ranCall("sound.direct", true)).toEqual(["setDirect", [true, "main"]]);
    expect(await ranCall("sound.balance", 3)).toEqual(["setBalance", [3, "main"]]);
    expect(await ranCall("sound.bassExtension", true)).toEqual(["setBassExtension", [true, "main"]]);
    expect(await ranCall("sound.clearVoice", true)).toEqual(["setClearVoice", [true, "main"]]);
  });

  // Specification setters that stood read-only (YXC Basic §5.9/§5.13/§5.14/§5.16/§5.17, Advanced
  // §4.1–4.3), and the four Home Assistant runs through aiomusiccast (audit 2026-09-24, C8).
  test.each([
    ["sound.dialogueLevel", 2, "setDialogueLevel", [2, "zone2"]],
    ["sound.dialogueLift", 3, "setDialogueLift", [3, "zone2"]],
    ["sound.surround3d", true, "set3dSurround", [true, "zone2"]],
    ["sound.toneMode", "manual", "setToneMode", ["manual", "zone2"]],
    ["sound.equalizer.mode", "auto", "setEqualizerMode", ["auto", "zone2"]],
    ["sound.linkControl", "stability", "setLinkControl", ["stability", "zone2"]],
    ["sound.linkAudioDelay", "lip_sync", "setLinkAudioDelay", ["lip_sync", "zone2"]],
    ["sound.linkAudioQuality", "compressed", "setLinkAudioQuality", ["compressed", "zone2"]],
    ["sound.dtsDialogueControl", 4, "setDtsDialogueControl", [4, "zone2"]],
    ["sound.extraBass", true, "setExtraBass", [true, "zone2"]],
    ["sound.adaptiveDrc", false, "setAdaptiveDrc", [false, "zone2"]],
    ["sound.surroundDecoder", "dolby_pl2x_movie", "setSurroundDecoderType", ["dolby_pl2x_movie", "zone2"]],
  ])("%s is written through %s", async (state, value, method, args) => {
    expect(await ranCall(`multiroom.zone2.${state}`, value)).toEqual([method, args]);
  });

  test("runs a power write through the power method on main", async () => {
    expect(await ranCall("power", true)).toEqual(["power", [true, "main"]]);
  });

  test("a switch reads the words and numbers a script writes — 'false' switches OFF, junk sends nothing", async () => {
    expect(await ranCall("power", "false")).toEqual(["power", [false, "main"]]);
    expect(await ranCall("power", "off")).toEqual(["power", [false, "main"]]);
    expect(await ranCall("power", "0")).toEqual(["power", [false, "main"]]);
    expect(await ranCall("power", 0)).toEqual(["power", [false, "main"]]);
    expect(await ranCall("power", "on")).toEqual(["power", [true, "main"]]);
    expect(await ranCall("mute", "FALSE")).toEqual(["mute", [false, "main"]]);
    expect(stateToYxc("power", "maybe")).toBeUndefined();
  });

  // Volume is declarative: the datapoint holds the DISPLAYED value while setVolume takes the raw
  // step count, so only the controller — which measured the ratio from the device's own status —
  // can complete the call. The mapper just names the zone and the value.
  test("maps a zoned volume write to the declarative volume command", () => {
    expect(stateToYxc("multiroom.zone2.volume", 40)).toEqual({ kind: "volume", zone: "zone2", value: 40 });
    expect(stateToYxc("volume", -30)).toEqual({ kind: "volume", zone: "main", value: -30 });
  });

  test("a volume write takes only a number (audit 2026-09-24, D2)", () => {
    expect(stateToYxc("volume", false)).toBeUndefined();
    expect(stateToYxc("volume", "0x10")).toBeUndefined();
    expect(stateToYxc("volume", "-30.5")).toEqual({ kind: "volume", zone: "main", value: -30.5 });
  });

  // Basic §6.2: a reported 0 means "no preset" — it is not a slot to recall (audit 2026-09-24, C16).
  test("a tuner preset 0 is not sent", () => {
    expect(stateToYxc("tuner.preset", 0)).toBeUndefined();
    expect(stateToYxc("tuner.preset", 3)).toEqual({ kind: "tunerPreset", value: 3 });
  });

  test("runs soundProgram through setSound (not setSoundProgram)", async () => {
    expect(await ranCall("soundProgram", "stereo")).toEqual(["setSound", ["stereo", "main"]]);
  });

  // The one gate (review 2026-10-05, KISS): a word datapoint takes text — trimmed — and a number's text; a switch
  // value or an empty text names no word and went out as "true" or "".
  test("a word datapoint takes trimmed text; a switch value or an empty text sends nothing", async () => {
    expect(await ranCall("soundProgram", " stereo ")).toEqual(["setSound", ["stereo", "main"]]);
    expect(await ranCall("input", 5)).toEqual(["setInput", ["5", "main"]]);
    expect(stateToYxc("soundProgram", true)).toBeUndefined();
    expect(stateToYxc("input", "")).toBeUndefined();
    expect(stateToYxc("input", "   ")).toBeUndefined();
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

  const BUTTONS: Array<[string, string]> = [["player.cd.tray", "toggleTray"]];

  test.each(BUTTONS)("%s presses %s on the device", async (stateId, expected) => {
    const command = stateToYxc(stateId, true);
    expect(command, stateId).toBeDefined();
    const { calls, client } = recorder();
    await (command as { kind: "run"; run: (c: never) => Promise<unknown> }).run(client);
    expect(calls).toEqual([expected]);
  });

  const TRANSPORTS = ["play", "pause", "stop", "next", "prev", "repeatToggle", "shuffleToggle"] as const;

  test.each(TRANSPORTS)("player.%s maps to its zone-routed transport (v2.0.0)", action => {
    // The controller runs the action on whatever source the zone is playing —
    // a wrong or missing mapping is a button that does nothing.
    expect(stateToYxc(`player.${action}`, true)).toEqual({ kind: "playerTransport", zone: "main", action });
    expect(stateToYxc(`multiroom.zone3.player.${action}`, true)).toEqual({
      kind: "playerTransport",
      zone: "zone3",
      action,
    });
  });

  test("a button fires on any UNACKED write — the ack filter upstream is the guard", () => {
    // Documented as-is: the mapper does not look at the value. What keeps the
    // momentary reset from re-firing the action is the controller's ack filter
    // (multi-transport-handle.handleStateChange returns early for ack:true), because
    // the reset is written with ack:true. Should that filter ever move, this
    // test says where the second guard would have to go.
    expect(stateToYxc("player.cd.tray", false)).toMatchObject({ kind: "run" });
    expect(stateToYxc("player.next", 0)).toMatchObject({ kind: "playerTransport" });
  });
});
describe("recall and step writes (musiccast-adapter parity)", () => {
  test("recall/step writes map to their client calls; the tuner preset stays declarative", async () => {
    expect(stateToYxc("player.netPlayer.recallRecent", 2)).toEqual({ kind: "netusbRecent", value: 2 });
    expect(await ranCall("tuner.presetUp", true)).toEqual(["switchTunerPreset", ["next"]]);
    expect(await ranCall("tuner.presetDown", true)).toEqual(["switchTunerPreset", ["previous"]]);
    expect(await ranCall("tuner.dab.serviceUp", true)).toEqual(["setDabService", ["next"]]);
    expect(await ranCall("tuner.dab.serviceDown", true)).toEqual(["setDabService", ["previous"]]);
    // The band comes from controller state, so the command is declarative like tunerFreq.
    expect(stateToYxc("tuner.preset", 5)).toEqual({ kind: "tunerPreset", value: 5 });
    expect(stateToYxc("tuner.preset", null)).toBeUndefined();
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
// Spec-covered writes that had no way in (YXC Basic Rev 1.10 §6.4/§6.7/§6.8/§7.4/§7.11/§7.12/§8.2/
// §9.2/§9.4/§9.5; audit 2026-09-29, C38).
describe("stateToYxc — store, clear, search, select, jump, clock", () => {
  test("presets are stored and cleared by slot; slot 0 is none", async () => {
    expect(await ranCall("tuner.presetSave", 5)).toEqual(["storeTunerPreset", [5]]);
    expect(await ranCall("player.netPlayer.presetSave", "3")).toEqual(["storeNetPreset", [3]]);
    expect(await ranCall("player.netPlayer.presetClear", 2)).toEqual(["clearNetPreset", [2]]);
    expect(stateToYxc("tuner.presetSave", 0)).toBeUndefined();
    expect(stateToYxc("tuner.presetClear", 4)).toEqual({ kind: "tunerClear", value: 4 });
    expect(stateToYxc("tuner.searchUp", true)).toEqual({ kind: "tunerSearch", direction: "up" });
  });

  test("a CD track is played by number, a position jumped to by seconds", async () => {
    expect(await ranCall("player.cd.trackSelect", 7)).toEqual(["selectCdTrack", [7]]);
    expect(stateToYxc("player.cd.trackSelect", 513)).toBeUndefined();
    expect(await ranCall("player.netPlayer.playPosition", 123)).toEqual(["setPlayPosition", [123]]);
  });

  test("clock and alarm settings go out through their setters, a time as hhmm", async () => {
    expect(await ranCall("clock.autoSync", true)).toEqual(["setClockAutoSync", [true]]);
    expect(await ranCall("clock.format", "24h")).toEqual(["setClockFormat", ["24h"]]);
    expect(stateToYxc("clock.format", "25h")).toBeUndefined();
    expect(await ranCall("clock.alarm.on", "false")).toEqual(["setAlarmSettings", [{ alarm_on: false }]]);
    expect(await ranCall("clock.alarm.volume", 30)).toEqual(["setAlarmSettings", [{ volume: 30 }]]);
    expect(await ranCall("clock.alarm.oneday.time", "7:30")).toEqual([
      "setAlarmSettings",
      [{ detail: { day: "oneday", time: "0730" } }],
    ]);
    expect(await ranCall("clock.alarm.monday.enable", true)).toEqual([
      "setAlarmSettings",
      [{ detail: { day: "monday", enable: true } }],
    ]);
    expect(stateToYxc("clock.alarm.oneday.time", "25:00")).toBeUndefined();
    expect(stateToYxc("clock.alarm.oneday.presetName", "x")).toBeUndefined();
  });
});

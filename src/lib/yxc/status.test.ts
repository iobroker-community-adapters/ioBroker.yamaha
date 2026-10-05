import { parseYxcSignalInfo, parseYxcStatus } from "./status";
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

  // `volume` carries what the receiver DISPLAYS, so the RX-A2070 (raw 66, actual_volume -47.5 dB)
  // reports the decibel value. The raw step count is the wire form and stays out of the tree.
  test("maps power=on to true and reads the displayed volume", () => {
    // RX-A2070: power=on, volume=66 raw / -47.5 dB displayed, input=server
    const updates = parseYxcStatus(rx, "main");
    expect(updates).toContainEqual({ id: "power", value: true });
    expect(updates).toContainEqual({ id: "volume", value: -47.5 });
    expect(updates).toContainEqual({ id: "input", value: "server" });
  });

  // A device without `actual_volume` has no display scale to report — its raw step count is all
  // there is, and it must still reach the datapoint (speakers, soundbars, CD receivers).
  test("falls back to the raw step count where the device reports no display scale", () => {
    const updates = parseYxcStatus({ power: "on", volume: 30 }, "main");
    expect(updates).toContainEqual({ id: "volume", value: 30 });
  });

  test("prefixes the state id for non-main zones", () => {
    expect(parseYxcStatus(ysp, "zone2")).toContainEqual({ id: "multiroom.zone2.power", value: false });
  });

  test("returns no updates for malformed input or a status without amp fields", () => {
    expect(parseYxcStatus(null, "main")).toEqual([]);
    expect(parseYxcStatus({ response_code: 0 }, "main")).toEqual([]);
  });

  test("reads nested tone control and flat sleep/dialogue/volume", () => {
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
    expect(u).toContainEqual({ id: "volume", value: -47.5 });
    expect(u).toContainEqual({ id: "sound.contentsDisplay", value: true });
  });

  test("reads the always-present getStatus fields (max volume, distribution) — party comes from getFuncStatus", () => {
    const status = { max_volume: 161, distribution_enable: true, party_enable: false };
    const u = parseYxcStatus(status, "main");
    expect(u).toContainEqual({ id: "advanced.maxVolume", value: 161 });
    expect(u).toContainEqual({ id: "multiroom.group.streamingEnabled", value: true });
    // One party source (audit 2026-09-29, C46).
    expect(u.map(update => update.id)).not.toContain("multiroom.partyEnable");
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
    expect(u).toContainEqual({ id: "sound.equalizer.low", value: 10 });
    expect(u).toContainEqual({ id: "sound.equalizer.mid", value: 7 });
    expect(u).toContainEqual({ id: "sound.equalizer.high", value: 8 });
  });
});

describe("parseYxcSignalInfo (capture-verified shape)", () => {
  test("parseYxcSignalInfo maps the audio block onto the zone's sound states", () => {
    // The captured RX-V6A getSignalInfo shape.
    const updates = parseYxcSignalInfo(
      { response_code: 0, audio: { error: 0, format: "PCM", fs: "48 kHz", bit: "24", bitrate: 0 } },
      "main",
    );
    expect(updates).toEqual([
      { id: "sound.signal.format", value: "PCM" },
      { id: "sound.signal.sampling", value: "48 kHz" },
      { id: "sound.signal.bits", value: "24" },
      { id: "sound.signal.bitrate", value: 0 },
    ]);
    expect(parseYxcSignalInfo({ response_code: 0 }, "main")).toEqual([]);
    // A zone-2 response lands under the zone prefix — and the device's "no signal" dash
    // placeholder becomes an empty value instead of reading like content.
    expect(parseYxcSignalInfo({ audio: { format: "---" } }, "zone2")).toEqual([
      { id: "multiroom.zone2.sound.signal.format", value: "" },
    ]);
    expect(parseYxcSignalInfo({ audio: { format: "PCM", fs: "---", bit: "  " } }, "main")).toEqual([
      { id: "sound.signal.format", value: "PCM" },
      { id: "sound.signal.sampling", value: "" },
      { id: "sound.signal.bits", value: "" },
    ]);
  });
});

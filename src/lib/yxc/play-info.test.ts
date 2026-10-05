import { parseYxcPlayInfo, parseYxcTunerInfo } from "./play-info";
import { parseYxcRecentList } from "./lists";
import { absoluteDeviceUrl } from "../catalog/device-url";

describe("parseYxcPlayInfo", () => {
  test("maps play-info fields to the unified flat player block (v2.0.0)", () => {
    expect(parseYxcPlayInfo({ playback: "play", artist: "A", album: "B", track: "T", extra: 1 })).toEqual([
      { id: "player.artist", value: "A" },
      { id: "player.album", value: "B" },
      { id: "player.track", value: "T" },
      { id: "player.playback", value: 1 },
    ]);
  });

  test("cd play info lands on the SAME flat block, with cd as the playing source", () => {
    expect(parseYxcPlayInfo({ playback: "play", artist: "A", album: "B", track: "T" }, "cd")).toEqual([
      { id: "player.artist", value: "A" },
      { id: "player.album", value: "B" },
      { id: "player.track", value: "T" },
      { id: "player.playback", value: 1 },
      { id: "player.source", value: "CD" },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcPlayInfo(null)).toEqual([]);
  });

  // A cover path is fetched from the device's own web server (YXC Basic §7.2); the relative path
  // loaded from the ioBroker web server and showed nothing (audit 2026-09-24, C6). Captures: RX-A2070
  // "/YamahaRemoteControl/AlbumART/AlbumART5419.jpg"; recently-played lists carry services' full URLs.
  test("a cover path becomes the address on the device; a full URL and an empty one stay", () => {
    const host = "10.0.0.5";
    expect(absoluteDeviceUrl("/YamahaRemoteControl/AlbumART/AlbumART5419.jpg", host)).toBe(
      "http://10.0.0.5/YamahaRemoteControl/AlbumART/AlbumART5419.jpg",
    );
    expect(absoluteDeviceUrl("xxx/yyy/zzz.jpg", "receiver.lan")).toBe("http://receiver.lan/xxx/yyy/zzz.jpg");
    expect(absoluteDeviceUrl("https://cdn.example/cover.jpg", host)).toBe("https://cdn.example/cover.jpg");
    expect(absoluteDeviceUrl("", host)).toBe("");
    expect(absoluteDeviceUrl("/cover.jpg", undefined)).toBe("/cover.jpg");
    const cover = (url: string): string => absoluteDeviceUrl(url, host);
    expect(parseYxcPlayInfo({ albumart_url: "/cover.jpg" }, "netusb", cover)).toEqual([
      { id: "player.albumArt", value: "http://10.0.0.5/cover.jpg" },
    ]);
    const recent = parseYxcRecentList(
      { recent_info: [{ input: "net_radio", text: "Radio", albumart_url: "/art/1.jpg" }] },
      cover,
    );
    expect(JSON.parse(String(recent?.value))).toEqual([
      { num: 1, input: "net_radio", name: "Radio", albumArt: "http://10.0.0.5/art/1.jpg" },
    ]);
  });

  // YXC Basic §7.2: play_time -60000 is "invalid", -59999…59999 valid; WX-010/WX-030 captures report
  // -60000 (audit 2026-09-24, C11).
  test("the invalid play time is no time; a negative valid one keeps its sign", () => {
    expect(parseYxcPlayInfo({ play_time: -60000 })).toEqual([
      { id: "player.elapsedTime", value: 0 },
      { id: "player.elapsedTimeText", value: "" },
    ]);
    expect(parseYxcPlayInfo({ play_time: -5 })).toEqual([
      { id: "player.elapsedTime", value: -5 },
      { id: "player.elapsedTimeText", value: "-0:05" },
    ]);
  });

  // The specification's words outside the old tables (YXC Basic §7.2, §8.1; audit 2026-09-24, C14).
  test("every repeat, shuffle and playback word of the specification is read", () => {
    const read = (info: Record<string, unknown>): unknown[] => parseYxcPlayInfo(info, "cd").map(u => u.value);
    expect(read({ repeat: "folder" })).toEqual([2, "CD"]);
    expect(read({ repeat: "a-b" })).toEqual([1, "CD"]);
    for (const shuffle of ["on", "songs", "albums", "folder", "program"]) {
      expect(read({ shuffle }), shuffle).toEqual([true, "CD"]);
    }
    expect(read({ shuffle: "off" })).toEqual([false, "CD"]);
    expect(read({ playback: "fast_forward" })).toEqual([1, "CD"]);
    expect(read({ playback: "fast_reverse" })).toEqual([1, "CD"]);
    expect(read({ repeat: "sometimes", shuffle: "maybe", playback: "rewinding" })).toEqual(["CD"]);
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
      { id: "player.repeat", value: 1 },
      { id: "player.shuffle", value: false },
      { id: "player.playback", value: 1 },
      { id: "player.albumArt", value: "/cover.jpg" },
      // Both forms of each time, from the one reported value — the seconds fill the
      // media-player slot, the text is what a visualisation shows.
      { id: "player.elapsedTime", value: 42 },
      { id: "player.elapsedTimeText", value: "0:42" },
      { id: "player.totalTime", value: 215 },
      { id: "player.totalTimeText", value: "3:35" },
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
      // No audio_mode in the block: not the last band's any more (audit 2026-09-29, C39).
      { id: "tuner.audioMode", value: null },
      { id: "tuner.rdsText", value: "Hit" },
      { id: "tuner.rdsTextB", value: "" },
    ]);
  });

  test("reads the DAB frequency and DAB detail states when the active band is dab", () => {
    // RX-A2070 reports band "dab" with the frequency nested under dab; the dab block's
    // detail fields land on the tuner.dab.* ids shared with the YNCA DAB subunit.
    expect(parseYxcTunerInfo({ band: "dab", dab: { freq: 180064, status: "ready", service_label: "ENERGY" } })).toEqual(
      [
        { id: "tuner.band", value: "dab" },
        { id: "tuner.frequency", value: 180064 },
        // DAB has no `tuned` — a ready station is tuned; the FM texts go (YXC Basic §6.2, C39).
        { id: "tuner.tuned", value: true },
        { id: "tuner.audioMode", value: null },
        { id: "tuner.rdsText", value: "" },
        { id: "tuner.rdsTextB", value: "" },
        { id: "tuner.rdsService", value: "" },
        { id: "tuner.rdsProgramType", value: "" },
        { id: "tuner.dab.serviceLabel", value: "ENERGY" },
        { id: "tuner.dab.status", value: "ready" },
      ],
    );
  });

  test("reads the AM frequency when the active band is am, and tolerates a missing rds block", () => {
    expect(parseYxcTunerInfo({ band: "am", am: { freq: 1440 }, fm: { freq: 0 } })).toEqual([
      { id: "tuner.band", value: "am" },
      { id: "tuner.frequency", value: 1440 },
      { id: "tuner.tuned", value: false },
      // AM has no audio mode and no RDS: the FM values do not stand on (C39).
      { id: "tuner.audioMode", value: null },
      { id: "tuner.rdsText", value: "" },
      { id: "tuner.rdsTextB", value: "" },
      { id: "tuner.rdsService", value: "" },
      { id: "tuner.rdsProgramType", value: "" },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcTunerInfo(null)).toEqual([]);
  });
});

describe("netusb source and CD detail parsing", () => {
  test("the active network source lands on player.source", () => {
    const updates = parseYxcPlayInfo({ input: "spotify", playback: "play" });
    // The name, as the YNCA and XML side of a receiver show it — never MusicCast's id (C40).
    expect(updates).toContainEqual({ id: "player.source", value: "Spotify" });
  });

  test("cd extras: track number, totals, disc time and drive status stay drive-own", () => {
    const updates = parseYxcPlayInfo(
      { track_number: 3, total_tracks: 12, disc_time: 3400, device_status: "ready" },
      "cd",
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

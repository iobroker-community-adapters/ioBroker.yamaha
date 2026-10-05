import {
  clientSlotEntries,
  parseYxcPlaylistNames,
  parseYxcPlayQueue,
  parseYxcPresetList,
  parseYxcRecentList,
  parseYxcTunerPresetLists,
  playQueueCounters,
  playlistSlotEntries,
  playQueueSlotEntries,
  netusbSlotEntries,
  stationSlotEntries,
} from "./lists";
import { distributionSummary } from "./distribution";

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

  test("parseYxcTunerPresetLists drops the device's empty slots but keeps anything with content", () => {
    // A receiver with no presets stored answers with its full slot count — 40 per band of
    // {band:"unknown", number:0, text:""}. Published raw that is a JSON datapoint of 80 blanks.
    const update = parseYxcTunerPresetLists({
      fm: {
        preset_info: [
          { band: "unknown", number: 0, hd_program: 0, text: "" },
          { band: "fm", number: 98100, hd_program: 0, text: "" },
          { band: "unknown", number: 0, text: "   " },
          // Only the text is filled — an unfamiliar firmware shape is kept, not swallowed.
          { band: "unknown", number: 0, text: "Radio Paradise" },
        ],
      },
    });
    expect(JSON.parse(String(update?.value))).toEqual({
      fm: [
        { num: 2, band: "fm", number: 98100, hd_program: 0, text: "" },
        { num: 4, band: "unknown", number: 0, text: "Radio Paradise" },
      ],
    });
  });

  test("a band whose slots are all empty stays in the JSON as an empty list", () => {
    const update = parseYxcTunerPresetLists({ dab: { preset_info: [{ band: "unknown", number: 0, text: "" }] } });
    expect(JSON.parse(String(update?.value))).toEqual({ dab: [] });
  });
});

describe("playlists and the play queue (capture-verified shapes)", () => {
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

// The lists as slot entries (audit 2026-09-29, C30).
describe("device lists as slot entries", () => {
  test("a stored station reads band, name and — AM/FM only — its frequency; an unused slot is empty", () => {
    expect(
      stationSlotEntries({
        preset_info: [
          { band: "fm", number: 98100, text: "hr3" },
          { band: "dab", number: 12345, text: "Bayern 3" },
          { band: "unknown", number: 0, text: "" },
        ],
      }),
    ).toEqual([
      { band: "fm", name: "hr3", frequency: 98100 },
      { band: "dab", name: "Bayern 3", frequency: 0 },
      undefined,
    ]);
    expect(stationSlotEntries({})).toBeUndefined();
  });

  test("a linked device reads its address (Advanced §5.1)", () => {
    expect(clientSlotEntries({ client_list: [{ ip_address: "192.168.0.5", data_type: "base" }] })).toEqual([
      { ip: "192.168.0.5" },
    ]);
    expect(clientSlotEntries({ role: "client" })).toBeUndefined();
  });

  test("the play queue's length and 1-based position are values of their own", () => {
    expect(playQueueCounters({ max_line: 200, playing_index: 4, track_info: [] })).toEqual([
      { id: "player.netPlayer.queueLength", value: 200 },
      { id: "player.netPlayer.queuePosition", value: 5 },
    ]);
    expect(playQueueCounters({ max_line: 0, playing_index: -1 })).toEqual([
      { id: "player.netPlayer.queueLength", value: 0 },
      { id: "player.netPlayer.queuePosition", value: 0 },
    ]);
  });
});

// Each list is read once; the JSON and the slots follow the same rule of an empty slot (review 2026-10-05, DRY).
describe("one read per list — the JSON and the slots agree on an empty slot", () => {
  test("a recent entry of input `unknown` is empty in both", () => {
    const info = {
      recent_info: [
        { input: "unknown", text: "x" },
        { input: "server", text: "Song" },
      ],
    };
    expect(JSON.parse(String(parseYxcRecentList(info)?.value))).toEqual([{ num: 2, input: "server", name: "Song" }]);
    expect(netusbSlotEntries(info.recent_info)).toEqual([undefined, { name: "Song", input: "SERVER" }]);
  });

  test("a playlist and a queue track without a name are empty in both", () => {
    const info = { name_list: ["a", "", "  ", "b"] };
    expect(JSON.parse(String(parseYxcPlaylistNames(info)?.value))).toEqual([
      { num: 1, name: "a" },
      { num: 4, name: "b" },
    ]);
    expect(playlistSlotEntries(info)).toEqual([{ name: "a" }, undefined, undefined, { name: "b" }]);
    expect(playQueueSlotEntries({ track_info: [{ text: "" }, { text: "T" }] })).toEqual([undefined, { name: "T" }]);
  });

  test("a linked device without an address is no roster member and an empty slot", () => {
    const info = {
      role: "server",
      group_id: "ab12",
      client_list: ["10.0.0.2", { ip_address: "" }, { data_type: "x" }],
    };
    expect(clientSlotEntries(info)).toEqual([{ ip: "10.0.0.2" }, undefined, undefined]);
    expect(distributionSummary(info).clients).toEqual(["10.0.0.2"]);
  });
});

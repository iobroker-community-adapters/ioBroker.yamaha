import { translateDeclaredStates, translateMusicCastInputs, translateMusicCastPrograms } from "./musiccast-vocabulary";
import rxV6a from "./__fixtures__/rx-v6a-input-lists.json";
import rxA2070 from "../yxc/__fixtures__/RX_A2070_v1.json";
import ysp1600 from "../yxc/__fixtures__/YSP1600_312_208.json";

/**
 * The main zone's getFeatures lists of a bundled capture.
 *
 * @param fixture the parsed getFeatures capture
 * @returns the main zone's input and sound program lists
 */
const mainZone = (fixture: unknown): { input_list: string[]; sound_program_list: string[] } =>
  (fixture as { zone: Array<{ input_list: string[]; sound_program_list: string[] }> }).zone[0];

describe("MusicCast input ids → the classic YNCA/XML spelling (#619)", () => {
  test("one device's MusicCast list translates to that device's own XML list, both zones", () => {
    // The two lists were read from the same receiver seconds apart — the dictionary must map
    // one onto the other exactly, per zone.
    for (const zone of ["main", "zone2"] as const) {
      const translated = translateMusicCastInputs(rxV6a[zone].musiccast);
      expect(Object.keys(translated ?? {}).sort()).toEqual([...rxV6a[zone].xml].sort());
    }
  });

  test("a 2017 receiver's list translates completely, JUKE and V-AUX included", () => {
    const main = mainZone(rxA2070);
    const translated = translateMusicCastInputs(main.input_list);
    expect(translated).toMatchObject({ JUKE: "JUKE", "V-AUX": "V-AUX", "NET RADIO": "NET RADIO", AV7: "AV7" });
    expect(Object.keys(translated ?? {}).length).toBe(main.input_list.length);
  });

  test("a soundbar's list is not translated at all — its ids have no classic spelling", () => {
    expect(translateMusicCastInputs(mainZone(ysp1600).input_list)).toBeUndefined();
  });

  test("one unknown id refuses the whole list — never a half-translated dropdown", () => {
    expect(translateMusicCastInputs(["hdmi1", "something_new"])).toBeUndefined();
    expect(translateMusicCastInputs([])).toBeUndefined();
  });
});

describe("MusicCast sound program ids → the YNCA program names", () => {
  test("a 2020 receiver's list translates to 19 YNCA names, Straight skipped, All-Ch Stereo hyphenated", () => {
    const ids = [
      "munich",
      "vienna",
      "chamber",
      "cellar_club",
      "roxy_theatre",
      "bottom_line",
      "sports",
      "action_game",
      "roleplaying_game",
      "music_video",
      "standard",
      "spectacle",
      "sci-fi",
      "adventure",
      "drama",
      "mono_movie",
      "2ch_stereo",
      "all_ch_stereo",
      "surr_decoder",
      "straight",
    ];
    const translated = translateMusicCastPrograms(ids);
    expect(Object.keys(translated ?? {})).toHaveLength(19);
    expect(translated).toMatchObject({
      "Hall in Munich": "Hall in Munich",
      "All-Ch Stereo": "All-Ch Stereo",
      "Surround Decoder": "Surround Decoder",
    });
    expect(translated).not.toHaveProperty("Straight");
  });

  test("a 2017 Aventage list translates completely (27 ids → 26 programs, straight skipped)", () => {
    const list = mainZone(rxA2070).sound_program_list;
    expect(list).toContain("straight");
    expect(Object.keys(translateMusicCastPrograms(list) ?? {})).toHaveLength(list.length - 1);
  });

  test("a soundbar's programs have no YNCA name and are refused", () => {
    expect(translateMusicCastPrograms(mainZone(ysp1600).sound_program_list)).toBeUndefined();
  });
});

describe("translateDeclaredStates — the coordinator's hook", () => {
  test("translates the input and soundProgram keys and nothing else", () => {
    expect(translateDeclaredStates("input", { hdmi1: "hdmi1" })).toEqual({ HDMI1: "HDMI1" });
    expect(translateDeclaredStates("soundProgram", { munich: "munich" })).toEqual({
      "Hall in Munich": "Hall in Munich",
    });
    expect(translateDeclaredStates("sound.toneMode", { manual: "manual" })).toBeUndefined();
  });
});

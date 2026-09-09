/**
 * MusicCast input id → the classic spelling YNCA and the XML API share ("hdmi1" → "HDMI1",
 * "net_radio" → "NET RADIO"). Every pair is evidenced — the analysis with the per-pair table:
 * `Ressourcen/yamaha/analyse-eingaenge-klangprogramme-2026-09-08.md`.
 *
 * - One receiver read both lists seconds apart (RX-V6A harvest 2026-09-01, 27 + 20 inputs) — the
 *   fixture beside the test; JUKE, MusicCast Link, AUX, Qobuz come from the XML lists of the
 *   HTR-4069 / RX-S601D (2015–2017); Rhapsody, SiriusXM, Pandora from the RX-V675 list and Yamaha's
 *   RX-A850 command list; AV1–AV7, V-AUX, MULTI CH, iPod (USB) from Yamaha's 21 official YNCA lists.
 * - "Alexa" is the one spelling no device list shows: it follows the XML feature-key rule
 *   (`Amazon_Music` → "Amazon Music", `NET_RADIO` → "NET RADIO", `MusicCast_Link` → "MusicCast Link",
 *   `<Alexa>` in every System/Config of the 2018+ generation).
 * - The soundbar/desk ids (analog, digital, hdmi, bd_dvd, aux1, aux2, …) have NO classic spelling
 *   and are deliberately absent: a device that lists them speaks no YNCA, and a list carrying one
 *   is never adopted.
 */
export const MUSICCAST_INPUT_NAMES: Readonly<Record<string, string>> = {
  airplay: "AirPlay",
  alexa: "Alexa",
  amazon_music: "Amazon Music",
  audio1: "AUDIO1",
  audio2: "AUDIO2",
  audio3: "AUDIO3",
  audio4: "AUDIO4",
  audio5: "AUDIO5",
  aux: "AUX",
  av1: "AV1",
  av2: "AV2",
  av3: "AV3",
  av4: "AV4",
  av5: "AV5",
  av6: "AV6",
  av7: "AV7",
  bluetooth: "Bluetooth",
  cd: "CD",
  coaxial1: "COAXIAL1",
  coaxial2: "COAXIAL2",
  deezer: "Deezer",
  hdmi1: "HDMI1",
  hdmi2: "HDMI2",
  hdmi3: "HDMI3",
  hdmi4: "HDMI4",
  hdmi5: "HDMI5",
  hdmi6: "HDMI6",
  hdmi7: "HDMI7",
  juke: "JUKE",
  line1: "LINE1",
  line2: "LINE2",
  line3: "LINE3",
  main_sync: "Main Zone Sync",
  mc_link: "MusicCast Link",
  multi_ch: "MULTI CH",
  napster: "Napster",
  net_radio: "NET RADIO",
  optical1: "OPTICAL1",
  optical2: "OPTICAL2",
  pandora: "Pandora",
  phono: "PHONO",
  qobuz: "Qobuz",
  rhapsody: "Rhapsody",
  server: "SERVER",
  siriusxm: "SiriusXM",
  spotify: "Spotify",
  tidal: "TIDAL",
  tuner: "TUNER",
  tv: "TV",
  usb: "USB",
  v_aux: "V-AUX",
};

/**
 * MusicCast sound program id → the YNCA SOUNDPRG name. A spelling rule ("Hall in Munich" →
 * `munich`, "The Roxy Theatre" → `roxy_theatre`, "2ch Stereo" → `2ch_stereo`) with two
 * exceptions, checked three ways (analysis 2026-09-08): Home Assistant's transcription of the
 * YXC spec agrees on all 39 pairs, a receiver's own getNameText texts on 19 of 20 (it prints
 * "All Ch Stereo" where the YNCA wire says "All-Ch Stereo" — RX-A6A protocol), and every id of
 * the five AV-receiver lists (RX-V481, RX-V685, RX-V781, RX-A2070, RX-A3080) translates.
 * `straight` is no program over YNCA — it is the STRAIGHT switch the adapter carries as
 * `sound.straight` — and is skipped. The soundbar programs (game, movie, music, stereo, tv_program,
 * bass_booster, …) have no YNCA name and refuse the list.
 */
export const MUSICCAST_PROGRAM_NAMES: Readonly<Record<string, string>> = {
  "2ch_stereo": "2ch Stereo",
  "5ch_stereo": "5ch Stereo",
  "7ch_stereo": "7ch Stereo",
  "9ch_stereo": "9ch Stereo",
  "11ch_stereo": "11ch Stereo",
  action_game: "Action Game",
  adventure: "Adventure",
  all_ch_stereo: "All-Ch Stereo",
  amsterdam: "Hall in Amsterdam",
  arena: "Arena",
  bottom_line: "The Bottom Line",
  cellar_club: "Cellar Club",
  chamber: "Chamber",
  disco: "Disco",
  drama: "Drama",
  enhanced: "Enhanced",
  frankfurt: "Hall in Frankfurt",
  freiburg: "Church in Freiburg",
  mono_movie: "Mono Movie",
  munich: "Hall in Munich",
  munich_a: "Hall in Munich A",
  munich_b: "Hall in Munich B",
  music_video: "Music Video",
  pavilion: "Pavilion",
  recital_opera: "Recital/Opera",
  roleplaying_game: "Roleplaying Game",
  roxy_theatre: "The Roxy Theatre",
  royaumont: "Church in Royaumont",
  "sci-fi": "Sci-Fi",
  spectacle: "Spectacle",
  sports: "Sports",
  standard: "Standard",
  stuttgart: "Hall in Stuttgart",
  surr_decoder: "Surround Decoder",
  tokyo: "Church in Tokyo",
  usa_a: "Hall in USA A",
  usa_b: "Hall in USA B",
  vienna: "Hall in Vienna",
  village_gate: "Village Gate",
  village_vanguard: "Village Vanguard",
  warehouse_loft: "Warehouse Loft",
};

/** MusicCast ids that are no program over YNCA (the STRAIGHT switch travels as `sound.straight`). */
const NOT_A_PROGRAM: ReadonlySet<string> = new Set(["straight"]);

/**
 * MusicCast `surr_decoder_type_list` ids → the YNCA `2CHDECODER` spelling. The ten ids are every
 * one the 26 bundled getFeatures captures declare (2026-09-09); the spellings are the official
 * command lists' (the nine-value core) and the receivers' own answers (`Auto`, `Dolby Surround`,
 * `DTS Neural:X` — ynca-python's TwoChDecoder enum, the protocol reference). `toggle` is a
 * command, not a decoder, and is skipped like `straight` among the programs.
 */
export const MUSICCAST_DECODER_NAMES: Readonly<Record<string, string>> = {
  auto: "Auto",
  dolby_surround: "Dolby Surround",
  dts_neural_x: "DTS Neural:X",
  dts_neo6_cinema: "DTS NEO:6 Cinema",
  dts_neo6_music: "DTS NEO:6 Music",
  dolby_pl: "Dolby PL",
  dolby_pl2x_movie: "Dolby PLIIx Movie",
  dolby_pl2x_music: "Dolby PLIIx Music",
  dolby_pl2x_game: "Dolby PLIIx Game",
};

/** MusicCast decoder ids that are no decoder over YNCA (`toggle` steps through the list). */
const NOT_A_DECODER: ReadonlySet<string> = new Set(["toggle"]);

/**
 * Translate a MusicCast id list with one dictionary — all or nothing.
 *
 * @param ids the MusicCast ids
 * @param names the dictionary
 * @param skip ids that are legitimately no entry of the target list
 * @returns the classic value → label map, or undefined when one id has no classic spelling
 *   (a half-translated dropdown would hide a real value) or nothing is left
 */
function translateAll(
  ids: readonly string[],
  names: Readonly<Record<string, string>>,
  skip: ReadonlySet<string>,
): Record<string, string> | undefined {
  const states: Record<string, string> = {};
  for (const id of ids) {
    if (skip.has(id)) {
      continue;
    }
    const classic = names[id];
    if (classic === undefined) {
      return undefined;
    }
    states[classic] = classic;
  }
  return Object.keys(states).length > 0 ? states : undefined;
}

/**
 * Translate a MusicCast input list into the classic dropdown.
 *
 * @param ids the MusicCast input ids of one zone
 * @returns the classic value → label map, or undefined when the list does not translate completely
 */
export function translateMusicCastInputs(ids: readonly string[]): Record<string, string> | undefined {
  return translateAll(ids, MUSICCAST_INPUT_NAMES, new Set());
}

/**
 * Translate a MusicCast sound program list into the classic dropdown (`straight` skipped).
 *
 * @param ids the MusicCast program ids of one zone
 * @returns the classic value → label map, or undefined when the list does not translate completely
 */
export function translateMusicCastPrograms(ids: readonly string[]): Record<string, string> | undefined {
  return translateAll(ids, MUSICCAST_PROGRAM_NAMES, NOT_A_PROGRAM);
}

/**
 * Translate a MusicCast surround decoder list into the classic dropdown (`toggle` skipped).
 *
 * @param ids the MusicCast decoder ids of one zone
 * @returns the classic value → label map, or undefined when the list does not translate completely
 */
export function translateMusicCastDecoders(ids: readonly string[]): Record<string, string> | undefined {
  return translateAll(ids, MUSICCAST_DECODER_NAMES, NOT_A_DECODER);
}

/**
 * The coordinator's hook: the classic spelling of a MusicCast-declared list for a capability,
 * or undefined where no dictionary exists or the list does not translate completely.
 *
 * @param key the transport-neutral capability key (`input`, `soundProgram`, …)
 * @param states the MusicCast-declared map (ids as keys)
 * @returns the classic map, or undefined
 */
export function translateDeclaredStates(
  key: string,
  states: Record<string, string>,
): Record<string, string> | undefined {
  if (key === "input") {
    return translateMusicCastInputs(Object.keys(states));
  }
  if (key === "soundProgram") {
    return translateMusicCastPrograms(Object.keys(states));
  }
  if (key === "sound.surroundDecoder") {
    return translateMusicCastDecoders(Object.keys(states));
  }
  return undefined;
}

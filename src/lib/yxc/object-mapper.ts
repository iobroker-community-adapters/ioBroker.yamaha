import { channelCommon, type ObjectDef } from "../catalog/types";
import { YXC_CURSOR_VALUES, YXC_MENU_VALUES } from "./remote";
import { tName, type I18nKey } from "../i18n";
import { YXC_ZONE_IDS, zonePrefix } from "./zones";
import type { YxcCapabilities, YxcZone } from "./capability";
import { YXC_AMP_CATALOG } from "./catalog";
import { ALARM_DAYS, DAB_FIELDS } from "./command-mapper";

/**
 * Build a value → label dropdown map from a device-reported value list.
 *
 * @param values the allowed values
 * @returns the states map
 */
function selfMap(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map(value => [value, value]));
}

/** The zones the adapter maps: main flat, zone2-4 each under multiroom. */
const ZONES: Array<{ id: string; prefix: string }> = YXC_ZONE_IDS.map(id => ({ id, prefix: zonePrefix(id) }));

/** The "now playing" block's states (v2.0.0, one per zone): read metadata + transport buttons. */
const PLAYER_STATES: Array<{
  state: string;
  common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey; descKey?: I18nKey };
}> = [
  {
    // What the zone is playing (the netusb source name, or `cd`) — read-only display;
    // switching happens over the zone's `input` state.
    state: "source",
    common: {
      nameKey: "playingSource",
      descKey: "descPlayingSource",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
  },
  {
    state: "playback",
    common: {
      // media.state is a number in the type-detector; the same 0/1/2 coding as the YNCA player.
      nameKey: "playback",
      type: "number",
      role: "media.state",
      read: true,
      write: false,
      states: { 0: "Play", 1: "Stop", 2: "Pause" },
    },
  },
  { state: "artist", common: { nameKey: "artist", type: "string", role: "media.artist", read: true, write: false } },
  { state: "album", common: { nameKey: "album", type: "string", role: "media.album", read: true, write: false } },
  { state: "track", common: { nameKey: "track", type: "string", role: "media.title", read: true, write: false } },
  // Read-only playback metadata, typed exactly like the YNCA sources so both players
  // present the same shape on one device: repeat as the media.mode.repeat number code
  // (wire off/one/all, captures-verified), shuffle as a media.mode.shuffle boolean
  // (wire knows only off/on). Writing stays with the toggle buttons — YXC has no setter.
  {
    state: "repeat",
    common: {
      nameKey: "repeat",
      type: "number",
      role: "media.mode.repeat",
      read: true,
      write: false,
      states: { 0: "Off", 1: "Single", 2: "All" },
    },
  },
  {
    state: "shuffle",
    common: { nameKey: "shuffle", type: "boolean", role: "media.mode.shuffle", read: true, write: false },
  },
  // Both forms of each time, from the one value the device reports: the seconds fill the
  // type detector's media-player slot (it takes nothing else), the text is what a
  // visualisation shows. The YNCA side publishes exactly the same pair, converted the other
  // way round — so the datapoints mean the same thing on every device.
  {
    state: "elapsedTime",
    common: {
      nameKey: "elapsedTime",
      descKey: "descElapsedTime",
      type: "number",
      unit: "s",
      role: "media.elapsed",
      read: true,
      write: false,
    },
  },
  {
    state: "elapsedTimeText",
    common: {
      nameKey: "elapsedTimeReadable",
      descKey: "descElapsedTimeReadable",
      type: "string",
      role: "media.elapsed.text",
      read: true,
      write: false,
    },
  },
  {
    state: "totalTime",
    common: {
      nameKey: "totalTime",
      descKey: "descTotalTime",
      type: "number",
      unit: "s",
      role: "media.duration",
      read: true,
      write: false,
    },
  },
  {
    state: "totalTimeText",
    common: {
      nameKey: "totalTimeReadable",
      descKey: "descTotalTimeReadable",
      type: "string",
      role: "media.duration.text",
      read: true,
      write: false,
    },
  },
  {
    state: "albumArt",
    common: {
      nameKey: "albumArt",
      descKey: "descAlbumArt",
      type: "string",
      role: "media.cover",
      read: true,
      write: false,
    },
  },
  // Transport buttons carry the type-detector media-player roles so a MusicCast player's
  // controls are recognised as play/pause/stop/next/prev, not generic buttons.
  { state: "play", common: { nameKey: "play", type: "boolean", role: "button.play", read: false, write: true } },
  { state: "pause", common: { nameKey: "pause", type: "boolean", role: "button.pause", read: false, write: true } },
  { state: "stop", common: { nameKey: "stop", type: "boolean", role: "button.stop", read: false, write: true } },
  { state: "next", common: { nameKey: "next", type: "boolean", role: "button.next", read: false, write: true } },
  { state: "prev", common: { nameKey: "previous", type: "boolean", role: "button.prev", read: false, write: true } },
  {
    state: "repeatToggle",
    common: {
      nameKey: "toggleRepeat",
      descKey: "descToggleRepeat",
      type: "boolean",
      role: "button",
      read: false,
      write: true,
    },
  },
  {
    state: "shuffleToggle",
    common: {
      nameKey: "toggleShuffle",
      descKey: "descToggleShuffle",
      type: "boolean",
      role: "button",
      read: false,
      write: true,
    },
  },
];

/**
 * Append a media-player block (channel + the shared player states) under a
 * dotted prefix. Used for every player source the device reports.
 *
 * @param objects the object list to append to
 * @param prefix the channel/state prefix (e.g. `netPlayer`, `cd`)
 * @param channelName the human-readable channel name
 */
function pushPlayerBlock(objects: ObjectDef[], prefix: string, channelName: ioBroker.StringOrTranslated): void {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    const { nameKey: playerNameKey, descKey: playerDescKey, ...playerCommon } = player.common;
    objects.push({
      id: `${prefix}.${player.state}`,
      type: "state",
      common: {
        ...playerCommon,
        name: tName(playerNameKey),
        ...(playerDescKey ? { desc: tName(playerDescKey) } : {}),
      },
    });
  }
}

/**
 * The `range_step` id that carries a state's bounds. The names are the device's own
 * (capture-verified across 25 models); a state not listed here declares no range.
 *
 * `actualVolume` deliberately takes the dB range, not the numeric one: the datapoint is
 * declared in dB, and a device that reports both would otherwise get the union of two
 * different scales.
 */
const RANGE_BY_STATE: Readonly<Record<string, string>> = {
  volume: "volume",
  "sound.bass": "tone_control",
  "sound.treble": "tone_control",
  subwooferVolume: "subwoofer_volume",
  "sound.dialogueLevel": "dialogue_level",
  "sound.dialogueLift": "dialogue_lift",
  "sound.dtsDialogueControl": "dts_dialogue_control",
  "sound.balance": "balance",
  "sound.equalizer.low": "equalizer",
  "sound.equalizer.mid": "equalizer",
  "sound.equalizer.high": "equalizer",
};

/** One `range_step` entry as a zone declares it. */
type DeclaredRange = NonNullable<YxcZone["ranges"]>[string];

/**
 * The presentation of `actualVolume` for the scale the device says it is DISPLAYING.
 *
 * `actual_volume.value` arrives in the form named by `actual_volume.mode` — a device set to its
 * numeric scale reports 36 where the decibel scale would read -44.5. Declaring the datapoint as dB
 * regardless was wrong on both counts: the unit lied, and js-controller warned on every poll because
 * the value sat outside the decibel bounds (measured on an RX-V6A, 2026-09-09).
 *
 * Without a reported mode nothing is assumed: no bounds until one arrives, never a fallback to dB.
 *
 * @param zone the zone whose declared ranges are read
 * @param mode the display mode the zone reports right now, if any
 * @returns unit, name keys and the matching bounds
 */
export function actualVolumePresentation(
  zone: YxcZone,
  mode: string | undefined,
): { unit: string; nameKey: I18nKey; descKey: I18nKey; range: DeclaredRange | undefined } {
  const db = zone.ranges?.actual_volume_db;
  const numeric = zone.ranges?.actual_volume_numeric;
  // A zone that declares ONE scale can only display that one — its status does not have to say so
  // (the RX-A2070 declares `actual_volume_db` for every zone and answers a status for main only).
  const onlyScale = db && !numeric ? "db" : numeric && !db ? "numeric" : undefined;
  const shown = mode === "db" || mode === "numeric" ? mode : onlyScale;
  if (shown === "db") {
    return { unit: "dB", nameKey: "volumeDB", descKey: "descVolumeDB", range: db };
  }
  if (shown === "numeric") {
    return { unit: "", nameKey: "volumeDisplay", descKey: "descVolumeDisplay", range: numeric };
  }
  // Both scales declared and none reported: the envelope of the two. Every value the device can
  // send lies inside it, and — unlike leaving the bounds out — it REPLACES what an existing
  // installation stored, because `extendObject` merges and a field the new picture drops survives.
  return {
    unit: "",
    nameKey: "volumeDisplay",
    descKey: "descVolumeDisplay",
    range:
      db && numeric
        ? {
            min: Math.min(db.min, numeric.min),
            max: Math.max(db.max, numeric.max),
            step: Math.min(db.step, numeric.step),
          }
        : undefined,
  };
}

/**
 * Turn YXC capabilities into the unified object tree: main's functions as
 * top-level states, each additional zone as a channel with its own states. An
 * input state is added when the zone offers inputs. Player sources (netusb, cd)
 * and the tuner get their own channel. Only reported functions are created,
 * parents before children. States and their common come from {@link YXC_AMP_CATALOG}.
 *
 * @param capabilities the parsed YXC capabilities
 * @param current the string values each zone reports right now (zone id → state id → value), so
 *   a reported value is always in its dropdown even where the device's own list omits it
 * @returns the object definitions to create
 */
export function mapYxcToObjects(
  capabilities: YxcCapabilities,
  current?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ObjectDef[] {
  const objects: ObjectDef[] = [];
  const channels = new Set<string>();
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find(z => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const hasInput = zone.inputs.length > 0;
    const entries = YXC_AMP_CATALOG.filter(entry => {
      // Device-global entries (id under multiroom.) exist once — never as a per-zone copy.
      if (zoneDef.id !== "main" && entry.state.startsWith("multiroom.")) {
        return false;
      }
      if (entry.create.kind === "always") {
        return true;
      }
      if (entry.create.kind === "input") {
        return hasInput;
      }
      return zone.funcs.includes(entry.create.func);
    });
    // A zone needs an advertised function or an input to exist — the "always" status
    // fields alone (which every entry set contains) do not create a zone.
    if (!entries.some(entry => entry.create.kind !== "always")) {
      continue;
    }
    // Every parent — the zone channel included — is created by the per-state loop and
    // named from the shared CHANNEL_NAMES table (a zone exists only with an entry).
    for (const entry of entries) {
      const fullId = `${zoneDef.prefix}${entry.state}`;
      const segments = fullId.split(".");
      for (let i = 1; i < segments.length; i++) {
        const channelId = segments.slice(0, i).join(".");
        if (!channels.has(channelId)) {
          channels.add(channelId);
          const segment = segments[i - 1];
          objects.push({
            id: channelId,
            type: "channel",
            common: channelCommon(segment),
          });
        }
      }
      const { nameKey: entryNameKey, descKey: entryDescKey, ...entryRest } = entry.common;
      const common: ObjectDef["common"] = {
        ...entryRest,
        name: tName(entryNameKey),
        ...(entryDescKey ? { desc: tName(entryDescKey) } : {}),
      };
      // The device declares the bounds of its own numeric controls in `range_step`; whatever
      // it says wins over anything the catalog could guess. Only `volume` used to be read
      // (audit 2026-09-06) — bass, treble, subwoofer trim, dialogue level/lift, DTS dialogue
      // control, balance and the equalizer bands stood there as numbers without a slider.
      let range: DeclaredRange | undefined;
      if (entry.state === "actualVolume") {
        const shown = actualVolumePresentation(zone, current?.[zone.id]?.actualVolumeMode);
        common.unit = shown.unit;
        common.name = tName(shown.nameKey);
        common.desc = tName(shown.descKey);
        range = shown.range;
      } else {
        const rangeId = RANGE_BY_STATE[entry.state];
        range = rangeId ? zone.ranges?.[rangeId] : undefined;
      }
      if (range) {
        common.min = range.min;
        common.max = range.max;
        common.step = range.step;
      }
      // The device's own allowed-value lists (getFeatures) become dropdowns — DECLARED, so the
      // coordinator puts them on a YNCA-owned datapoint too, through the dictionary (#619):
      // the zone's inputs on the input state, sound_program_list & co on their states. What the
      // zone REPORTS right now is always selectable as well: the RX-A2070 capture lists only
      // "manual" as tone-control mode and answers "auto" — a device contradicting itself must
      // not leave the admin with a raw value nobody can pick again.
      let declared = false;
      if (entry.state === "input" && zone.inputs.length > 0) {
        common.states = selfMap(zone.inputs);
        declared = true;
      }
      const valueList = zone.valueLists?.[entry.state];
      if (valueList) {
        common.states = selfMap(valueList);
        declared = true;
      }
      const reported = current?.[zone.id]?.[entry.state];
      if (common.states && typeof reported === "string" && reported.length > 0 && !(reported in common.states)) {
        common.states = { ...common.states, [reported]: reported };
      }
      objects.push({ id: fullId, type: "state", common, ...(declared ? { declaredStates: true } : {}) });
    }
    const zoneChannelHelper = (id: string, common: ObjectDef["common"]): void => {
      if (!channels.has(id)) {
        channels.add(id);
        objects.push({ id, type: "channel", common });
      }
    };
    // Scene recall (#615): the zone declares `scene` + scene_num — per zone, so a
    // Zone-2 scene is first-class (the RX-V6A declares 8 for main AND zone2).
    if (zone.funcs.includes("scene") && zone.sceneNum && zone.sceneNum > 0) {
      zoneChannelHelper(`${zoneDef.prefix}scene`, channelCommon("scene"));
      objects.push({
        id: `${zoneDef.prefix}scene.recall`,
        type: "state",
        common: {
          name: tName("recallScene"),
          desc: tName("descRecallScene"),
          type: "number",
          role: "level",
          read: true,
          write: true,
          min: 1,
          max: zone.sceneNum,
          step: 1,
        },
      });
    }
    // The on-screen remote (cursor pad + menu keys) — declared as zone functions
    // `cursor`/`menu`. The words come from the zone's own `cursor_list`/`menu_list` where the
    // firmware declares them (declared); a zone that declares none keeps the shared vocabulary,
    // which is the MAXIMUM any MusicCast device accepts (device-verified endpoints).
    if (zone.funcs.includes("cursor") || zone.funcs.includes("menu")) {
      zoneChannelHelper(`${zoneDef.prefix}remote`, channelCommon("remote"));
      const wordsFor = (
        id: "remote.cursor" | "remote.menu",
        fallback: readonly string[],
      ): { states: Record<string, string>; declared: boolean } => {
        const declaredWords = zone.valueLists?.[id];
        return declaredWords
          ? { states: selfMap(declaredWords), declared: true }
          : { states: selfMap([...fallback]), declared: false };
      };
      if (zone.funcs.includes("cursor")) {
        const words = wordsFor("remote.cursor", YXC_CURSOR_VALUES);
        objects.push({
          id: `${zoneDef.prefix}remote.cursor`,
          type: "state",
          common: {
            name: tName("cursorPad"),
            desc: tName("descCursorPad"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: words.states,
          },
          ...(words.declared ? { declaredStates: true } : {}),
        });
      }
      if (zone.funcs.includes("menu")) {
        const words = wordsFor("remote.menu", YXC_MENU_VALUES);
        objects.push({
          id: `${zoneDef.prefix}remote.menu`,
          type: "state",
          common: {
            name: tName("menuKey"),
            desc: tName("descMenuKey"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: words.states,
          },
          ...(words.declared ? { declaredStates: true } : {}),
        });
      }
    }
    // The audio-signal info (own endpoint, declared as `signal_info`): what the zone
    // currently decodes — format, sampling rate, bit depth, bitrate.
    if (zone.funcs.includes("signal_info")) {
      zoneChannelHelper(`${zoneDef.prefix}sound`, channelCommon("sound"));
      zoneChannelHelper(`${zoneDef.prefix}sound.signal`, channelCommon("signal"));
      const signal = (
        id: string,
        name: ioBroker.StringOrTranslated,
        type: "string" | "number",
        role: "text" | "value",
        desc?: ioBroker.StringOrTranslated,
      ): void => {
        objects.push({
          id: `${zoneDef.prefix}sound.signal.${id}`,
          type: "state",
          common: { name, ...(desc ? { desc } : {}), type, role, read: true, write: false },
        });
      };
      signal("format", tName("audioSignalFormat"), "string", "text");
      signal("sampling", tName("audioSamplingRate"), "string", "text");
      signal("bits", tName("audioBitDepth"), "string", "text");
      signal("bitrate", tName("audioBitrate"), "number", "value", tName("descAudioBitrate"));
    }
  }
  if (capabilities.media.includes("netusb") || capabilities.media.includes("cd")) {
    // ONE "now playing" block per zone (v2.0.0): the controller feeds it from
    // whichever source the zone is listening to (netusb or cd) and clears it on a
    // source switch. The source folders below keep only their genuinely own states.
    pushPlayerBlock(objects, "player", tName("mediaPlayer"));
    for (const zone of capabilities.zones) {
      if (zone.id !== "main") {
        pushPlayerBlock(objects, `${zonePrefix(zone.id)}player`, tName("mediaPlayer"));
      }
    }
  }
  if (capabilities.media.includes("netusb")) {
    objects.push({ id: "player.netPlayer", type: "channel", common: { name: tName("networkPlayer") } });
    objects.push({
      id: "player.netPlayer.preset",
      type: "state",
      common: {
        name: tName("recallPreset"),
        desc: tName("descRecallPreset"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
      },
    });
    // The favourites and recently-played lists (names included) plus the recall-by-number
    // for recents — the musiccast adapter's selection surface, on our tree.
    objects.push({
      id: "player.netPlayer.presets",
      type: "state",
      common: {
        name: tName("favouritesStoredPresets"),
        desc: tName("descFavouritesStoredPresets"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "player.netPlayer.recent",
      type: "state",
      common: {
        name: tName("recentlyPlayed"),
        desc: tName("descRecentlyPlayed"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "player.netPlayer.recallRecent",
      type: "state",
      common: {
        name: tName("recallRecentlyPlayedNumber"),
        desc: tName("descRecallRecentlyPlayedNumber"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
      },
    });
    // MusicCast playlists and the play queue — declared in the netusb func_list.
    // Read-only surfaces: no write path for them is documented anywhere, and blind
    // writes are exactly what this adapter no longer does.
    if (capabilities.netusbFuncs?.includes("mc_playlist")) {
      objects.push({
        id: "player.netPlayer.playlists",
        type: "state",
        common: {
          name: tName("musiccastPlaylists"),
          desc: tName("descMusiccastPlaylists"),
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
      });
    }
    if (capabilities.netusbFuncs?.includes("play_queue")) {
      objects.push({
        id: "player.netPlayer.queue",
        type: "state",
        common: {
          name: tName("playQueue"),
          desc: tName("descPlayQueue"),
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
      });
    }
  }
  if (capabilities.media.includes("cd")) {
    // Drive-own states only — what the disc is PLAYING shows in the flat block above.
    objects.push({ id: "player.cd", type: "channel", common: { name: tName("cd") } });
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: {
        name: tName("toggleTray"),
        desc: tName("descToggleTray"),
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
    });
    objects.push({
      id: "player.cd.trackNumber",
      type: "state",
      common: { name: tName("trackNumber"), type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.totalTracks",
      type: "state",
      common: { name: tName("totalTracks"), type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.discTime",
      type: "state",
      common: { name: tName("discTime"), type: "number", unit: "s", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.deviceStatus",
      type: "state",
      common: {
        name: tName("driveStatus"),
        desc: tName("descDriveStatus"),
        type: "string",
        role: "state",
        read: true,
        write: false,
      },
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: tName("tuner") } });
    const bandCommon: ObjectDef["common"] = {
      name: tName("band"),
      type: "string",
      role: "state",
      read: true,
      write: true,
    };
    const bands = capabilities.tuner?.bands ?? [];
    if (bands.length > 0) {
      bandCommon.states = selfMap(bands);
    }
    objects.push({ id: "tuner.band", type: "state", common: bandCommon });
    // Frequency in kHz — FM/AM/DAB all report kHz in getPlayInfo (FM 100900 =
    // 100.9 MHz, AM 1080, DAB 180064), verified against real device captures. The bounds are
    // the ENVELOPE of the ranges the device declares per band (AM 531 kHz … FM 108000 kHz):
    // one datapoint serves every band, so it can carry the outer limits but no single step
    // (FM steps 50 kHz, 200 in the US; AM 9 or 10).
    const frequencyCommon: ObjectDef["common"] = {
      name: tName("frequency"),
      type: "number",
      unit: "kHz",
      role: "level",
      read: true,
      write: true,
    };
    const bandRanges = Object.values(capabilities.tuner?.ranges ?? {});
    if (bandRanges.length > 0) {
      frequencyCommon.min = Math.min(...bandRanges.map(range => range.min));
      frequencyCommon.max = Math.max(...bandRanges.map(range => range.max));
    }
    objects.push({ id: "tuner.frequency", type: "state", common: frequencyCommon });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: {
        name: tName("rdsText"),
        desc: tName("descRdsText"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.rdsTextB",
      type: "state",
      common: {
        name: tName("rdsTextB"),
        desc: tName("descRdsTextB"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.rdsService",
      type: "state",
      common: {
        name: tName("rdsStation"),
        desc: tName("descRdsStation"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.rdsProgramType",
      type: "state",
      common: {
        name: tName("rdsProgrammeType"),
        desc: tName("descRdsProgramType"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    // The stored-station surface: recall by number (writable), the active slot read back
    // from play info, up/down stepping, and the stored lists (with what the device knows
    // about each slot) as JSON — the selection surface the musiccast adapter offered.
    const presetCommon: ObjectDef["common"] = {
      name: tName("presetRecallByNumber"),
      desc: tName("descPresetRecallByNumber"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
    };
    if (capabilities.tuner?.presetNum) {
      presetCommon.max = capabilities.tuner.presetNum;
    }
    objects.push({ id: "tuner.preset", type: "state", common: presetCommon });
    objects.push({
      id: "tuner.presetUp",
      type: "state",
      common: { name: tName("nextPreset"), type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "tuner.presetDown",
      type: "state",
      common: { name: tName("previousPreset"), type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "tuner.presets",
      type: "state",
      common: {
        name: tName("storedPresets"),
        desc: tName("descStoredPresets"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.tuned",
      type: "state",
      common: {
        name: tName("tuned"),
        desc: tName("descTunedToAStation"),
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.audioMode",
      type: "state",
      common: {
        name: tName("audioMode"),
        desc: tName("descAudioMode"),
        type: "string",
        role: "state",
        read: true,
        write: false,
      },
    });
    if (bands.includes("dab")) {
      objects.push({ id: "tuner.dab", type: "channel", common: { name: tName("dab") } });
      for (const field of DAB_FIELDS) {
        objects.push({
          id: field.id,
          type: "state",
          common: {
            name: tName(field.nameKey),
            ...(field.descKey ? { desc: tName(field.descKey) } : {}),
            type: field.type,
            role: field.type === "boolean" ? "indicator" : field.type === "number" ? "value" : "text",
            read: true,
            write: false,
          },
        });
      }
    }
  }
  if (capabilities.clock) {
    // The clock/alarm block, as the musiccast adapter showed it — read-only display
    // (the predecessor's clock datapoints had no working write path either); the
    // devices that report it are the desk-audio/clock models.
    objects.push({
      id: "clock",
      type: "channel",
      common: { name: tName("clockAlarm"), desc: tName("descClockAlarm") },
    });
    objects.push({
      id: "clock.autoSync",
      type: "state",
      common: {
        name: tName("automaticTimeSync"),
        desc: tName("descAutomaticTimeSync"),
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "clock.format",
      type: "state",
      common: {
        name: tName("clockFormat"),
        desc: tName("descClockFormat"),
        type: "string",
        role: "state",
        read: true,
        write: false,
      },
    });
    objects.push({ id: "clock.alarm", type: "channel", common: { name: tName("alarm") } });
    objects.push({
      id: "clock.alarm.on",
      type: "state",
      common: { name: tName("alarmArmed"), type: "boolean", role: "indicator", read: true, write: false },
    });
    const volumeCommon: ObjectDef["common"] = {
      name: tName("alarmVolume"),
      type: "number",
      role: "value",
      read: true,
      write: false,
    };
    if (capabilities.clock.alarmVolumeRange) {
      volumeCommon.min = capabilities.clock.alarmVolumeRange.min;
      volumeCommon.max = capabilities.clock.alarmVolumeRange.max;
    }
    objects.push({ id: "clock.alarm.volume", type: "state", common: volumeCommon });
    objects.push({
      id: "clock.alarm.fadeInterval",
      type: "state",
      common: {
        name: tName("fadeInTime"),
        desc: tName("descFadeInTime"),
        type: "number",
        unit: "s",
        role: "value",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "clock.alarm.fadeType",
      type: "state",
      common: {
        name: tName("fadeType"),
        desc: tName("descFadeType"),
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "clock.alarm.mode",
      type: "state",
      common: { name: tName("alarmMode"), type: "string", role: "state", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.repeat",
      type: "state",
      common: {
        name: tName("repeatSnooze"),
        desc: tName("descRepeatSnooze"),
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
    });
    const detailChannels = ["oneday", ...(capabilities.clock.alarmModes.includes("weekly") ? ALARM_DAYS : [])];
    for (const channel of detailChannels) {
      // The weekday channels are named by the device; only the fixed one-day channel translates.
      const label: ioBroker.StringOrTranslated =
        channel === "oneday" ? tName("oneDayAlarm") : channel.charAt(0).toUpperCase() + channel.slice(1);
      objects.push({ id: `clock.alarm.${channel}`, type: "channel", common: { name: label } });
      const detail = (
        id: string,
        name: ioBroker.StringOrTranslated,
        type: "boolean" | "number" | "string",
        role: string,
      ): void => {
        objects.push({
          id: `clock.alarm.${channel}.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false },
        });
      };
      detail("enable", tName("enabled"), "boolean", "indicator");
      detail("time", tName("alarmTime"), "string", "text");
      detail("beep", tName("beep"), "boolean", "indicator");
      detail("playbackType", tName("playbackType"), "string", "state");
      detail("resumeInput", tName("resumeInput"), "string", "state");
      detail("presetType", tName("presetType"), "string", "state");
      detail("presetNumber", tName("presetNumber"), "number", "value");
      detail("presetInput", tName("presetSource"), "string", "state");
    }
  }
  if (capabilities.hasDistribution) {
    // The MusicCast-Link states live in their own folder so the tree itself tells the
    // scope: directly under multiroom = all zones of this device, group = linked devices.
    // Both channels already exist: the main zone's always-created
    // multiroom.group.streamingEnabled state brought them in through the parent loop.
    const distState = (
      id: string,
      name: ioBroker.StringOrTranslated,
      role: string,
      desc?: ioBroker.StringOrTranslated,
    ): void => {
      objects.push({
        id: `multiroom.group.${id}`,
        type: "state",
        common: { name, ...(desc ? { desc } : {}), type: "string", role, read: true, write: false },
      });
    };
    distState("role", tName("roleServerClient"), "state", tName("descRoleServerClient"));
    distState("id", tName("groupID"), "text", tName("descGroupID"));
    distState("name", tName("groupName"), "text");
    distState("serverZone", tName("serverZoneFeedsTheGroup"), "text");
    distState("linkedDevices", tName("linkedDevices"), "json", tName("descLinkedDevices"));
    objects.push({
      id: "multiroom.group.leave",
      type: "state",
      common: {
        name: tName("leaveGroup"),
        desc: tName("descLeaveGroup"),
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
    });
    objects.push({
      id: "multiroom.group.linkDevice",
      type: "state",
      common: {
        name: tName("linkADeviceItsIP"),
        desc: tName("descLinkADeviceItsIP"),
        type: "string",
        role: "text",
        read: false,
        write: true,
      },
    });
  }
  return objects;
}

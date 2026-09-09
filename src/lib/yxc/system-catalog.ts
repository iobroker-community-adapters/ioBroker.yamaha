import type { ObjectDef } from "../catalog/types";
import type { I18nKey } from "../i18n";
import type { YxcClientLike } from "./client-contract";

/**
 * The device-WIDE MusicCast settings, from `/system/getFuncStatus`.
 *
 * The zone catalog covers everything a zone reports; this covers what the device reports for
 * itself. The adapter asked for neither until the 2026-09-06 audit — `getFuncStatus` was never
 * called at all, so the automatic standby, the display brightness and the HDMI output switches
 * had no datapoint, although the bundled captures declare the matching capability on up to 15
 * of 25 models and the reference library carries every endpoint used here.
 *
 * Claim with proof, like the XML side: an entry becomes an object only when THIS device's
 * getFuncStatus really contains the field. A capability list is a promise, the answer is the
 * evidence — and the field names of the entries the captures do not show are not invented here.
 */
export interface YxcSystemEntry {
  /** Unified state id (device-wide, no zone prefix). */
  state: string;
  /** The field in the getFuncStatus response this state reads. */
  field: string;
  /** ioBroker common, with its name and explanation as translation keys. */
  common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey; descKey?: I18nKey };
  /** Turn the raw field value into the state value. */
  fromStatus: (value: unknown) => boolean | number | string;
  /** Write mapping — absent means the device offers no documented setter. */
  write?: { apply: (client: YxcClientLike, value: unknown) => Promise<unknown> };
  /** The `range_step` id in the system block that carries this state's bounds, if any. */
  rangeId?: string;
  /** The `*_list` id in the system block that declares this state's values, if any. */
  listId?: string;
  /** The `*_num` id in the system block that declares how many of these exist (1..n), if any. */
  countId?: string;
  /** Turn a declared list entry or count slot into the state's value (defaults to the id itself). */
  toValue?: (declared: string | number) => string;
}

/** The device-wide MusicCast settings the adapter maps. */
export const YXC_SYSTEM_CATALOG: YxcSystemEntry[] = [
  {
    state: "advanced.autoPowerStandby",
    field: "auto_power_standby",
    common: {
      nameKey: "automaticStandby",
      descKey: "descAutomaticStandby",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    fromStatus: value => Boolean(value),
    write: { apply: (client, value) => client.setAutoPowerStandby(Boolean(value)) },
  },
  {
    state: "advanced.displayBrightness",
    field: "dimmer",
    common: {
      nameKey: "displayBrightness",
      descKey: "descDisplayBrightness",
      type: "number",
      role: "level.dimmer",
      read: true,
      write: false,
    },
    fromStatus: value => Number(value),
    rangeId: "dimmer",
  },
  {
    state: "hdmi.out1",
    field: "hdmi_out_1",
    common: {
      nameKey: "hdmiOUT1",
      descKey: "descHdmiOUT1",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    fromStatus: value => Boolean(value),
    write: { apply: (client, value) => client.setHdmiOut1(Boolean(value)) },
  },
  {
    state: "hdmi.out2",
    field: "hdmi_out_2",
    common: {
      nameKey: "hdmiOUT2",
      descKey: "descHdmiOUT2",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    fromStatus: value => Boolean(value),
    write: { apply: (client, value) => client.setHdmiOut2(Boolean(value)) },
  },
  // The fields the captured getFuncStatus answers carry beyond those four (RX-V685, RX-A3080,
  // RX-V6A — coverage audit 2026-09-09). Read-only where the reference library has no setter;
  // party mode writes through its `setPartyMode`. The MusicCast func_list promises more
  // (ypao_volume, zone_b_volume_sync, network_standby, …) — no capture shows their answer
  // field, so they stay out rather than being guessed.
  {
    state: "hdmi.out3",
    field: "hdmi_out_3",
    common: {
      nameKey: "hdmiOUT3",
      descKey: "descHdmiOUT3",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    fromStatus: value => Boolean(value),
  },
  {
    state: "hdmi.standbyThrough",
    field: "hdmi_standby_through",
    common: {
      nameKey: "hdmiStandbyThrough",
      descKey: "descHdmiStandbyThrough",
      type: "string",
      role: "state",
      read: true,
      write: false,
    },
    fromStatus: value => String(value),
    listId: "hdmi_standby_through_list",
  },
  {
    state: "advanced.headphone",
    field: "headphone",
    common: {
      nameKey: "headphone",
      descKey: "descHeadphone",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    fromStatus: value => Boolean(value),
  },
  {
    state: "multiroom.party",
    field: "party_mode",
    common: {
      nameKey: "partyModeAllZones",
      descKey: "descPartyModeAllZones",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    fromStatus: value => Boolean(value),
    write: { apply: (client, value) => client.setPartyMode(Boolean(value)) },
  },
  // Reported as a number (1, 2); shown in YNCA's spelling so the one datapoint reads alike on
  // every transport, with the declared count as its value list.
  {
    state: "advanced.speakers.pattern",
    field: "speaker_pattern",
    common: {
      nameKey: "speakerPattern",
      descKey: "descSpeakerPattern",
      type: "string",
      role: "state",
      read: true,
      write: false,
    },
    fromStatus: value => `Pattern ${Number(value)}`,
    countId: "speaker_pattern_num",
    toValue: slot => `Pattern ${slot}`,
  },
  {
    state: "hdmi.videoPreset",
    field: "video_preset",
    common: {
      nameKey: "hdmiVideoPreset",
      descKey: "descHdmiVideoPreset",
      type: "number",
      role: "value",
      read: true,
      write: false,
    },
    fromStatus: value => Number(value),
    countId: "video_preset_num",
  },
];

/**
 * The entries this device really answers, taken from its getFuncStatus response.
 *
 * @param funcStatus the raw getFuncStatus response
 * @returns the entries whose field the device delivered
 */
export function presentSystemEntries(funcStatus: unknown): YxcSystemEntry[] {
  if (typeof funcStatus !== "object" || funcStatus === null) {
    return [];
  }
  const fields = funcStatus as Record<string, unknown>;
  return YXC_SYSTEM_CATALOG.filter(entry => entry.field in fields && fields[entry.field] !== null);
}

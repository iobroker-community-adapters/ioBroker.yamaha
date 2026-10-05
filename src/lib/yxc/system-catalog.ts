import type { ObjectDef } from "../catalog/types";
import type { I18nKey } from "../i18n";
import type { YxcCapabilities } from "./capability";
import type { YxcClientLike } from "./client-contract";
import { gateValue, readNumber, readSwitch, readWord } from "./values";

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
  /** Turn the raw field value into the state value — `null` where the answer names none. */
  fromStatus: (value: unknown) => boolean | number | string | null;
  /**
   * Write mapping — absent means the device offers no documented setter. The setter takes the value the one gate
   * made of the written one ({@link systemWrite}): a switch's boolean, a number on the declared grid, a word. It
   * coerces nothing of its own — a switch is on for `true` alone, never for the word "false".
   */
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
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setAutoPowerStandby(on === true) },
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
      write: true,
    },
    fromStatus: readNumber,
    // YXC Basic §4.26: -1 is automatic, where the declared range includes it.
    write: { apply: (client, value) => client.setDimmer(Number(value)) },
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
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setHdmiOut1(on === true) },
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
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setHdmiOut2(on === true) },
  },
  // The four getFuncStatus fields YXC Basic Rev 1.10 §4.21 names together with their setters
  // (§4.23–4.25, §4.27). The field names come from the specification, not from a guess — the old
  // comment here kept them out as unseen; like every entry they appear only where the device
  // answers the field (audit 2026-09-24, C25). Same ids as the YNCA switches where YNCA has one.
  {
    state: "advanced.speakers.speakerA",
    field: "speaker_a",
    common: { nameKey: "speakerA", type: "boolean", role: "switch", read: true, write: true },
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setSpeakerA(on === true) },
  },
  {
    state: "advanced.speakers.speakerB",
    field: "speaker_b",
    common: { nameKey: "speakerB", type: "boolean", role: "switch", read: true, write: true },
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setSpeakerB(on === true) },
  },
  {
    state: "advanced.irSensor",
    field: "ir_sensor",
    common: {
      nameKey: "irSensor",
      descKey: "descIrSensor",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setIrSensor(on === true) },
  },
  {
    state: "multiroom.zoneB.volumeSync",
    field: "zone_b_volume_sync",
    common: {
      nameKey: "zoneBVolumeSync",
      descKey: "descZoneBVolumeSync",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setZoneBVolumeSync(on === true) },
  },
  // The fields the captured getFuncStatus answers carry beyond those four (RX-V685, RX-A3080,
  // RX-V6A — coverage audit 2026-09-09). Read-only where no setter is known (HDMI OUT 3, HDMI
  // standby through, the headphone jack, the video preset); party mode writes through
  // `setPartyMode`, the speaker pattern through `setSpeakerPattern`.
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
    fromStatus: readSwitch,
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
    fromStatus: readWord,
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
    fromStatus: readSwitch,
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
    fromStatus: readSwitch,
    write: { apply: (client, on) => client.setPartyMode(on === true) },
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
      write: true,
    },
    fromStatus: (value: unknown): string | null => {
      const slot = readNumber(value);
      return slot === null ? null : `Pattern ${slot}`;
    },
    // pyamaha's `setSpeakerPattern?num=` — no specification, no known caller; where YNCA is present
    // its documented SPPATTERN owns the datapoint (owner policy), so this serves a MusicCast-only
    // receiver, and a refusal is read back (audit 2026-09-24, C8/C20).
    write: {
      apply: (client: YxcClientLike, value: unknown): Promise<unknown> => {
        const slot = /^\s*(?:Pattern\s*)?(\d+)\s*$/i.exec(String(value))?.[1];
        return slot === undefined
          ? Promise.reject(new Error(`"${String(value)}" is no speaker pattern`))
          : client.setSpeakerPattern(Number(slot));
      },
    },
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
    fromStatus: readNumber,
    countId: "video_preset_num",
  },
];

/**
 * A write to a device-wide setting through the one gate — the switch words, the strict number rule and the grid the
 * system block declares, as on every zone datapoint: the client call to run, or why nothing is sent. The controller
 * coerced the switches here on its own, and the setters a second time with `Boolean()` (review 2026-10-05, KISS).
 *
 * @param entry the system catalog entry
 * @param value the written value
 * @param capabilities the device's declarations (the system block's ranges), when known
 * @returns the call, or the reason
 */
export function systemWrite(
  entry: YxcSystemEntry,
  value: unknown,
  capabilities?: Pick<YxcCapabilities, "systemRanges">,
): { run: (client: YxcClientLike) => Promise<unknown>; dropped?: never } | { dropped: string; run?: never } {
  const write = entry.write;
  if (!write) {
    return { dropped: "it is read-only on MusicCast" };
  }
  const grid = entry.rangeId ? capabilities?.systemRanges?.[entry.rangeId] : undefined;
  const gated = gateValue(entry.common.type, value, grid);
  if (gated.dropped !== undefined) {
    return { dropped: gated.dropped };
  }
  const input = gated.value;
  return { run: client => write.apply(client, input) };
}

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

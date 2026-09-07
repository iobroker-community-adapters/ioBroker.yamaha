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

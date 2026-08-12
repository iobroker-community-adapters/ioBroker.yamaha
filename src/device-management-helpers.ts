import type { JsonFormSchema } from "@iobroker/dm-utils";
import { t } from "./lib/i18n";
import { sanitizeId } from "./lib/pure-helpers";

/** Object-id segments the adapter reserves for its own tree — a device may not take them. */
const RESERVED_IDS = new Set(["info"]);
/** IPv4 dotted-quad — the single source for both the frontend validator and the backend check. */
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** The three transports shown as card indicators, in fixed order, with the label the user sees. */
export const TRANSPORTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "ynca", label: "YNCA" },
  { id: "yxc", label: "MusicCast" },
  { id: "xml", label: "XML" },
];

/** One raw manual device row from `native.devices` (the name is optional). */
export interface ManualRow {
  /** Display name, or empty/absent when the user left it blank. */
  name?: string;
  /** The device IP address. */
  ip: string;
}

/** A running device as shown on a card, plus which source it came from (routes edit/delete). */
export interface CardDevice {
  /** The id-safe device id (object-tree path segment). */
  id: string;
  /** The device IP address. */
  ip: string;
  /** The card header name. */
  name: string;
  /** Where it lives: the manual `native.devices` table, or the auto-discovery store. */
  source: "manual" | "discovered";
}

/**
 * The id the object tree uses for a manual row: its name, or the ip when the name is blank.
 *
 * @param row the manual device row
 * @returns the id-safe device id
 */
export function rowId(row: ManualRow): string {
  return sanitizeId(row.name && row.name.length > 0 ? row.name : row.ip);
}

/**
 * The add/edit form for one receiver: a display name and the IP address. The IP field
 * carries a live validator against a valid dotted-quad that is not already in use (the OK
 * button greys out on a clash). Labels are resolved translation objects so the embedded
 * form is language-correct.
 *
 * @param usedIps the IPs taken by OTHER devices (the edited device excluded)
 * @returns the jsonConfig panel schema for one device
 */
export function buildDeviceForm(usedIps: readonly string[]): JsonFormSchema {
  const ipList = JSON.stringify([...usedIps]);
  return {
    type: "panel",
    items: {
      name: {
        type: "text",
        label: t("columnName"),
        sm: 12,
        md: 6,
      },
      ip: {
        type: "text",
        label: t("columnIp"),
        validator: `!!(data.ip && ${IP_RE.toString()}.test(data.ip)) && !${ipList}.includes(data.ip)`,
        validatorErrorText: t("invalidIp"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 6,
      },
    },
  } as unknown as JsonFormSchema;
}

/**
 * A duplicate-IP or invalid-id clash against the other rows, as a ready-to-show message —
 * the backend safety net behind the form validator (the dialog validator may not fire in
 * every admin version; this never lets a bad row through).
 *
 * @param rows the current manual rows
 * @param candidate the row being added/edited
 * @param exceptIndex the row position to ignore (the row being edited), or -1
 * @returns a translated clash message, or null when the row is fine
 */
export function findClash(
  rows: readonly ManualRow[],
  candidate: ManualRow,
  exceptIndex: number,
): ioBroker.StringOrTranslated | null {
  const id = rowId(candidate);
  if (id === "" || RESERVED_IDS.has(id) || !IP_RE.test(candidate.ip)) {
    return t("invalidIp");
  }
  for (let i = 0; i < rows.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (rows[i].ip === candidate.ip || rowId(rows[i]) === id) {
      return t("invalidIp");
    }
  }
  return null;
}

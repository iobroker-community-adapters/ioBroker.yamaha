import type { JsonFormSchema } from "@iobroker/dm-utils";
import { tName } from "./lib/i18n";
import { RESERVED_DEVICE_IDS } from "./lib/device-id";
import { IPV4_RE } from "./lib/network-interfaces";
import { rowDeviceId, type DeviceRow } from "./lib/pure-helpers";

/**
 * A running device as shown on a card. Nothing on it says how the device got into the list — a found card and a typed
 * one are the same card (Y-27); the field that said so was carried and never read (review 2026-10-05, C4).
 */
export interface CardDevice {
  /** The id-safe device id (object-tree path segment). */
  id: string;
  /** The device IP address. */
  ip: string;
  /** The card header name. */
  name: string;
}

/**
 * The add/edit form for one receiver: a display name, the IP address and whether its volume
 * datapoints read 0–100 %. The IP field
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
        label: tName("columnName"),
        sm: 12,
        md: 6,
      },
      ip: {
        type: "text",
        label: tName("columnIp"),
        validator: `!!(data.ip && ${IPV4_RE.toString()}.test(data.ip)) && !${ipList}.includes(data.ip)`,
        validatorErrorText: tName("invalidIp"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 6,
      },
      // Per device, not per instance: the adapter serves several receivers, and one of them
      // wanting percent says nothing about the others. THE place to set it — 2.9.1 also had a
      // switch control on the card itself, and one value reachable from two independently-read
      // places is how the card came to show "off" while this checkbox showed "on".
      volumeAsPercent: {
        newLine: true,
        type: "checkbox",
        label: tName("volumeAsPercent"),
        help: tName("volumeAsPercent_help"),
        sm: 12,
        md: 12,
      },
    },
  } as unknown as JsonFormSchema;
}

/**
 * The addresses the add and the edit dialog refuse: every card's but the edited one's — the table rows AND the found
 * devices. The add dialog listed the table rows only, so a found receiver's address could be typed in as a second card
 * while the edit dialog refused it (review 2026-10-05, E).
 *
 * @param cards the cards as the list shows them
 * @param exceptId the card being edited, if any
 * @returns the addresses that are taken
 */
export function takenAddresses(cards: readonly CardDevice[], exceptId?: string): string[] {
  return cards.filter(card => card.id !== exceptId).map(card => card.ip);
}

/**
 * A duplicate-IP/name or invalid-value clash against the other rows, as a ready-to-show
 * message — the backend safety net behind the form validator (the dialog validator may not
 * fire in every admin version; this never lets a bad row through). Each failure mode gets
 * its own message: a malformed IP is not the same problem as a name that is reserved or
 * already taken — reporting "invalid IP" for a name clash sends the user hunting in the
 * wrong field.
 *
 * @param rows the current manual rows
 * @param candidate the row being added/edited
 * @param exceptIndex the row position to ignore (the row being edited), or -1
 * @param otherIds ids devices outside the table hold (the found ones) — a clash with them too
 * @returns a translated clash message, or null when the row is fine
 */
export function findClash(
  rows: readonly DeviceRow[],
  candidate: DeviceRow,
  exceptIndex: number,
  otherIds: ReadonlySet<string> = new Set(),
): ioBroker.StringOrTranslated | null {
  if (!IPV4_RE.test(candidate.ip)) {
    return tName("invalidIp");
  }
  const id = rowDeviceId(candidate);
  if (id === "" || RESERVED_DEVICE_IDS.has(id)) {
    return tName("invalidName");
  }
  if (otherIds.has(id)) {
    return tName("duplicateDevice");
  }
  for (let i = 0; i < rows.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (rows[i].ip === candidate.ip || rowDeviceId(rows[i]) === id) {
      return tName("duplicateDevice");
    }
  }
  return null;
}

/**
 * The "excluded devices" dialog: one checkbox per excluded device — ticked means "the search may
 * add it again". Labelled with the id and the address it was deleted at, when known.
 *
 * @param entries the excluded devices, id first
 * @returns the jsonConfig panel
 */
export function buildExcludedForm(entries: ReadonlyArray<{ id: string; ip?: string }>): JsonFormSchema {
  const items: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    items[entry.id] = {
      type: "checkbox",
      label: entry.ip ? `${entry.id} (${entry.ip})` : entry.id,
      ...(index === 0 ? { help: tName("dmExcludedHelp") } : {}),
      sm: 12,
    };
  });
  return { type: "panel", items } as unknown as JsonFormSchema;
}

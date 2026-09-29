import { tName, type I18nKey } from "../i18n";
import type { StateValue } from "../types";
import type { ObjectDef } from "./types";

/**
 * A device list as datapoints: one channel per slot, one datapoint per field — beside the JSON
 * state the list also has. A Blockly user reads "favourite 3 is called …" or "is 192.168.1.20 in the
 * group?" as a value, never by parsing JSON (fleet rule 2026-09-28: a JSON list only IN ADDITION to
 * single datapoints; audit 2026-09-29, C30). Every slot always carries every field — an empty slot
 * reads "" / 0 — so a slot that empties is cleared instead of keeping its old entry.
 */

/** One field of a slot. */
export interface SlotField {
  /** The field's id segment below the slot channel. */
  key: string;
  /** Its name. */
  nameKey: I18nKey;
  /** Its explanation. */
  descKey: I18nKey;
  /** The value type. */
  type: "string" | "number";
  /** The ioBroker role. */
  role: string;
  /** The unit, where the field has one. */
  unit?: string;
}

/**
 * The objects of a slot list: the folder, a channel per slot (`<folder>.<n>`), a state per field.
 *
 * @param folder the list's folder id (`player.netPlayer.favourites`)
 * @param folderName the folder's name
 * @param count how many slots
 * @param fields the fields of a slot
 * @param folderDesc the folder's explanation
 * @param folderArg the value of the folder name's placeholder, when it has one
 * @returns the objects, parents before children
 */
export function slotListObjects(
  folder: string,
  folderName: I18nKey,
  count: number,
  fields: readonly SlotField[],
  folderDesc?: I18nKey,
  folderArg?: string,
): ObjectDef[] {
  const objects: ObjectDef[] = [
    {
      id: folder,
      type: "channel",
      common: {
        name: folderArg !== undefined ? tName(folderName, folderArg) : tName(folderName),
        ...(folderDesc ? { desc: tName(folderDesc) } : {}),
      },
    },
  ];
  for (let n = 1; n <= count; n++) {
    objects.push({ id: `${folder}.${n}`, type: "channel", common: { name: tName("slotNumber", n) } });
    for (const field of fields) {
      objects.push({
        id: `${folder}.${n}.${field.key}`,
        type: "state",
        common: {
          name: tName(field.nameKey),
          desc: tName(field.descKey),
          type: field.type,
          role: field.role,
          read: true,
          write: false,
          ...(field.unit ? { unit: field.unit } : {}),
        },
      });
    }
  }
  return objects;
}

/**
 * The values of a slot list: every field of every slot — an entry's value where the slot holds
 * one, "" / 0 where it is empty or the entry lacks the field.
 *
 * @param folder the list's folder id
 * @param count how many slots
 * @param fields the fields of a slot
 * @param entries the entries by slot (index 0 = slot 1); undefined = an empty slot
 * @returns the state values
 */
export function slotListValues(
  folder: string,
  count: number,
  fields: readonly SlotField[],
  entries: ReadonlyArray<Readonly<Record<string, string | number>> | undefined>,
): StateValue[] {
  const values: StateValue[] = [];
  for (let n = 1; n <= count; n++) {
    const entry = entries[n - 1];
    for (const field of fields) {
      const raw = entry?.[field.key];
      const value = typeof raw === field.type ? raw! : field.type === "number" ? 0 : "";
      values.push({ id: `${folder}.${n}.${field.key}`, value });
    }
  }
  return values;
}

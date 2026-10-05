import type { CatalogEntry } from "./types";

/**
 * The device's model and firmware as datapoints — ONE definition for every transport.
 *
 * YNCA built `info.model` and `info.firmware` from its catalog (MODELNAME, VERSION); MusicCast and XML reported
 * the model too but built no object for it, so the transport adapter dropped the value: every device without
 * YNCA showed an empty model and no firmware, and the device card, the device icon and the remembered model
 * stayed blank (review 2026-10-05, A5). Every transport that reads the two values builds them from these entries,
 * so the form is the same whichever protocol serves them, and the coordinator picks one owner.
 */
export const INFO_ENTRIES: readonly CatalogEntry[] = [
  { id: "info.model", nameKey: "model", spec: { kind: "text" }, write: false, role: "text" },
  { id: "info.firmware", nameKey: "firmwareVersion", spec: { kind: "text" }, write: false, role: "text" },
];

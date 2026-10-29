import { tJoin, tName } from "../i18n";
import { CHANNEL_NAME_KEYS } from "./types";
import { zonedName } from "./zones";

/** A source's own preset datapoints (`player.<source>.preset`/`.presetSave`) — the same function on every source. */
const SOURCE_PRESET = /^player\.([^.]+)\.(?:preset|presetSave)$/;

/**
 * The name a datapoint is written with: the name its transport built, with what tells it apart from a namesake on the
 * same device in front (rule D19 of the fleet: two datapoints of one device never share a name, in any language;
 * krobi 2026-10-29). A zone's datapoint names its zone ("Zone 2 Mute"), a source's preset datapoint its source
 * ("Net radio: Recall preset"). Applied where every definition is written, so all three protocols name alike (Y-29);
 * the id never changes.
 *
 * @param stateId the state id relative to the device
 * @param name the name the transport built
 * @returns the name to write
 */
export function qualifiedName(stateId: string, name: ioBroker.StringOrTranslated): ioBroker.StringOrTranslated {
  const source = SOURCE_PRESET.exec(stateId)?.[1];
  if (source !== undefined && Object.hasOwn(CHANNEL_NAME_KEYS, source)) {
    return tJoin([tName(CHANNEL_NAME_KEYS[source]), name], ([label, text]) => `${label}: ${text}`);
  }
  return zonedName(stateId, name);
}

import { specToCommon } from "./value-coerce";
import { CHANNEL_NAME_KEYS, type CatalogEntry, type ObjectDef } from "./types";
import { tName } from "../i18n";

/**
 * Capitalise the first character, as the fallback channel name for a channel id
 * not in {@link CHANNEL_NAME_KEYS}.
 *
 * @param segment the channel id segment
 * @returns the segment with its first character upper-cased
 */
function capitalize(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * Turn catalog entries into the object tree: a channel object for every dotted
 * parent path (created once, before its states) and a typed state object per
 * entry. The caller passes only the entries the device actually reports, so the
 * tree is device-specific while the catalog stays device-agnostic.
 *
 * @param entries the catalog entries that apply to the device
 * @returns the object definitions to create, parents before children
 */
export function catalogToObjects(entries: CatalogEntry[]): ObjectDef[] {
  const objects: ObjectDef[] = [];
  const channels = new Set<string>();
  for (const entry of entries) {
    const segments = entry.id.split(".");
    for (let i = 1; i < segments.length; i++) {
      const channelId = segments.slice(0, i).join(".");
      if (!channels.has(channelId)) {
        channels.add(channelId);
        const segment = segments[i - 1];
        objects.push({
          id: channelId,
          type: "channel",
          // A listed channel is translated; an unlisted one keeps its capitalised id, which is
          // a device-derived name and therefore has no translation to give.
          common: { name: CHANNEL_NAME_KEYS[segment] ? tName(CHANNEL_NAME_KEYS[segment]) : capitalize(segment) },
        });
      }
    }
    const common = specToCommon(entry.spec, { write: entry.write, role: entry.role });
    objects.push({
      id: entry.id,
      type: "state",
      common: { name: tName(entry.nameKey, ...(entry.nameArgs ?? [])), ...common },
    });
  }
  return objects;
}

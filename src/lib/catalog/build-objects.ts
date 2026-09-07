import { specToCommon } from "./value-coerce";
import { channelCommon, type CatalogEntry, type ObjectDef } from "./types";
import { tName } from "../i18n";

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
          common: channelCommon(segment),
        });
      }
    }
    const common = specToCommon(entry.spec, { write: entry.write, role: entry.role });
    objects.push({
      id: entry.id,
      type: "state",
      common: {
        name: tName(entry.nameKey, ...(entry.nameArgs ?? [])),
        // Only written when the catalog carries one. An absent key means "explains itself" —
        // the fleet standard wants the field empty there, not filled with invented prose.
        ...(entry.descKey ? { desc: tName(entry.descKey) } : {}),
        ...common,
      },
    });
  }
  return objects;
}

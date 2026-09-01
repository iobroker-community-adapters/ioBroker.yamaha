import type { ProbeMemory } from "../lifecycle/probe-memory";
import { parseSceneList } from "../xml/protocol";

/**
 * Scene titles, cross-transport. The device reports its scene titles over XML
 * (`Scene_Sel_Item`, per zone) and/or YNCA (`SCENExNAME`, main zone) — while the
 * scene RECALL may be owned by a third transport (MusicCast). Both title sources
 * land in the shared per-device probe memory, so every controller can resolve a
 * written title to its number and render the one `scene.list` state, regardless
 * of which transport owns the write.
 */

/** One scene for the `scene.list` JSON state. */
export interface SceneListEntry {
  /** The 1-based scene number (the recall value). */
  num: number;
  /** The scene's title as the device reports it. */
  title: string;
}

/** The probe-memory shape of the YNCA static values (see device-controller STATIC_KEY). */
type YncaStatics = Record<string, Record<string, string>>;

/**
 * The known scenes of a zone, from whichever transport reported titles: the XML
 * declaration first (per zone), the YNCA scene names as the fallback (main only).
 *
 * @param memory the device's shared probe memory
 * @param zoneKey the zone (`main`, `zone2`, …)
 * @returns the scenes with titles, empty when no transport reported any
 */
export function knownScenes(memory: ProbeMemory | undefined, zoneKey: string): SceneListEntry[] {
  if (!memory) {
    return [];
  }
  const xml = memory.remembered<string>(`xmlScenes:${zoneKey}`);
  if (typeof xml === "string" && xml.length > 0) {
    // Parsed lazily from the remembered raw declaration — ONE stored form, one parser.
    const scenes = parseSceneList(xml);
    if (scenes.length > 0) {
      return scenes;
    }
  }
  if (zoneKey === "main") {
    const statics = memory.remembered<YncaStatics>("yncaStaticValues");
    const main = statics?.MAIN ?? {};
    const scenes: SceneListEntry[] = [];
    for (let n = 1; n <= 12; n++) {
      const title = main[`SCENE${n}NAME`];
      if (typeof title === "string" && title.length > 0) {
        scenes.push({ num: n, title });
      }
    }
    return scenes;
  }
  return [];
}

/**
 * Resolve a scene-recall write to its number: a number (or numeric string) passes
 * through, a TITLE is looked up case-insensitively in the zone's known scenes —
 * so `scene.recall = "Movie Viewing"` works wherever the device reported titles
 * (the govee dual-write pattern).
 *
 * @param value the written value
 * @param memory the device's shared probe memory
 * @param zoneKey the zone (`main`, `zone2`, …)
 * @returns the scene number, or undefined when unresolvable
 */
export function resolveSceneNumber(
  value: unknown,
  memory: ProbeMemory | undefined,
  zoneKey: string,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const needle = trimmed.toLowerCase();
  const match = knownScenes(memory, zoneKey).find(scene => scene.title.toLowerCase() === needle);
  return match?.num;
}

/**
 * The dropdown label map for a zone's scene recall (number → title), or undefined
 * when no transport reported titles.
 *
 * @param memory the device's shared probe memory
 * @param zoneKey the zone
 * @returns the states map, or undefined
 */
export function sceneStatesMap(memory: ProbeMemory | undefined, zoneKey: string): Record<string, string> | undefined {
  const scenes = knownScenes(memory, zoneKey);
  if (scenes.length === 0) {
    return undefined;
  }
  return Object.fromEntries(scenes.map(scene => [scene.num, scene.title]));
}

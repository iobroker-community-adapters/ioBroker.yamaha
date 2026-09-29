import type { ProbeMemory } from "../lifecycle/probe-memory";
import { parseSceneList } from "../xml/protocol";
import { tName } from "../i18n";
import type { ObjectDef } from "./types";

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

/** The probe-memory key the YNCA controller keeps its never-changing answers under (input and scene names). */
export const YNCA_STATIC_KEY = "yncaStaticValues";

/** The probe-memory shape of the YNCA static values: subunit → function → answer. */
type YncaStatics = Record<string, Record<string, string>>;

/** The YNCA subunit of each zone key. */
const YNCA_ZONE_SUBUNITS: Readonly<Record<string, string>> = {
  main: "MAIN",
  zone2: "ZONE2",
  zone3: "ZONE3",
  zone4: "ZONE4",
};

/**
 * The scenes a YNCA zone declares, read from its `SCENExNAME` answers: MAIN up to twelve, a zone
 * four (official lists). The one reader for the YNCA controller and for {@link knownScenes}.
 *
 * @param answers the zone subunit's function → answer map
 * @param subunit the zone subunit (MAIN, ZONE2 …)
 * @returns the declared scenes, lowest number first
 */
export function yncaSceneTitles(answers: Record<string, string> | undefined, subunit: string): SceneListEntry[] {
  const scenes: SceneListEntry[] = [];
  for (let n = 1; n <= (subunit === "MAIN" ? 12 : 4); n++) {
    const title = answers?.[`SCENE${n}NAME`];
    if (typeof title === "string" && title.length > 0) {
      scenes.push({ num: n, title });
    }
  }
  return scenes;
}

/**
 * The known scenes of a zone, from whichever transport reported titles: the XML
 * declaration first (per zone), the YNCA scene names as the fallback — the main zone's twelve and
 * each zone's four (`ZONE2:SCENE1NAME` …), so a MusicCast-owned zone recall resolves a title only
 * YNCA knows (audit 2026-09-29, B16).
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
  const subunit = YNCA_ZONE_SUBUNITS[zoneKey];
  if (subunit === undefined) {
    return [];
  }
  return yncaSceneTitles(memory.remembered<YncaStatics>(YNCA_STATIC_KEY)?.[subunit], subunit);
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
 * The scene list of one scene channel as datapoints: the JSON list (for widgets that render every
 * scene at once) and, beside it, one title datapoint per scene — a Blockly user reads "scene 3 is
 * called …" as a value, never by parsing JSON (fleet rule 2026-09-28; audit 2026-09-29, D8). Shared
 * by all three transports, so the ids and texts cannot drift between them.
 *
 * @param channel the scene channel id (`scene`, `multiroom.zone2.scene`)
 * @param scenes the scenes the channel declares
 * @returns the objects to create (the list, then `title<N>` per scene) and their values
 */
export function sceneListSurface(
  channel: string,
  scenes: readonly SceneListEntry[],
): { objects: ObjectDef[]; values: Array<{ id: string; value: string }> } {
  const objects: ObjectDef[] = [
    {
      id: `${channel}.list`,
      type: "state",
      common: {
        name: tName("scenesNumberTitle"),
        desc: tName("descScenesNumberTitle"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    },
  ];
  const values = [{ id: `${channel}.list`, value: JSON.stringify(scenes) }];
  for (const scene of scenes) {
    objects.push({
      id: `${channel}.title${scene.num}`,
      type: "state",
      common: {
        name: tName("sceneTitleNumber", scene.num),
        desc: tName("descSceneTitleNumber"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    values.push({ id: `${channel}.title${scene.num}`, value: scene.title });
  }
  return { objects, values };
}

import type { StateValue } from "../types";
import type { BasicStatus } from "./protocol";
import { isWritableValue } from "../catalog/value-coerce";
import { XML_AMP_CATALOG } from "./catalog";

/** A zone-scoped XML command: the zone element and the inner command XML. */
export interface XmlCommand {
  /** The zone element (e.g. `Main_Zone`, `Zone_2`). */
  zone: string;
  /** The inner command XML to wrap in a PUT envelope. */
  inner: string;
}

const ZONE_ELEMENT: Record<string, string> = { main: "Main_Zone", zone2: "Zone_2", zone3: "Zone_3", zone4: "Zone_4" };
const ZONE_PREFIX: Record<string, string> = { main: "", zone2: "zone2.", zone3: "zone3.", zone4: "zone4." };

/**
 * Map a unified state write to a zone-scoped XML command, via {@link XML_AMP_CATALOG}.
 *
 * @param stateId the state id (e.g. `power`, `zone2.volume`)
 * @param value the value written to the state
 * @returns the XML command, or undefined if the state or its zone is not mapped
 */
export function stateToXml(stateId: string, value: unknown): XmlCommand | undefined {
  let zoneKey = "main";
  let name = stateId;
  const dot = stateId.indexOf(".");
  // Only split on a known zone prefix — a dotted state like `scene.recall` is a
  // main-zone state, not a state under a "scene" zone.
  if (dot > 0 && ZONE_ELEMENT[stateId.slice(0, dot)]) {
    zoneKey = stateId.slice(0, dot);
    name = stateId.slice(dot + 1);
  }
  const entry = XML_AMP_CATALOG.find(e => e.state === name);
  if (
    !entry?.toInner ||
    (entry.mainOnly && zoneKey !== "main") ||
    !isWritableValue(value, entry.common.type === "number")
  ) {
    return undefined;
  }
  // HDMI outputs and party are written on the System element, not the zone.
  const zone = entry.writeZone ?? ZONE_ELEMENT[zoneKey];
  if (!zone) {
    return undefined;
  }
  return { zone, inner: entry.toInner(value) };
}

/**
 * Turn a parsed Basic_Status into unified state updates for a zone. Only fields
 * the status carries are emitted (presence-checked so a `mute: false` is kept).
 *
 * @param status the parsed Basic_Status
 * @param zone the zone the status belongs to (`main`, `zone2`, …)
 * @returns the state updates, empty if the zone is unknown
 */
export function parseXmlStatus(status: BasicStatus, zone: string): StateValue[] {
  const prefix = ZONE_PREFIX[zone];
  if (prefix === undefined) {
    return [];
  }
  const updates: StateValue[] = [];
  for (const entry of XML_AMP_CATALOG) {
    const value = entry.statusField ? status[entry.statusField] : undefined;
    if (value !== undefined) {
      updates.push({ id: `${prefix}${entry.state}`, value });
    }
  }
  return updates;
}

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
  if (dot > 0) {
    zoneKey = stateId.slice(0, dot);
    name = stateId.slice(dot + 1);
  }
  const zone = ZONE_ELEMENT[zoneKey];
  const entry = XML_AMP_CATALOG.find(e => e.state === name);
  if (!zone || !entry?.toInner || !isWritableValue(value, entry.common.type === "number")) {
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
    const value = status[entry.statusField];
    if (value !== undefined) {
      updates.push({ id: `${prefix}${entry.state}`, value });
    }
  }
  return updates;
}

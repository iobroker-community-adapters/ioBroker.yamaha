import type { StateValue } from "../types";
import type { BasicStatus, XmlDialect, XmlZoneForm } from "./protocol";
import { coerceBool, isWritableValue } from "../catalog/value-coerce";
import { XML_AMP_CATALOG } from "./catalog";
import { xmlZone } from "./zones";
import { splitZone } from "../catalog/zones";

/** A zone-scoped XML command: the zone element and the inner command XML. */
export interface XmlCommand {
  /** The zone element (e.g. `Main_Zone`, `Zone_2`). */
  zone: string;
  /** The inner command XML to wrap in a PUT envelope. */
  inner: string;
}

/**
 * Map a unified state write to a zone-scoped XML command, via {@link XML_AMP_CATALOG}.
 *
 * @param stateId the state id (e.g. `power`, `zone2.volume`)
 * @param value the value written to the state
 * @param dialect the spelling this device answers its status with (see {@link XmlDialect});
 *   absent = classic
 * @param form the zone's command form where it differs from the main zone's (see {@link XmlZoneForm})
 * @returns the XML command, or undefined if the state or its zone is not mapped
 */
export function stateToXml(
  stateId: string,
  value: unknown,
  dialect?: XmlDialect,
  form?: XmlZoneForm,
): XmlCommand | undefined {
  const { zone: zoneKey, name } = splitZone(stateId);
  const entry = XML_AMP_CATALOG.find(e => e.state === name);
  if (
    !entry?.toInner ||
    (entry.mainOnly && zoneKey !== "main") ||
    (entry.zonesOnly && zoneKey === "main") ||
    !isWritableValue(value, entry.common.type === "number")
  ) {
    return undefined;
  }
  // HDMI outputs and party are written on the System element, not the zone.
  const zone = entry.writeZone ?? xmlZone(zoneKey)?.element;
  if (!zone) {
    return undefined;
  }
  // A switch reads the words a script writes ("false", "off", "0") for what they mean — the
  // entry's truthiness test would send every non-empty string as On.
  const input = entry.common.type === "boolean" ? coerceBool(value) : value;
  if (input === undefined) {
    return undefined;
  }
  return { zone, inner: entry.toInner(input, dialect, form, form?.steps?.[entry.state] ?? entry.common.step) };
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
  const prefix = xmlZone(zone)?.prefix;
  if (prefix === undefined) {
    return [];
  }
  const updates: StateValue[] = [];
  for (const entry of XML_AMP_CATALOG) {
    if ((entry.mainOnly && zone !== "main") || (entry.zonesOnly && zone === "main")) {
      continue;
    }
    const value = entry.statusField ? status[entry.statusField] : undefined;
    if (value !== undefined) {
      updates.push({ id: `${prefix}${entry.state}`, value });
    }
  }
  return updates;
}

import type { StateValue } from "../types";
import type { BasicStatus } from "./protocol";

/** A zone-scoped XML command: the zone element and the inner command XML. */
export interface XmlCommand {
  /** The zone element (e.g. `Main_Zone`, `Zone_2`). */
  zone: string;
  /** The inner command XML to wrap in a PUT envelope. */
  inner: string;
}

interface XmlStateMapping {
  /** Build the inner command XML for a written value. */
  toInner: (value: unknown) => string;
  /** The Basic_Status field this state reads from. */
  statusField: keyof BasicStatus;
}

/** Unified state name → inner-XML builder and the Basic_Status field it reads. */
const XML_STATE_MAPPINGS: Record<string, XmlStateMapping> = {
  power: {
    toInner: value => `<Power_Control><Power>${value ? "On" : "Standby"}</Power></Power_Control>`,
    statusField: "power",
  },
  volume: {
    toInner: value =>
      `<Volume><Lvl><Val>${Math.round(Number(value) * 10)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Volume>`,
    statusField: "volume",
  },
  mute: { toInner: value => `<Volume><Mute>${value ? "On" : "Off"}</Mute></Volume>`, statusField: "mute" },
  input: { toInner: value => `<Input><Input_Sel>${String(value)}</Input_Sel></Input>`, statusField: "input" },
};

const ZONE_ELEMENT: Record<string, string> = { main: "Main_Zone", zone2: "Zone_2", zone3: "Zone_3", zone4: "Zone_4" };
const ZONE_PREFIX: Record<string, string> = { main: "", zone2: "zone2.", zone3: "zone3.", zone4: "zone4." };

/**
 * Map a unified state write to a zone-scoped XML command.
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
  const mapping = XML_STATE_MAPPINGS[name];
  if (!zone || !mapping) {
    return undefined;
  }
  return { zone, inner: mapping.toInner(value) };
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
  for (const [name, mapping] of Object.entries(XML_STATE_MAPPINGS)) {
    const value = status[mapping.statusField];
    if (value !== undefined) {
      updates.push({ id: `${prefix}${name}`, value });
    }
  }
  return updates;
}

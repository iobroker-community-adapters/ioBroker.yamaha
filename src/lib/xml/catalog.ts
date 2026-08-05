import type { ObjectDef } from "../catalog/types";
import type { BasicStatus } from "./protocol";

/**
 * The single source for XML/YNC amplifier states: one entry per unified state
 * carries BOTH its ioBroker object (`common`) AND its Basic_Status read field +
 * PUT-XML builder — replacing the former `XML_AMP_STATES` (device-controller) /
 * `XML_STATE_MAPPINGS` (command-mapper) pair kept in sync by hand. The controller
 * reads `common`, the command-mapper reads `statusField`/`toInner`.
 */
export interface XmlAmpEntry {
  /** Unified state id, relative to the zone prefix. */
  state: string;
  /** ioBroker common for the object. */
  common: ObjectDef["common"];
  /** The Basic_Status field this state reads from. */
  statusField: keyof BasicStatus;
  /** Build the inner PUT XML for a written value; absent means read-only. */
  toInner?: (value: unknown) => string;
}

/** The unified XML amplifier catalog — object + read field + PUT builder in one list. */
export const XML_AMP_CATALOG: XmlAmpEntry[] = [
  {
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
    statusField: "power",
    toInner: value => `<Power_Control><Power>${value ? "On" : "Standby"}</Power></Power_Control>`,
  },
  {
    state: "volume",
    common: {
      name: "Volume",
      type: "number",
      role: "level.volume",
      read: true,
      write: true,
      unit: "dB",
      min: -80.5,
      max: 16.5,
      step: 0.5,
    },
    statusField: "volume",
    toInner: value =>
      `<Volume><Lvl><Val>${Math.round(Number(value) * 10)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Volume>`,
  },
  {
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true },
    statusField: "mute",
    toInner: value => `<Volume><Mute>${value ? "On" : "Off"}</Mute></Volume>`,
  },
  {
    state: "input",
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true },
    statusField: "input",
    toInner: value => `<Input><Input_Sel>${String(value)}</Input_Sel></Input>`,
  },
  {
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true },
    statusField: "soundProgram",
    toInner: value =>
      `<Surround><Program_Sel><Current><Sound_Program>${String(value)}</Sound_Program></Current></Program_Sel></Surround>`,
  },
  {
    state: "pureDirect",
    common: { name: "Pure Direct", type: "boolean", role: "switch", read: true, write: true },
    statusField: "pureDirect",
    toInner: value => `<Sound_Video><Pure_Direct><Mode>${value ? "On" : "Off"}</Mode></Pure_Direct></Sound_Video>`,
  },
  {
    state: "straight",
    common: { name: "Straight", type: "boolean", role: "switch", read: true, write: true },
    statusField: "straight",
    toInner: value =>
      `<Surround><Program_Sel><Current><Straight>${value ? "On" : "Off"}</Straight></Current></Program_Sel></Surround>`,
  },
  {
    state: "direct",
    common: { name: "Direct", type: "boolean", role: "switch", read: true, write: true },
    statusField: "direct",
    toInner: value => `<Sound_Video><Direct><Mode>${value ? "On" : "Off"}</Mode></Direct></Sound_Video>`,
  },
  {
    state: "adaptiveDrc",
    common: { name: "Adaptive DRC", type: "string", role: "state", read: true, write: true },
    statusField: "adaptiveDrc",
    toInner: value => `<Sound_Video><Adaptive_DRC>${String(value)}</Adaptive_DRC></Sound_Video>`,
  },
  {
    // Read-only: openHAB reads the Dialogue_Lvl path, but the write value structure
    // (Val/Exp/Unit vs bare) is not confirmed by a reference, so no write is offered.
    state: "dialogueLevel",
    common: { name: "Dialogue level", type: "number", role: "level", read: true, write: false },
    statusField: "dialogueLevel",
  },
  {
    state: "sleep",
    common: { name: "Sleep timer", type: "string", role: "state", read: true, write: true },
    statusField: "sleep",
    toInner: value => `<Power_Control><Sleep>${String(value)}</Sleep></Power_Control>`,
  },
];

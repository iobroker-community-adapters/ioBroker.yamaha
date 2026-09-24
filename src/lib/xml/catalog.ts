import type { ObjectDef } from "../catalog/types";
import type { I18nKey } from "../i18n";
import { escapeXmlText } from "./entities";
import type { BasicStatus, XmlDialect, XmlZoneForm } from "./protocol";

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
  /**
   * ioBroker common for the object, carrying its name as a translation KEY: this catalog is a
   * module-level constant, so the controller resolves the key when it creates the object.
   */
  common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey; descKey?: I18nKey };
  /** The Basic_Status field this state reads from; absent for a write-only command (e.g. scene recall). */
  statusField?: Exclude<keyof BasicStatus, "zoneForm">;
  /**
   * Build the inner PUT XML for a written value; absent means read-only. The dialect is the
   * spelling THIS device answered its status with (see {@link XmlDialect}); an entry whose
   * element differs between the generations builds the device's own.
   */
  toInner?: (value: unknown, dialect?: XmlDialect, form?: XmlZoneForm) => string;
  /** Only exists on the main zone (a system/main-wide feature like scenes, HDMI outputs, party). */
  mainOnly?: boolean;
  /** Only exists on zones 2–4 (the pre-out level mode). */
  zonesOnly?: boolean;
  /** Override the write target element (e.g. `System` for HDMI outputs and party); default is the zone element. */
  writeZone?: string;
  /**
   * The desc.xml command paths whose declared range this state takes, per zone (see
   * `descriptorRanges`); the `common` bounds are the fallback where none is declared (D16).
   */
  rangePaths?: string[];
}

/** The unified XML amplifier catalog — object + read field + PUT builder in one list. */
/**
 * A written level in the XML wire form (tenths of a dB), snapped to the 0.5 dB grid every `desc.xml`
 * declares for it (`Range -805,165,5` and `-60,60,5`, 2008–2017). `Math.round(v * 10)` alone put a
 * written −30.3 on the wire as −303, off the grid, while the same datapoint owned by YNCA snapped
 * (audit 2026-09-24, D10; rxv quantises the same way).
 *
 * @param value the written value (already checked to be a number)
 * @param step the declared step in dB
 * @returns the wire value in tenths
 */
export function xmlTenths(value: unknown, step: number): number {
  return Math.round(Math.round(Number(value) / step) * step * 10);
}

/**
 * A tone write in the zone's own form (see {@link XmlZoneForm}).
 *
 * @param band `Bass` or `Treble`
 * @param body the level envelope
 * @param form the zone's command form
 * @returns the inner XML
 */
function toneInner(band: "Bass" | "Treble", body: string, form: XmlZoneForm | undefined): string {
  const level = `<${band}>${body}</${band}>`;
  return `<Sound_Video><Tone>${form?.toneManual ? `<Manual>${level}</Manual>` : level}</Tone></Sound_Video>`;
}

export const XML_AMP_CATALOG: XmlAmpEntry[] = [
  {
    state: "power",
    common: { nameKey: "power", type: "boolean", role: "switch.power", read: true, write: true },
    statusField: "power",
    toInner: value => `<Power_Control><Power>${value ? "On" : "Standby"}</Power></Power_Control>`,
  },
  {
    state: "volume",
    common: {
      nameKey: "volume",
      descKey: "descVolume",
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
    rangePaths: ["Volume,Lvl", "Vol,Lvl"],
    toInner: (value: unknown, dialect?: XmlDialect, form?: XmlZoneForm): string => {
      const element = dialect === "legacy" ? "Vol" : "Volume";
      return `<${element}><Lvl><Val>${xmlTenths(value, form?.steps?.volume ?? 0.5)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></${element}>`;
    },
  },
  {
    state: "mute",
    common: { nameKey: "mute", type: "boolean", role: "media.mute", read: true, write: true },
    statusField: "mute",
    toInner: (value: unknown, dialect?: XmlDialect): string => {
      const element = dialect === "legacy" ? "Vol" : "Volume";
      return `<${element}><Mute>${value ? "On" : "Off"}</Mute></${element}>`;
    },
  },
  {
    state: "input",
    common: { nameKey: "input", type: "string", role: "media.input", read: true, write: true },
    statusField: "input",
    toInner: value => `<Input><Input_Sel>${escapeXmlText(value)}</Input_Sel></Input>`,
  },
  {
    state: "soundProgram",
    common: {
      nameKey: "soundProgram",
      descKey: "descSoundProgram",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    statusField: "soundProgram",
    toInner: (value, dialect) =>
      dialect === "legacy"
        ? `<Surr><Pgm_Sel><Pgm>${escapeXmlText(value)}</Pgm></Pgm_Sel></Surr>`
        : `<Surround><Program_Sel><Current><Sound_Program>${escapeXmlText(value)}</Sound_Program></Current></Program_Sel></Surround>`,
  },
  {
    state: "sound.pureDirect",
    common: {
      nameKey: "pureDirect",
      descKey: "descPureDirect",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "pureDirect",
    toInner: value => `<Sound_Video><Pure_Direct><Mode>${value ? "On" : "Off"}</Mode></Pure_Direct></Sound_Video>`,
  },
  {
    state: "sound.straight",
    common: { nameKey: "straight", descKey: "descStraight", type: "boolean", role: "switch", read: true, write: true },
    statusField: "straight",
    toInner: (value, dialect) =>
      dialect === "legacy"
        ? `<Surr><Pgm_Sel><Straight>${value ? "On" : "Off"}</Straight></Pgm_Sel></Surr>`
        : `<Surround><Program_Sel><Current><Straight>${value ? "On" : "Off"}</Straight></Current></Program_Sel></Surround>`,
  },
  {
    state: "sound.direct",
    common: { nameKey: "direct", descKey: "descDirect", type: "boolean", role: "switch", read: true, write: true },
    statusField: "direct",
    toInner: value => `<Sound_Video><Direct><Mode>${value ? "On" : "Off"}</Mode></Direct></Sound_Video>`,
  },
  {
    state: "sound.adaptiveDrc",
    common: {
      nameKey: "adaptiveDRC",
      descKey: "descAdaptiveDRC",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    statusField: "adaptiveDrc",
    toInner: value => `<Sound_Video><Adaptive_DRC>${escapeXmlText(value)}</Adaptive_DRC></Sound_Video>`,
  },
  {
    // Writable where desc.xml declares `Sound_Video,Dialogue_Adjust,Dialogue_Lvl` for the zone
    // (`Put_2`, a bare number in `Range 0,3,1` — HTR-4069, RX-A2060, RX-V675, RX-V775, TSR-5810); the
    // controller opens the write there and only there (audit 2026-09-24, D19). Read-only elsewhere.
    state: "sound.dialogueLevel",
    common: {
      nameKey: "dialogueLevel",
      descKey: "descDialogueLevel",
      type: "number",
      role: "value",
      read: true,
      write: false,
    },
    statusField: "dialogueLevel",
    toInner: value =>
      `<Sound_Video><Dialogue_Adjust><Dialogue_Lvl>${Math.round(Number(value))}</Dialogue_Lvl></Dialogue_Adjust></Sound_Video>`,
  },
  {
    state: "sleep",
    common: {
      nameKey: "sleepTimer",
      descKey: "descSleepTimer",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    statusField: "sleep",
    toInner: value => `<Power_Control><Sleep>${escapeXmlText(value)}</Sleep></Power_Control>`,
  },
  // Tone, subwoofer trim and the Extra-Bass/YPAO toggles — exposed by the predecessor
  // adapter (yamaha-nodejs-soef) on real pre-2010 devices, and dropped in the rewrite.
  // Values verified against that library's PUT paths (audit findings F3/F4).
  // Tone/subwoofer values are real decibels on the state; the wire carries tenths with
  // Exp=1 (the same Val/Exp/Unit envelope as the volume above): *10 out, /10 on read.
  {
    state: "sound.bass",
    common: {
      nameKey: "bass",
      descKey: "descBass",
      type: "number",
      role: "level",
      read: true,
      write: true,
      unit: "dB",
      min: -6,
      max: 6,
      step: 0.5,
    },
    statusField: "bass",
    rangePaths: ["Sound_Video,Tone,Bass", "Sound_Video,Tone,Manual,Bass"],
    // Under `Tone,Manual` where the zone uses that form (RX-A2060 zones 2/3, the 2020 generation — D6).
    toInner: (value, _dialect, form) =>
      toneInner(
        "Bass",
        `<Val>${xmlTenths(value, form?.steps?.["sound.bass"] ?? 0.5)}</Val><Exp>1</Exp><Unit>dB</Unit>`,
        form,
      ),
  },
  {
    state: "sound.treble",
    common: {
      nameKey: "treble",
      descKey: "descTreble",
      type: "number",
      role: "level",
      read: true,
      write: true,
      unit: "dB",
      min: -6,
      max: 6,
      step: 0.5,
    },
    statusField: "treble",
    rangePaths: ["Sound_Video,Tone,Treble", "Sound_Video,Tone,Manual,Treble"],
    toInner: (value, _dialect, form) =>
      toneInner(
        "Treble",
        `<Val>${xmlTenths(value, form?.steps?.["sound.treble"] ?? 0.5)}</Val><Exp>1</Exp><Unit>dB</Unit>`,
        form,
      ),
  },
  {
    state: "sound.subwooferTrim",
    common: {
      nameKey: "subwooferTrim",
      descKey: "descSubwooferTrim",
      type: "number",
      role: "level",
      read: true,
      write: true,
      unit: "dB",
      min: -6,
      max: 6,
      step: 0.5,
    },
    statusField: "subwooferTrim",
    rangePaths: ["Volume,Subwoofer_Trim"],
    toInner: (value, _dialect, form) =>
      `<Volume><Subwoofer_Trim><Val>${xmlTenths(value, form?.steps?.["sound.subwooferTrim"] ?? 0.5)}</Val><Exp>1</Exp><Unit>dB</Unit></Subwoofer_Trim></Volume>`,
  },
  {
    state: "sound.extraBass",
    common: {
      nameKey: "extraBass",
      descKey: "descExtraBass",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "extraBass",
    toInner: value => `<Sound_Video><Extra_Bass>${value ? "Auto" : "Off"}</Extra_Bass></Sound_Video>`,
  },
  {
    state: "sound.ypaoVolume",
    common: {
      nameKey: "ypaoVolume",
      descKey: "descYpaoVolume",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "ypaoVolume",
    toInner: value => `<Sound_Video><YPAO_Volume>${value ? "Auto" : "Off"}</YPAO_Volume></Sound_Video>`,
  },
  {
    state: "sound.dialogueLift",
    common: {
      nameKey: "dialogueLift",
      descKey: "descDialogueLift",
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
      max: 5,
      step: 1,
    },
    statusField: "dialogueLift",
    toInner: value =>
      `<Sound_Video><Dialogue_Adjust><Dialogue_Lift>${Math.round(Number(value))}</Dialogue_Lift></Dialogue_Adjust></Sound_Video>`,
  },
  // The zone commands desc.xml declares and Basic_Status reports on the 2012–2017 generation
  // (coverage audit 2026-09-09): the enhancer and CINEMA DSP 3D (9 of 10 descriptors), the
  // speaker terminals A/B and Zone B (HTR-4069 class), the pre-out level mode of zones 2–4.
  // Same ids as the YNCA entries, so one datapoint serves both transports.
  {
    state: "sound.enhancer",
    common: { nameKey: "enhancer", descKey: "descEnhancer", type: "boolean", role: "switch", read: true, write: true },
    statusField: "enhancer",
    // Under `Surround,Current` where the zone uses that form (D6).
    toInner: (value, _dialect, form) =>
      form?.enhancerCurrent
        ? `<Surround><Current><Enhancer>${value ? "On" : "Off"}</Enhancer></Current></Surround>`
        : `<Surround><Program_Sel><Current><Enhancer>${value ? "On" : "Off"}</Enhancer></Current></Program_Sel></Surround>`,
  },
  {
    // The zone's tone-control mode — same id as YNCA's TONEMODE and MusicCast's, read here where the
    // zone reports `Tone,Mode` (D6). Read-only: desc.xml declares no write for it.
    state: "sound.toneMode",
    common: {
      nameKey: "toneControlMode",
      descKey: "descToneControlMode",
      type: "string",
      role: "state",
      read: true,
      write: false,
    },
    statusField: "toneMode",
  },
  {
    state: "sound.cinemaDsp3d",
    common: {
      nameKey: "cinemaDSP3D",
      descKey: "descCinemaDSP3D",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "cinemaDsp3d",
    toInner: value => `<Surround><_3D_Cinema_DSP>${value ? "Auto" : "Off"}</_3D_Cinema_DSP></Surround>`,
  },
  {
    state: "advanced.speakers.speakerA",
    common: { nameKey: "speakerA", type: "boolean", role: "switch", read: true, write: true },
    statusField: "speakerA",
    mainOnly: true,
    toInner: value =>
      `<Speaker_Preout><Speaker_AB><Speaker_A>${value ? "On" : "Off"}</Speaker_A></Speaker_AB></Speaker_Preout>`,
  },
  {
    state: "advanced.speakers.speakerB",
    common: { nameKey: "speakerB", type: "boolean", role: "switch", read: true, write: true },
    statusField: "speakerB",
    mainOnly: true,
    toInner: value =>
      `<Speaker_Preout><Speaker_AB><Speaker_B>${value ? "On" : "Off"}</Speaker_B></Speaker_AB></Speaker_Preout>`,
  },
  {
    state: "multiroom.zoneB.power",
    common: { nameKey: "zoneBPower", type: "boolean", role: "switch.power", read: true, write: true },
    statusField: "zoneBPower",
    mainOnly: true,
    toInner: value => `<Power_Control><Zone_B_Power>${value ? "On" : "Standby"}</Zone_B_Power></Power_Control>`,
  },
  {
    state: "multiroom.zoneB.available",
    common: {
      nameKey: "zoneBAvailability",
      descKey: "descZoneBAvailability",
      type: "string",
      role: "state",
      read: true,
      write: false,
      states: { Ready: "Ready", "Not Ready": "Not Ready" },
    },
    statusField: "zoneBAvailable",
    mainOnly: true,
  },
  {
    state: "multiroom.zoneB.interlock",
    common: {
      nameKey: "zoneBInterlock",
      descKey: "descZoneBInterlock",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "zoneBInterlock",
    mainOnly: true,
    toInner: value => `<Volume><Zone_B><Interlock>${value ? "On" : "Off"}</Interlock></Zone_B></Volume>`,
  },
  {
    state: "multiroom.zoneB.volume",
    common: {
      nameKey: "zoneBVolume",
      type: "number",
      role: "level.volume",
      read: true,
      write: true,
      unit: "dB",
      min: -80.5,
      max: 16.5,
      step: 0.5,
    },
    statusField: "zoneBVolume",
    mainOnly: true,
    rangePaths: ["Volume,Zone_B,Lvl"],
    toInner: (value, _dialect, form) =>
      `<Volume><Zone_B><Lvl><Val>${xmlTenths(value, form?.steps?.["multiroom.zoneB.volume"] ?? 0.5)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Zone_B></Volume>`,
  },
  {
    state: "multiroom.zoneB.mute",
    common: { nameKey: "zoneBMute", type: "boolean", role: "media.mute", read: true, write: true },
    statusField: "zoneBMute",
    mainOnly: true,
    toInner: value => `<Volume><Zone_B><Mute>${value ? "On" : "Off"}</Mute></Zone_B></Volume>`,
  },
  {
    state: "volumeOutput",
    common: {
      nameKey: "volumeOutputMode",
      descKey: "descVolumeOutputMode",
      type: "string",
      role: "state",
      read: true,
      write: true,
      states: { Variable: "Variable", Fixed: "Fixed" },
    },
    statusField: "volumeOutput",
    zonesOnly: true,
    toInner: value => `<Volume><Output>${escapeXmlText(value)}</Output></Volume>`,
  },
  // HDMI outputs and party — the predecessor's setHDMIOutput / partyMode.
  // Main-zone-only; both are written on the System element (writeZone).
  // Scenes are NOT in this static list: the device declares its scenes itself
  // (`<Scene_Sel_Item>`: which exist, their titles, the `Scene_Sel` write value —
  // per zone), so the controller builds them from that declaration. The
  // predecessor's blind `Scene_Load` is gone; nothing ever proved it worked (#615).
  {
    state: "hdmiOut1",
    common: { nameKey: "hdmiOUT1", descKey: "descHdmiOUT1", type: "boolean", role: "switch", read: true, write: true },
    statusField: "hdmiOut1",
    mainOnly: true,
    writeZone: "System",
    toInner: value => `<Sound_Video><HDMI><Output><OUT_1>${value ? "On" : "Off"}</OUT_1></Output></HDMI></Sound_Video>`,
  },
  {
    state: "hdmiOut2",
    common: { nameKey: "hdmiOUT2", descKey: "descHdmiOUT2", type: "boolean", role: "switch", read: true, write: true },
    statusField: "hdmiOut2",
    mainOnly: true,
    writeZone: "System",
    toInner: value => `<Sound_Video><HDMI><Output><OUT_2>${value ? "On" : "Off"}</OUT_2></Output></HDMI></Sound_Video>`,
  },
  {
    state: "multiroom.party",
    common: {
      nameKey: "partyModeAllZones",
      descKey: "descPartyModeAllZones",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "party",
    mainOnly: true,
    writeZone: "System",
    toInner: value => `<Party_Mode><Mode>${value ? "On" : "Off"}</Mode></Party_Mode>`,
  },
];

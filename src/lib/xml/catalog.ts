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
  /** The Basic_Status field this state reads from; absent would mean a write-only command (every entry reads one). */
  statusField?: Exclude<keyof BasicStatus, "zoneForm">;
  /**
   * Build the inner PUT XML for a written value; absent means read-only. The dialect is the
   * spelling THIS device answered its status with (see {@link XmlDialect}); an entry whose
   * element differs between the generations builds the device's own. `step` is the grid the zone
   * declares for this entry's level — the caller looks it up under the entry's own state, so a
   * renamed entry cannot fall back to 0.5 unnoticed (audit 2026-09-29, D19).
   */
  toInner?: (value: unknown, dialect?: XmlDialect, form?: XmlZoneForm, step?: number) => string;
  /** Only exists on the main zone (a system/main-wide feature like HDMI outputs, party, speaker terminals, Zone B). */
  mainOnly?: boolean;
  /** Only exists on zones 2–4 (the pre-out level mode). */
  zonesOnly?: boolean;
  /** Override the write target element (e.g. `System` for HDMI outputs and party); default is the zone element. */
  writeZone?: string;
  /**
   * The desc.xml write paths of this state, after the element (`Volume,Lvl`; the 2008 spelling next
   * to it). Where the device description declares a command list, the state is writable exactly where
   * one of them is declared, with the bounds declared there; `common.write` and the `common` bounds are
   * the rule for a device without one (the 2020 generation). Before, only the dialogue level asked the
   * description and every other state was writable because its status carried it (D11, D18).
   */
  putPaths?: string[];
}

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
 * A level in the wire envelope of every desc.xml (`Val` in tenths, `Exp 1`, `Unit dB`).
 *
 * @param value the written value in dB
 * @param step the declared grid in dB
 * @returns the envelope
 */
function dbLevel(value: unknown, step = 0.5): string {
  return `<Val>${xmlTenths(value, step)}</Val><Exp>1</Exp><Unit>dB</Unit>`;
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

/** The unified XML amplifier catalog — object + read field + PUT builder in one list. */
export const XML_AMP_CATALOG: XmlAmpEntry[] = [
  {
    state: "power",
    common: { nameKey: "power", type: "boolean", role: "switch.power", read: true, write: true },
    statusField: "power",
    putPaths: ["Power_Control,Power"],
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
    putPaths: ["Volume,Lvl", "Vol,Lvl"],
    toInner: (value: unknown, dialect?: XmlDialect, _form?: XmlZoneForm, step?: number): string => {
      const element = dialect === "legacy" ? "Vol" : "Volume";
      return `<${element}><Lvl>${dbLevel(value, step)}</Lvl></${element}>`;
    },
  },
  {
    state: "mute",
    common: { nameKey: "mute", type: "boolean", role: "media.mute", read: true, write: true },
    statusField: "mute",
    putPaths: ["Volume,Mute", "Vol,Mute"],
    toInner: (value: unknown, dialect?: XmlDialect): string => {
      const element = dialect === "legacy" ? "Vol" : "Volume";
      return `<${element}><Mute>${value ? "On" : "Off"}</Mute></${element}>`;
    },
  },
  {
    state: "input",
    common: { nameKey: "input", type: "string", role: "media.input", read: true, write: true },
    statusField: "input",
    putPaths: ["Input,Input_Sel"],
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
    // No write paths: the 2008 description declares no PUT for `Surr` while openHAB writes it there —
    // the known gap of that description (D12), so the program stays writable without its declaration.
    toInner: (value, dialect) =>
      // The 2008 generation leaves Straight on unless the write turns it off in the same command
      // (openHAB `ZoneControlXML`, the only source — its desc declares no PUT for `Surr`; D12).
      dialect === "legacy"
        ? `<Surr><Pgm_Sel><Straight>Off</Straight><Pgm>${escapeXmlText(value)}</Pgm></Pgm_Sel></Surr>`
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
    putPaths: ["Sound_Video,Pure_Direct,Mode"],
    toInner: value => `<Sound_Video><Pure_Direct><Mode>${value ? "On" : "Off"}</Mode></Pure_Direct></Sound_Video>`,
  },
  {
    state: "sound.straight",
    common: { nameKey: "straight", descKey: "descStraight", type: "boolean", role: "switch", read: true, write: true },
    statusField: "straight",
    // No write paths, like the program it belongs to (D12).
    toInner: (value, dialect) =>
      dialect === "legacy"
        ? `<Surr><Pgm_Sel><Straight>${value ? "On" : "Off"}</Straight></Pgm_Sel></Surr>`
        : `<Surround><Program_Sel><Current><Straight>${value ? "On" : "Off"}</Straight></Current></Program_Sel></Surround>`,
  },
  {
    state: "sound.direct",
    common: { nameKey: "direct", descKey: "descDirect", type: "boolean", role: "switch", read: true, write: true },
    statusField: "direct",
    putPaths: ["Sound_Video,Direct,Mode"],
    toInner: value => `<Sound_Video><Direct><Mode>${value ? "On" : "Off"}</Mode></Direct></Sound_Video>`,
  },
  {
    state: "sound.adaptiveDrc",
    common: {
      nameKey: "adaptiveDRC",
      descKey: "descAdaptiveDRC",
      // A switch on every protocol: Off/Auto are its only two values, MusicCast reports a boolean (krobi 2026-10-05).
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    statusField: "adaptiveDrc",
    putPaths: ["Sound_Video,Adaptive_DRC"],
    toInner: value => `<Sound_Video><Adaptive_DRC>${value ? "Auto" : "Off"}</Adaptive_DRC></Sound_Video>`,
  },
  {
    // Writable where desc.xml declares it for the zone (`Put_2`, a bare number in `Range 0,3,1` —
    // HTR-4069, RX-A2060, RX-V675, RX-V775, TSR-5810); read-only without a description (D19, D18).
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
    putPaths: ["Sound_Video,Dialogue_Adjust,Dialogue_Lvl"],
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
    putPaths: ["Power_Control,Sleep"],
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
      role: "level.bass",
      read: true,
      write: true,
      unit: "dB",
      min: -6,
      max: 6,
      step: 0.5,
    },
    statusField: "bass",
    putPaths: ["Sound_Video,Tone,Bass", "Sound_Video,Tone,Manual,Bass"],
    // Under `Tone,Manual` where the zone uses that form (RX-A2060 zones 2/3, the 2020 generation — D6).
    toInner: (value, _dialect, form, step) => toneInner("Bass", dbLevel(value, step), form),
  },
  {
    state: "sound.treble",
    common: {
      nameKey: "treble",
      descKey: "descTreble",
      type: "number",
      role: "level.treble",
      read: true,
      write: true,
      unit: "dB",
      min: -6,
      max: 6,
      step: 0.5,
    },
    statusField: "treble",
    putPaths: ["Sound_Video,Tone,Treble", "Sound_Video,Tone,Manual,Treble"],
    toInner: (value, _dialect, form, step) => toneInner("Treble", dbLevel(value, step), form),
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
    putPaths: ["Volume,Subwoofer_Trim"],
    toInner: (value, _dialect, _form, step) =>
      `<Volume><Subwoofer_Trim>${dbLevel(value, step)}</Subwoofer_Trim></Volume>`,
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
    putPaths: ["Sound_Video,Extra_Bass"],
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
    putPaths: ["Sound_Video,YPAO_Volume"],
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
    putPaths: ["Sound_Video,Dialogue_Adjust,Dialogue_Lift"],
    toInner: value =>
      `<Sound_Video><Dialogue_Adjust><Dialogue_Lift>${Math.round(Number(value))}</Dialogue_Lift></Dialogue_Adjust></Sound_Video>`,
  },
  {
    // Same id as YNCA's DTSDIALOGUECONTROL and MusicCast's `dts_dialogue_control`; the RX-A2060 and
    // TSR-5810 declare it (`Put_2`, `Range 0,6,1`) and report it in Basic_Status (audit 2026-09-29, D15).
    state: "sound.dtsDialogueControl",
    common: {
      nameKey: "dtsDialogueControl",
      descKey: "descDtsDialogueControl",
      type: "number",
      role: "value",
      read: true,
      write: false,
    },
    statusField: "dtsDialogueControl",
    putPaths: ["Sound_Video,Dialogue_Adjust,DTS_Dialogue_Control"],
    toInner: value =>
      `<Sound_Video><Dialogue_Adjust><DTS_Dialogue_Control>${Math.round(Number(value))}</DTS_Dialogue_Control></Dialogue_Adjust></Sound_Video>`,
  },
  // The zone commands desc.xml declares and Basic_Status reports on the 2012–2017 generation
  // (coverage audit 2026-09-09): the enhancer and CINEMA DSP 3D (9 of 10 descriptors), the
  // speaker terminals A/B and Zone B (HTR-4069 class), the pre-out level mode of zones 2–4.
  // Same ids as the YNCA entries, so one datapoint serves both transports (the Zone B interlock is
  // XML-only).
  {
    state: "sound.enhancer",
    common: { nameKey: "enhancer", descKey: "descEnhancer", type: "boolean", role: "switch", read: true, write: true },
    statusField: "enhancer",
    putPaths: ["Surround,Program_Sel,Current,Enhancer", "Surround,Current,Enhancer"],
    // Under `Surround,Current` where the zone uses that form (D6).
    toInner: (value, _dialect, form) =>
      form?.enhancerCurrent
        ? `<Surround><Current><Enhancer>${value ? "On" : "Off"}</Enhancer></Current></Surround>`
        : `<Surround><Program_Sel><Current><Enhancer>${value ? "On" : "Off"}</Enhancer></Current></Program_Sel></Surround>`,
  },
  {
    // The zone's tone-control mode — same id as YNCA's TONEMODE and MusicCast's, read here where the
    // zone reports `Tone,Mode` (D6). Writable where desc.xml declares it (RX-A2060 zones 2/3: `Put_1`
    // Auto/Bypass/Manual, P9) — the comment here said no description did; read-only without one.
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
    putPaths: ["Sound_Video,Tone,Mode"],
    toInner: value => `<Sound_Video><Tone><Mode>${escapeXmlText(value)}</Mode></Tone></Sound_Video>`,
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
    putPaths: ["Surround,_3D_Cinema_DSP"],
    toInner: value => `<Surround><_3D_Cinema_DSP>${value ? "Auto" : "Off"}</_3D_Cinema_DSP></Surround>`,
  },
  {
    state: "advanced.speakers.speakerA",
    common: { nameKey: "speakerA", type: "boolean", role: "switch", read: true, write: true },
    statusField: "speakerA",
    mainOnly: true,
    putPaths: ["Speaker_Preout,Speaker_AB,Speaker_A"],
    toInner: value =>
      `<Speaker_Preout><Speaker_AB><Speaker_A>${value ? "On" : "Off"}</Speaker_A></Speaker_AB></Speaker_Preout>`,
  },
  {
    state: "advanced.speakers.speakerB",
    common: { nameKey: "speakerB", type: "boolean", role: "switch", read: true, write: true },
    statusField: "speakerB",
    mainOnly: true,
    putPaths: ["Speaker_Preout,Speaker_AB,Speaker_B"],
    toInner: value =>
      `<Speaker_Preout><Speaker_AB><Speaker_B>${value ? "On" : "Off"}</Speaker_B></Speaker_AB></Speaker_Preout>`,
  },
  {
    // Zone B takes the zone form — the name and role a zone's own switch, mute and volume carry, under the zoneB
    // folder that names the zone — so the datapoint reads the same whether XML, YNCA or MusicCast (whose zone2 IS
    // Zone B on such a device) serves it; the zone role comes from the folder (`zoneRole`). It read "Zone B power"
    // as `switch.power` here and "Power" as `switch.power.zone` on MusicCast (review 2026-10-05, A27).
    state: "multiroom.zoneB.power",
    common: { nameKey: "power", type: "boolean", role: "switch.power", read: true, write: true },
    statusField: "zoneBPower",
    mainOnly: true,
    putPaths: ["Power_Control,Zone_B_Power"],
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
    putPaths: ["Volume,Zone_B,Interlock"],
    toInner: value => `<Volume><Zone_B><Interlock>${value ? "On" : "Off"}</Interlock></Zone_B></Volume>`,
  },
  {
    state: "multiroom.zoneB.volume",
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
    statusField: "zoneBVolume",
    mainOnly: true,
    putPaths: ["Volume,Zone_B,Lvl"],
    toInner: (value, _dialect, _form, step) => `<Volume><Zone_B><Lvl>${dbLevel(value, step)}</Lvl></Zone_B></Volume>`,
  },
  {
    state: "multiroom.zoneB.mute",
    common: { nameKey: "mute", type: "boolean", role: "media.mute", read: true, write: true },
    statusField: "zoneBMute",
    mainOnly: true,
    putPaths: ["Volume,Zone_B,Mute"],
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
    putPaths: ["Volume,Output"],
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
    putPaths: ["Sound_Video,HDMI,Output,OUT_1"],
    toInner: value => `<Sound_Video><HDMI><Output><OUT_1>${value ? "On" : "Off"}</OUT_1></Output></HDMI></Sound_Video>`,
  },
  {
    state: "hdmiOut2",
    common: { nameKey: "hdmiOUT2", descKey: "descHdmiOUT2", type: "boolean", role: "switch", read: true, write: true },
    statusField: "hdmiOut2",
    mainOnly: true,
    writeZone: "System",
    putPaths: ["Sound_Video,HDMI,Output,OUT_2"],
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
    putPaths: ["Party_Mode,Mode"],
    toInner: value => `<Party_Mode><Mode>${value ? "On" : "Off"}</Mode></Party_Mode>`,
  },
];

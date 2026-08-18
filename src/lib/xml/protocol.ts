/**
 * Wrap an inner command in the YAMAHA_AV PUT envelope for a zone.
 *
 * @param zone the zone element (e.g. `Main_Zone`)
 * @param inner the inner command XML
 * @returns the full request body
 */
export function encodePut(zone: string, inner: string): string {
  return `<YAMAHA_AV cmd="PUT"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}

/**
 * Wrap an inner request in the YAMAHA_AV GET envelope for a zone.
 *
 * @param zone the zone element (e.g. `Main_Zone`)
 * @param inner the inner request XML
 * @returns the full request body
 */
export function encodeGet(zone: string, inner: string): string {
  return `<YAMAHA_AV cmd="GET"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}

/**
 * Extract the model name from a `<System><Config>` response, if it carries one.
 *
 * @param xml the System>Config response body
 * @returns the model name, or undefined
 */
export function parseModelName(xml: string): string | undefined {
  const match = /<Model_Name>([^<]*)<\/Model_Name>/.exec(xml);
  return match && match[1].length > 0 ? match[1] : undefined;
}

/** The amplifier fields a Basic_Status response can carry. */
export interface BasicStatus {
  /** Power state (true = on). */
  power?: boolean;
  /** Volume in decibels. */
  volume?: number;
  /** Mute state. */
  mute?: boolean;
  /** Selected input. */
  input?: string;
  /** Selected sound program (DSP). */
  soundProgram?: string;
  /** Pure Direct mode. */
  pureDirect?: boolean;
  /** Straight (surround off) mode. */
  straight?: boolean;
  /** Direct mode (Sound_Video/Direct). */
  direct?: boolean;
  /** Adaptive DRC (e.g. "Auto", "Off"). */
  adaptiveDrc?: string;
  /** Dialogue level. */
  dialogueLevel?: number;
  /** Sleep timer (e.g. "Off", "30 min"). */
  sleep?: string;
  /** Bass tone control (dB). */
  bass?: number;
  /** Treble tone control (dB). */
  treble?: number;
  /** Subwoofer trim (dB). */
  subwooferTrim?: number;
  /** Extra Bass (device reports Auto/Off, mapped to a boolean). */
  extraBass?: boolean;
  /** YPAO Volume (device reports Auto/Off, mapped to a boolean). */
  ypaoVolume?: boolean;
  /** HDMI output OUT_1 on/off. */
  hdmiOut1?: boolean;
  /** HDMI output OUT_2 on/off. */
  hdmiOut2?: boolean;
  /** Party mode (device reports Party_Info On/Off). */
  party?: boolean;
  /** Dialogue lift. */
  dialogueLift?: number;
}

/**
 * Parse a Basic_Status response into the amplifier fields it carries. Only fields
 * the response actually contains are returned; a malformed response yields an
 * empty object. Volume comes as tenths of a decibel (`<Val>-300</Val>` = -30 dB).
 *
 * @param xml the Basic_Status response body
 * @returns the parsed fields
 */
export function parseBasicStatus(xml: string): BasicStatus {
  const status: BasicStatus = {};
  const power = /<Power>(On|Standby)<\/Power>/.exec(xml);
  if (power) {
    status.power = power[1] === "On";
  }
  // Scope the volume to its <Volume><Lvl> parent — a bare <Val> also matches
  // Dialogue_Lvl and other <Val>-carrying fields, so an unscoped match would read
  // the wrong field as the volume.
  const volume = /<Volume>\s*<Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (volume) {
    status.volume = Number(volume[1]) / 10;
  }
  const mute = /<Mute>(On|Off)<\/Mute>/.exec(xml);
  if (mute) {
    status.mute = mute[1] === "On";
  }
  const input = /<Input_Sel>([^<]+)<\/Input_Sel>/.exec(xml);
  if (input) {
    status.input = input[1];
  }
  const soundProgram = /<Sound_Program>([^<]+)<\/Sound_Program>/.exec(xml);
  if (soundProgram) {
    status.soundProgram = soundProgram[1];
  }
  const pureDirect = /<Pure_Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (pureDirect) {
    status.pureDirect = pureDirect[1] === "On";
  }
  const straight = /<Straight>(On|Off)<\/Straight>/.exec(xml);
  if (straight) {
    status.straight = straight[1] === "On";
  }
  const direct = /<Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (direct) {
    status.direct = direct[1] === "On";
  }
  const adaptiveDrc = /<Adaptive_DRC>(Auto|Off)<\/Adaptive_DRC>/.exec(xml);
  if (adaptiveDrc) {
    status.adaptiveDrc = adaptiveDrc[1];
  }
  const dialogueLevel = /<Dialogue_Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (dialogueLevel) {
    status.dialogueLevel = Number(dialogueLevel[1]);
  }
  const sleepMatch = /<Sleep>([^<]+)<\/Sleep>/.exec(xml);
  if (sleepMatch) {
    status.sleep = sleepMatch[1];
  }
  // Tone/subwoofer/extra-bass/YPAO — the fields the predecessor adapter (via
  // yamaha-nodejs-soef) read on real pre-2010 devices. Val is scoped to its own
  // element, so Subwoofer_Trim's <Val> is never read as the volume. Like the volume,
  // these carry the Val/Exp=1/Unit=dB structure (the soef library builds the identical
  // envelope for setVolumeTo and setBassTo), so Val is tenths of a decibel: /10 here,
  // *10 in the PUT builders.
  const bass = /<Bass>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (bass) {
    status.bass = Number(bass[1]) / 10;
  }
  const treble = /<Treble>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (treble) {
    status.treble = Number(treble[1]) / 10;
  }
  const subwooferTrim = /<Subwoofer_Trim>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (subwooferTrim) {
    status.subwooferTrim = Number(subwooferTrim[1]) / 10;
  }
  const extraBass = /<Extra_Bass>([^<]+)<\/Extra_Bass>/.exec(xml);
  if (extraBass) {
    status.extraBass = extraBass[1] !== "Off";
  }
  const ypaoVolume = /<YPAO_Volume>([^<]+)<\/YPAO_Volume>/.exec(xml);
  if (ypaoVolume) {
    status.ypaoVolume = ypaoVolume[1] !== "Off";
  }
  // HDMI outputs, party and dialogue lift — read from the main zone's Basic_Status
  // (Sound_Video/HDMI, Party_Info, Dialogue_Adjust), as the predecessor adapter did.
  const hdmiOut1 = /<OUT_1>(On|Off)<\/OUT_1>/.exec(xml);
  if (hdmiOut1) {
    status.hdmiOut1 = hdmiOut1[1] === "On";
  }
  const hdmiOut2 = /<OUT_2>(On|Off)<\/OUT_2>/.exec(xml);
  if (hdmiOut2) {
    status.hdmiOut2 = hdmiOut2[1] === "On";
  }
  const party = /<Party_Info>([^<]+)<\/Party_Info>/.exec(xml);
  if (party) {
    status.party = party[1] === "On";
  }
  const dialogueLift = /<Dialogue_Lift>(-?\d+)<\/Dialogue_Lift>/.exec(xml);
  if (dialogueLift) {
    status.dialogueLift = Number(dialogueLift[1]);
  }
  return status;
}

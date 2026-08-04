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
  const val = /<Val>(-?\d+)<\/Val>/.exec(xml);
  if (val) {
    status.volume = Number(val[1]) / 10;
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
  return status;
}

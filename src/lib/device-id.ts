import type { DeviceIdentity } from "./device-identity";

/**
 * The generation of the device-id rule a device object was given its id under. Written as
 * `native.idScheme` once the id is final: a device object without it still carries an id of the
 * 2.x rule (derived from a name the device advertised or the user typed) and moves once, to
 * {@link deviceIdFor}, as soon as its model and serial are known.
 */
export const ID_SCHEME = 3;

/** Object-id segments the adapter reserves for its own tree — no device may take them. */
export const RESERVED_DEVICE_IDS: ReadonlySet<string> = new Set(["info"]);

/** How many trailing characters of the serial the id carries. */
const SERIAL_TAIL = 4;

/** The German letters that have a written two-letter form — "Küche" reads "kueche", not "kuche". */
const TRANSLITERATION: Readonly<Record<string, string>> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
};

/**
 * Turn a model designation or a name into an id segment: lower case, German umlauts in their
 * written form, other accents dropped, every run of anything else one hyphen, nothing at either
 * end. The js-controller would accept letters of any script (`FORBIDDEN_CHARS` in
 * js-controller-common-db only bars punctuation), but an id is typed into scripts, MQTT topics and
 * URLs — plain lower-case ASCII is what every one of them takes without escaping.
 *
 * @param raw a model, a name or an address
 * @returns the segment (empty when nothing usable is left)
 */
export function idSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[äöüÄÖÜß]/g, letter => TRANSLITERATION[letter])
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `base`, or `base-2`, `base-3` … — the first one that is free.
 *
 * @param base the id wanted
 * @param taken the ids other devices hold
 * @returns a free id
 */
function counted(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_DEVICE_IDS.has(id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/**
 * The id of a device that tells its model and serial: the model and the last four characters of
 * the serial (`wx-030-2b3c`). Short, the same for every generation (MusicCast, the XML receivers
 * and the network search all report the serial), and unique: two devices of one model differ in
 * their serial. Should two of them share the last four characters, the one that comes second gets
 * the whole serial (`wx-010-0b11aa22`).
 *
 * @param model the model the device reports (`WX-030`)
 * @param identity the serial/MAC it reports
 * @param taken the ids other devices hold
 * @returns the id, or undefined without a model or a serial
 */
export function serialId(
  model: string | undefined,
  identity: DeviceIdentity | undefined,
  taken: ReadonlySet<string>,
): string | undefined {
  const modelPart = idSegment(model ?? "");
  const serial = identity?.serial?.toLowerCase();
  if (!modelPart || !serial) {
    return undefined;
  }
  const short = `${modelPart}-${serial.slice(-SERIAL_TAIL)}`;
  return taken.has(short) ? `${modelPart}-${serial}` : short;
}

/**
 * The id of a device that tells its model but no serial — a YNCA receiver whose XML server does
 * not answer: the model, counted on when a device of the same model holds it (`rx-v473-2`).
 *
 * @param model the model the device reports
 * @param taken the ids other devices hold
 * @returns the id, or undefined without a model
 */
export function modelId(model: string | undefined, taken: ReadonlySet<string>): string | undefined {
  const modelPart = idSegment(model ?? "");
  return modelPart ? counted(modelPart, taken) : undefined;
}

/**
 * The id of a device the adapter knows nothing about yet — added by hand while it was switched
 * off: the name the user typed, else its address, counted on when taken. It moves to its model id
 * at the first contact that tells the model (`checkIdDecision` in main.ts).
 *
 * @param name the name the user typed
 * @param ip the device's address
 * @param taken the ids other devices hold
 * @returns a free id
 */
export function nameId(name: string | undefined, ip: string, taken: ReadonlySet<string>): string {
  return counted(idSegment(name ?? "") || idSegment(ip), taken);
}

/** What {@link deviceIdFor} decides an id from. */
export interface DeviceIdInput {
  /** The model the device reports. */
  model?: string;
  /** Serial and MAC as the device reports them. */
  identity?: DeviceIdentity;
  /** The name it advertises, or the one the user typed. */
  name?: string;
  /** Its address. */
  ip: string;
}

/**
 * The id a NEW device gets: model and serial ({@link serialId}); the model alone when there is no
 * serial ({@link modelId}); the name or the address when not even the model is known
 * ({@link nameId}). Decided once and stored; never derived again.
 *
 * @param device what is known about the device
 * @param taken the ids other devices hold
 * @returns the id
 */
export function deviceIdFor(device: DeviceIdInput, taken: ReadonlySet<string>): string {
  const bySerial = serialId(device.model, device.identity, taken);
  if (bySerial && !taken.has(bySerial)) {
    return bySerial;
  }
  return modelId(device.model, taken) ?? nameId(device.name, device.ip, taken);
}

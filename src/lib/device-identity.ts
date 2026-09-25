/**
 * The identity a Yamaha device carries for life — independent of its name and its address.
 *
 * Three sources agree on it (measured on the RX-V6A, 2026-09-01 capture): the UPnP
 * description's `<serialNumber>` and the MAC in its `<UDN>`, MusicCast `getDeviceInfo`
 * `system_id`/`device_id`, and the XML transport's `System_ID`. Only YNCA has no serial
 * function. The object-tree id stays what it always was (derived from the name the device
 * advertised when it was first found) — this identity is the match key NEXT to it, never a
 * replacement: an id that moves takes the whole tree with it.
 */
export interface DeviceIdentity {
  /** The serial number (hex, `0A1B2C3D`). */
  serial?: string;
  /** The MAC address without separators (`00A0DE0A1B2C`). */
  mac?: string;
}

const HEX_SERIAL = /^[0-9A-F]{6,}$/;
const HEX_MAC = /^[0-9A-F]{12}$/;
const ALL_ZERO = /^0+$/;

/**
 * One identity field, normalised — or nothing when it cannot prove anything.
 *
 * @param raw the device's answer
 * @param shape what a real value looks like
 * @returns the upper-cased value, or undefined
 */
function valid(raw: unknown, shape: RegExp): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  // A blanked value must never match: the bundled fixtures carry `00000000` and a model-shaped
  // placeholder where the real numbers were scrubbed — two such devices are NOT one device.
  return shape.test(value) && !ALL_ZERO.test(value) ? value : undefined;
}

/**
 * Build an identity from raw device answers; undefined when neither field is usable.
 *
 * @param raw the serial and/or MAC as the device reported them
 * @param raw.serial the serial number
 * @param raw.mac the MAC address, separators already stripped
 * @returns the identity, or undefined
 */
export function identityFrom(raw: { serial?: unknown; mac?: unknown }): DeviceIdentity | undefined {
  const serial = valid(raw.serial, HEX_SERIAL);
  const mac = valid(raw.mac, HEX_MAC);
  if (!serial && !mac) {
    return undefined;
  }
  return { ...(serial ? { serial } : {}), ...(mac ? { mac } : {}) };
}

/**
 * Same physical device: an equal serial or an equal MAC, both sides set.
 *
 * @param a one identity
 * @param b the other
 * @returns whether they name the same device
 */
export function sameDevice(a?: DeviceIdentity, b?: DeviceIdentity): boolean {
  if (!a || !b) {
    return false;
  }
  return (!!a.serial && a.serial === b.serial) || (!!a.mac && a.mac === b.mac);
}

/**
 * Two identities that name DIFFERENT devices: a serial or a MAC set on both sides and unequal, with
 * nothing that ties them together. Disjoint fields (one knows the serial, the other the MAC)
 * contradict nothing.
 *
 * @param a one identity
 * @param b the other
 * @returns whether they cannot be the same device
 */
export function contradicts(a?: DeviceIdentity, b?: DeviceIdentity): boolean {
  if (!a || !b || sameDevice(a, b)) {
    return false;
  }
  return (!!a.serial && !!b.serial && a.serial !== b.serial) || (!!a.mac && !!b.mac && a.mac !== b.mac);
}

/**
 * Union of two identities, the learned one winning per field — unless they contradict each other:
 * then the learned one REPLACES the known one (a replacement receiver at the same address), instead
 * of a record carrying the old device's MAC next to the new one's serial (audit 2026-09-24, A10).
 *
 * @param known what was remembered
 * @param learned what a transport or the search just reported
 * @returns the union (or the learned identity), or undefined when both are empty
 */
export function mergeIdentity(known?: DeviceIdentity, learned?: DeviceIdentity): DeviceIdentity | undefined {
  if (!known && !learned) {
    return undefined;
  }
  if (contradicts(known, learned)) {
    return { ...learned };
  }
  return { ...known, ...learned };
}

/**
 * The MAC a UPnP `<UDN>uuid:…-<mac></UDN>` carries in its last segment, if it is one.
 *
 * @param udn the UDN text
 * @returns the MAC, or undefined
 */
export function macFromUdn(udn: string): string | undefined {
  const tail = udn.trim().split("-").pop() ?? "";
  return identityFrom({ mac: tail })?.mac;
}

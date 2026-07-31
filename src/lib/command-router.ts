import type { DeviceCommand, DeviceRecord, TransportDecision } from "./types";

/** Capability prefixes only the YXC/MusicCast protocol serves (media, tuner, CD, clock, multiroom). */
const YXC_EXCLUSIVE_PREFIXES = ["netusb", "tuner", "cd", "clock", "dist"];

/**
 * Decides which transport carries a command for a device — the one place that
 * knows "who serves what". A YXC-exclusive capability needs YXC; everything else
 * is amplifier control, preferring YNCA and falling back to the legacy XML path.
 */
export class CommandRouter {
  /**
   * Resolve which protocol should carry a command for a device.
   *
   * @param device the target device with its known protocols
   * @param command the command to route
   * @returns the chosen protocol, or "skip" if none can serve it
   */
  public resolveTransport(device: DeviceRecord, command: DeviceCommand): TransportDecision {
    if (isYxcExclusive(command.kind)) {
      return device.protocols.has("yxc") ? "yxc" : "skip";
    }
    // Amplifier control: YNCA is the dedicated control protocol; a MusicCast-only
    // device (speaker/soundbar) serves it over YXC; XML is the legacy fallback.
    if (device.protocols.has("ynca")) {
      return "ynca";
    }
    if (device.protocols.has("yxc")) {
      return "yxc";
    }
    if (device.protocols.has("xml")) {
      return "xml";
    }
    return "skip";
  }
}

/**
 * True when a capability path is one only YXC serves (exact head or dotted child).
 *
 * @param kind the command's dotted capability path
 * @returns whether only the YXC protocol can serve it
 */
function isYxcExclusive(kind: string): boolean {
  return YXC_EXCLUSIVE_PREFIXES.some(prefix => kind === prefix || kind.startsWith(`${prefix}.`));
}

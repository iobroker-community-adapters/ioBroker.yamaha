import { lookup } from "node:dns/promises";
import type { NetworkInterfaceInfo } from "node:os";

/**
 * The interface addresses an SSDP search must leave from.
 *
 * A configured interface (non-empty, not the `0.0.0.0` wildcard) pins the search to
 * exactly that one address. Left empty, the search has to cover EVERY non-internal
 * IPv4 interface: multicast egress otherwise follows only the host's default route,
 * so on a multi-homed host whose default route is not the AV network the receiver is
 * never reached and auto-discovery finds nothing — the "0 found until an interface is
 * picked by hand" symptom. An empty result means "no usable interface": the caller
 * falls back to the default route (bind to `0.0.0.0`).
 *
 * @param configured the configured interface IP, or empty/undefined for "all interfaces"
 * @param ifaces the host interfaces (from `os.networkInterfaces()`)
 * @returns the addresses to search from — the one configured, else every non-internal IPv4
 */
export function searchInterfaces(
  configured: string | undefined,
  ifaces: Record<string, NetworkInterfaceInfo[] | undefined>,
): string[] {
  if (configured && configured !== "0.0.0.0") {
    return [configured];
  }
  const addresses: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      // family is "IPv4" on modern Node, 4 on older releases — accept both; skip loopback/internal.
      if (!info.internal && (info.family === "IPv4" || (info.family as unknown) === 4)) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/**
 * A dotted IPv4 address, every part 0–255 — the one rule for the add dialog's validator, the backend
 * check, the migration marker and the resolver. Three copies stood, and all three took
 * `999.999.999.999` (audit 2026-09-29, A35).
 */
export const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Whether a text is a dotted IPv4 address (see {@link IPV4_RE}).
 *
 * @param text the text
 * @returns whether it is one
 */
export function isIPv4(text: string): boolean {
  return IPV4_RE.test(text);
}

/**
 * The IPv4 address a configured host stands for. A table row may carry a hostname (the 0.5.x
 * migration takes `config.ip` over as it was; the old adapter's HTTP client resolved names), but
 * every comparison the adapter makes is against the numeric SOURCE address of a packet — a MusicCast
 * event, an SSDP answer, a NOTIFY (audit 2026-09-24, A12/C2). An address is returned as it is.
 *
 * @param host the configured address or hostname
 * @param resolve the resolver (injectable for tests)
 * @returns the IPv4 address, or undefined when the name does not resolve
 */
export async function resolveIPv4(
  host: string,
  resolve: (name: string) => Promise<{ address: string }> = name => lookup(name, { family: 4 }),
): Promise<string | undefined> {
  if (isIPv4(host)) {
    return host;
  }
  try {
    return (await resolve(host)).address;
  } catch {
    return undefined;
  }
}

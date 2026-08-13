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

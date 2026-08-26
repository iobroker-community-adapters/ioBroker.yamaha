import { errorMessage } from "./util";

const YAMAHA_MANUFACTURER = /<manufacturer>[^<]*yamaha[^<]*<\/manufacturer>/i;
const FRIENDLY_NAME = /<friendlyName>([^<]*)<\/friendlyName>/;
/**
 * The SSDP search target. Every UPnP root device must answer `upnp:rootdevice`
 * with exactly one response (UPnP Device Architecture spec), so no Yamaha model
 * is missed for advertising a device type other than MediaRenderer, and there is
 * no `ssdp:all` duplicate storm. Correctness is guaranteed by the manufacturer
 * filter on the fetched description, not by the search target.
 */
const ROOT_DEVICE = "upnp:rootdevice";
/** How long to collect SSDP responses. */
const SEARCH_TIMEOUT_MS = 5000;

/** A device found on the network. */
export interface DiscoveredDevice {
  /** The device IP. */
  ip: string;
  /** The device's friendly name (empty if it advertises none). */
  name: string;
}

/** Dependencies for discovery — an SSDP search and an HTTP fetch, both injectable for tests. */
export interface DiscoveryDeps {
  /** Run an SSDP M-SEARCH and resolve the responders' description URL and address. */
  search(target: string, timeoutMs: number): Promise<Array<{ location: string; address: string }>>;
  /** Fetch a device description URL and resolve its body. */
  fetch(url: string): Promise<string>;
  /** Logger for diagnostics. */
  log: { debug(message: string): void; warn(message: string): void };
}

/**
 * Recognise a Yamaha device from its UPnP description XML.
 *
 * @param xml the device description body
 * @returns the friendly name if it is a Yamaha device, otherwise undefined
 */
export function parseYamahaDescription(xml: string): { name: string } | undefined {
  if (!YAMAHA_MANUFACTURER.test(xml)) {
    return undefined;
  }
  const match = FRIENDLY_NAME.exec(xml);
  return { name: match ? match[1] : "" };
}

/**
 * Discover Yamaha devices on the local network: SSDP-search for UPnP root devices,
 * fetch each responder's description, and keep the ones made by Yamaha. Duplicate
 * addresses and unreachable descriptions are skipped.
 *
 * @param deps the SSDP search, HTTP fetch, and logger
 * @returns the discovered Yamaha devices
 */
export async function discoverYamaha(deps: DiscoveryDeps): Promise<DiscoveredDevice[]> {
  const found = await deps.search(ROOT_DEVICE, SEARCH_TIMEOUT_MS);
  // Deduplicate BEFORE fetching, not after. `upnp:rootdevice` is answered by EVERY UPnP
  // device on the network, the search repeats its request (multicast is lossy) and it
  // leaves every interface — so the same address arrives several times over. Deduplicating
  // only the Yamaha hits, as this did before, meant every television, printer and speaker
  // in the house had its description fetched once per answer.
  const byAddress = new Map<string, string>();
  for (const { location, address } of found) {
    if (!byAddress.has(address)) {
      byAddress.set(address, location);
    }
  }
  // Fetch in parallel: an address that does not answer costs its timeout ONCE instead of
  // delaying every address behind it — the whole adapter start waits on this.
  const probed = await Promise.all(
    [...byAddress].map(async ([address, location]): Promise<DiscoveredDevice | undefined> => {
      try {
        const yamaha = parseYamahaDescription(await deps.fetch(location));
        return yamaha ? { ip: address, name: yamaha.name } : undefined;
      } catch (e) {
        deps.log.debug(`discovery: ${address} description fetch failed: ${errorMessage(e)}`);
        return undefined;
      }
    }),
  );
  return probed.filter((device): device is DiscoveredDevice => device !== undefined);
}

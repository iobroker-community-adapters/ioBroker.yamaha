import { errorMessage } from "./util";

const YAMAHA_MANUFACTURER = /<manufacturer>[^<]*yamaha[^<]*<\/manufacturer>/i;
const FRIENDLY_NAME = /<friendlyName>([^<]*)<\/friendlyName>/;
/** The UPnP device type networked Yamaha devices advertise. */
const MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";
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
 * Discover Yamaha devices on the local network: SSDP-search for MediaRenderers,
 * fetch each responder's description, and keep the ones made by Yamaha. Duplicate
 * addresses and unreachable descriptions are skipped.
 *
 * @param deps the SSDP search, HTTP fetch, and logger
 * @returns the discovered Yamaha devices
 */
export async function discoverYamaha(deps: DiscoveryDeps): Promise<DiscoveredDevice[]> {
  const found = await deps.search(MEDIA_RENDERER, SEARCH_TIMEOUT_MS);
  const devices: DiscoveredDevice[] = [];
  const seen = new Set<string>();
  for (const { location, address } of found) {
    if (seen.has(address)) {
      continue;
    }
    try {
      const description = await deps.fetch(location);
      const yamaha = parseYamahaDescription(description);
      if (yamaha) {
        devices.push({ ip: address, name: yamaha.name });
        seen.add(address);
      }
    } catch (e) {
      deps.log.debug(`discovery: ${address} description fetch failed: ${errorMessage(e)}`);
    }
  }
  return devices;
}

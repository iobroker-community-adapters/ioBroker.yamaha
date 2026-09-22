import { identityFrom, macFromUdn, type DeviceIdentity } from "./device-identity";
import { errorMessage } from "./util";

const YAMAHA_MANUFACTURER = /<manufacturer>[^<]*yamaha[^<]*<\/manufacturer>/i;
const FRIENDLY_NAME = /<friendlyName>([^<]*)<\/friendlyName>/;
const MODEL_NAME = /<modelName>([^<]*)<\/modelName>/;
const SERIAL_NUMBER = /<serialNumber>([^<]*)<\/serialNumber>/;
const UDN = /<UDN>([^<]*)<\/UDN>/;
/**
 * The two control services a Yamaha description lists in `yamaha:X_serviceList`: MusicCast
 * (`X_YamahaExtendedControl`) and the XML/YNC control (`X_YamahaRemoteControl`). YNCA is a raw
 * TCP port (50000) and appears nowhere in the description — it is always tried.
 */
const SERVICE_YXC = /X_YamahaExtendedControl/;
const SERVICE_XML = /X_YamahaRemoteControl/;
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

/** Which of the two HTTP control protocols a device advertises in its UPnP description. */
export interface DeviceServices {
  /** MusicCast / YXC (`X_YamahaExtendedControl`). */
  yxc: boolean;
  /** XML / YNC (`X_YamahaRemoteControl`). */
  xml: boolean;
}

/** A device found on the network. */
export interface DiscoveredDevice {
  /** The device IP. */
  ip: string;
  /** The device's friendly name (empty if it advertises none). */
  name: string;
  /** The model name the description carries (`RX-V6A`). */
  model?: string;
  /** Serial and MAC — the identity that survives a rename and a new address. */
  identity?: DeviceIdentity;
  /** The control services the description advertises. */
  services?: DeviceServices;
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
 * Recognise a Yamaha device from its UPnP description XML and keep what it says about itself:
 * the friendly name (the object id is derived from it), the model, the serial and MAC (its
 * identity for life), and which control services it speaks. Everything but the name is
 * optional — an older description may carry none of it.
 *
 * @param xml the device description body
 * @returns what the description says, or undefined for a non-Yamaha device
 */
export function parseYamahaDescription(
  xml: string,
): { name: string; model?: string; identity?: DeviceIdentity; services: DeviceServices } | undefined {
  if (!YAMAHA_MANUFACTURER.test(xml)) {
    return undefined;
  }
  const name = FRIENDLY_NAME.exec(xml)?.[1] ?? "";
  const model = MODEL_NAME.exec(xml)?.[1]?.trim();
  const udn = UDN.exec(xml)?.[1];
  const identity = identityFrom({ serial: SERIAL_NUMBER.exec(xml)?.[1], mac: udn ? macFromUdn(udn) : undefined });
  return {
    name,
    ...(model ? { model } : {}),
    ...(identity ? { identity } : {}),
    services: { yxc: SERVICE_YXC.test(xml), xml: SERVICE_XML.test(xml) },
  };
}

/**
 * Fetch one responder's description and keep it when it is a Yamaha device. Shared by the
 * active search and the passive NOTIFY listener — both learn of a device the same way.
 *
 * @param deps the HTTP fetch and logger
 * @param location the description URL the device announced
 * @param address the address it announced from
 * @returns the device, or undefined (not Yamaha, or the description could not be read)
 */
export async function probeDescription(
  deps: Pick<DiscoveryDeps, "fetch" | "log">,
  location: string,
  address: string,
): Promise<DiscoveredDevice | undefined> {
  try {
    const yamaha = parseYamahaDescription(await deps.fetch(location));
    return yamaha ? { ip: address, ...yamaha } : undefined;
  } catch (e) {
    deps.log.debug(`discovery: ${address} description fetch failed: ${errorMessage(e)}`);
    return undefined;
  }
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
    [...byAddress].map(([address, location]) => probeDescription(deps, location, address)),
  );
  return probed.filter((device): device is DiscoveredDevice => device !== undefined);
}

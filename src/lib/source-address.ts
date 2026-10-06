import { carriesAddress, chosenAddress, localNets } from "./network-address";

/**
 * The address this instance listens, sends and connects on — the one the user picked in the instance settings
 * (`networkInterface`, jsonConfig `type: "ip"`), or undefined for every address (krobi 2026-10-03, round 87 as the fleet
 * rule). What "every address" is and whether the host carries one stands in the fleet master (`network-address.ts`);
 * this module only keeps the decision of this start for the clients that open connections deep in the protocol layers.
 */
let current: string | undefined;

/**
 * Decide the address for this start. A chosen address the host does not carry falls back to every address — the
 * caller says so in exactly one warning.
 *
 * @param setting the stored setting
 * @param nets the host's networks (read fresh when not given)
 * @returns the address to use (undefined = every address) and the chosen one the host lacks, if any
 */
export function decideSourceAddress(
  setting: unknown,
  nets = localNets(),
): { address: string | undefined; missing: string | undefined } {
  const chosen = chosenAddress(setting);
  const missing = chosen !== undefined && !carriesAddress(chosen, nets) ? chosen : undefined;
  current = missing === undefined ? chosen : undefined;
  return { address: current, missing };
}

/**
 * The address decided for this start.
 *
 * @returns the address, or undefined for every address
 */
export function sourceAddress(): string | undefined {
  return current;
}

/**
 * The connect/request option that pins a connection to the decided address — empty for every address.
 *
 * @returns `{ localAddress }` or `{}`
 */
export function localAddressOption(): { localAddress?: string } {
  return current === undefined ? {} : { localAddress: current };
}

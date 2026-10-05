import type { StateValue } from "../types";
import { clientAddresses } from "./lists";

/**
 * A device's part in a MusicCast Link group, from getDistributionInfo (YXC Advanced §5.1). Parsers only — split out of
 * the command mapper, which did five jobs (review 2026-10-05, SOLID).
 */

/**
 * Parse a getDistributionInfo response into the multiroom group states.
 *
 * @param info the getDistributionInfo response object
 * @returns the dist state updates, or an empty list if malformed
 */
export function parseYxcDistribution(info: unknown): StateValue[] {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const d = info as Record<string, unknown>;
  const updates: StateValue[] = [];
  const summary = distributionSummary(info);
  if (typeof d.role === "string") {
    updates.push({ id: "multiroom.group.role", value: summary.role });
    // Only a server reports a construction state (Advanced §5.1) — none, not a word outside the list.
    updates.push({ id: "multiroom.group.status", value: summary.status ?? null });
  }
  if (typeof d.group_id === "string") {
    updates.push({ id: "multiroom.group.id", value: d.group_id });
  }
  if (typeof d.group_name === "string") {
    updates.push({ id: "multiroom.group.name", value: d.group_name });
  }
  if (typeof d.server_zone === "string") {
    updates.push({ id: "multiroom.group.serverZone", value: d.server_zone });
  }
  if (Array.isArray(d.client_list)) {
    updates.push({ id: "multiroom.group.linkedDevices", value: JSON.stringify(d.client_list) });
  }
  return updates;
}

/** What a getDistributionInfo answer says about a device's part in a MusicCast group. */
export interface DistributionSummary {
  /** The effective role: server, client or none (see {@link distributionSummary}). */
  role: string;
  /** The group id, "" when none. */
  groupId: string;
  /** Whether the group id names a group (not empty, not all zeros). */
  inGroup: boolean;
  /** The clients' IPv4 addresses (a server's roster). */
  clients: string[];
  /** The zone the server distributes. */
  serverZone: string;
  /** Building / working / deleting — reported for a server from API 2.00 on; undefined otherwise. */
  status?: string;
}

/**
 * Read a device's part in a group the way YXC Advanced asks for it: a device with a group id and a
 * client list is the server even while it answers "none" (§9.2), and one without a group id is in no
 * group even while it answers "client" (§9.1.7-5 — any zone on the MusicCast Link input says so).
 * The role word alone flickered; the leave path read it and sent a server's clean-up to a client
 * (audit 2026-09-24, C7).
 *
 * @param info the getDistributionInfo answer
 * @returns the summary
 */
export function distributionSummary(info: unknown): DistributionSummary {
  const d = typeof info === "object" && info !== null ? (info as Record<string, unknown>) : {};
  const groupId = typeof d.group_id === "string" ? d.group_id : "";
  const inGroup = /[1-9a-f]/i.test(groupId);
  // The one read of the roster (`lists.ts`) — the slot datapoints take the same list (review 2026-10-05, DRY).
  const clients = (clientAddresses(info) ?? []).filter((ip): ip is string => ip !== undefined);
  const reported = typeof d.role === "string" ? d.role : "none";
  const role = inGroup && clients.length > 0 ? "server" : !inGroup && reported === "client" ? "none" : reported;
  const status = role === "server" && typeof d.status === "string" ? d.status.trim() : undefined;
  return {
    role,
    groupId,
    inGroup,
    clients,
    serverZone: typeof d.server_zone === "string" ? d.server_zone : "main",
    ...(status !== undefined ? { status } : {}),
  };
}

import { identityFrom, mergeIdentity, type DeviceIdentity } from "./device-identity";
import { XmlClient } from "./xml/xml-client";
import type { XmlSystemConfig } from "./xml/protocol";
import { YamahaYxcClient } from "./yxc/http-client";
import type { CommandGate, CommandGateTimers } from "./lifecycle/command-gate";
import { LIVE_GATES } from "./lifecycle/gate-registry";

/** What a device says about itself when asked before it is added. */
export interface DeviceSelfReport {
  /** The model it reports. */
  model?: string;
  /** Its serial/MAC. */
  identity?: DeviceIdentity;
}

/** The two questions {@link identifyDevice} asks — injectable for tests. */
export interface IdentifyDeps {
  /** MusicCast `getDeviceInfo` (model_name, system_id = serial, device_id = MAC). */
  yxcDeviceInfo(ip: string): Promise<unknown>;
  /** XML `System > Config` (Model_Name, System_ID = serial). */
  xmlSystemConfig(ip: string): Promise<XmlSystemConfig>;
}

/**
 * The timers of a gate that asks ONE question of a device no connection runs to: a fresh gate without spacing sends
 * its first request at once and schedules nothing (and no client calls its delay), so it needs no timer — a native
 * one would outlive onUnload. Should that ever change, the question fails loudly instead of hanging.
 */
export const ONE_QUESTION: CommandGateTimers = {
  schedule: () => {
    throw new Error("a gate for one question schedules nothing");
  },
  cancel: () => undefined,
};

/**
 * The gate a question to a device goes through (Y-15): the running connection's when the address runs — the search
 * may have found the device being added — else one of its own. Ungated, the question went out in parallel to the
 * running connection's own traffic (review 2026-10-05, A13).
 *
 * @param transport the protocol asked
 * @param ip the device's address
 * @returns the gate
 */
function gateFor(transport: "yxc" | "xml", ip: string): CommandGate {
  return LIVE_GATES.gateFor(transport, ip, ONE_QUESTION);
}

/** The real questions, over the adapter's own clients (4 s / 5 s timeouts), each through the device's gate. */
export const DEFAULT_IDENTIFY_DEPS: IdentifyDeps = {
  yxcDeviceInfo: ip => new YamahaYxcClient(ip, undefined, gateFor("yxc", ip)).getDeviceInfo(),
  xmlSystemConfig: ip => new XmlClient(ip, undefined, gateFor("xml", ip)).getSystemConfig(),
};

/**
 * Ask a device who it is — the two protocols that carry a serial, in parallel. A device added by
 * hand gets its id from the answer (`deviceIdFor`); a device that answers neither (switched off,
 * or YNCA only) returns nothing and is given its id from the typed name, until its first contact
 * tells more.
 *
 * @param ip the address the user typed
 * @param deps the two questions
 * @returns what the device reported (empty when it answered neither)
 */
export async function identifyDevice(
  ip: string,
  deps: IdentifyDeps = DEFAULT_IDENTIFY_DEPS,
): Promise<DeviceSelfReport> {
  const [yxc, xml] = await Promise.allSettled([deps.yxcDeviceInfo(ip), deps.xmlSystemConfig(ip)]);
  const info =
    yxc.status === "fulfilled"
      ? (yxc.value as { model_name?: unknown; system_id?: unknown; device_id?: unknown } | null)
      : null;
  const config = xml.status === "fulfilled" ? xml.value : undefined;
  const yxcModel = typeof info?.model_name === "string" && info.model_name.trim() ? info.model_name.trim() : undefined;
  const model = yxcModel ?? config?.model?.trim() ?? undefined;
  const identity = mergeIdentity(
    identityFrom({ serial: config?.systemId }),
    identityFrom({ serial: info?.system_id, mac: info?.device_id }),
  );
  return { ...(model ? { model } : {}), ...(identity ? { identity } : {}) };
}

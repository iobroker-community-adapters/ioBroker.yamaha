import { identityFrom, mergeIdentity, type DeviceIdentity } from "./device-identity";
import { XmlClient } from "./xml/xml-client";
import type { XmlSystemConfig } from "./xml/protocol";
import { YamahaYxcClient } from "./yxc/http-client";

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

/** The real questions, over the adapter's own clients (4 s / 5 s timeouts). */
export const DEFAULT_IDENTIFY_DEPS: IdentifyDeps = {
  yxcDeviceInfo: ip => new YamahaYxcClient(ip).getDeviceInfo(),
  xmlSystemConfig: ip => new XmlClient(ip).getSystemConfig(),
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

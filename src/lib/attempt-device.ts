import { YncaClient } from "./ynca/ynca-client";
import { YncaDeviceController } from "./device-controller";
import { YxcDeviceController } from "./yxc/device-controller";
import { YamahaYxcClient } from "./yxc/http-client";
import { XmlDeviceController } from "./xml/device-controller";
import { XmlClient } from "./xml/xml-client";
import { errorMessage } from "./util";
import type { ConnectionHandle, ControllerLog } from "./controller";
import type { ObjectDef } from "./catalog/types";
import type { DeviceRecord } from "./types";

/** The adapter-bound callbacks {@link attemptDevice} drives — injected so it needs no adapter. */
export interface AttemptDeps {
  /** Adapter log. */
  log: ControllerLog;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter-managed timers for the YNCA client. */
  timers: {
    /** Schedule a one-shot timer. */
    schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
    /** Cancel a scheduled timer. */
    cancel(handle: ioBroker.Timeout | undefined): void;
  };
  /** Register a YXC push handler for a device IP; returns a function that unregisters it. */
  registerPush(ip: string, onPush: (event: unknown) => void): () => void;
  /** Schedule a repeating keepalive; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
}

/**
 * Bring one device online across its transports, tried in order: YNCA (amp control
 * over a held TCP connection), then YXC (MusicCast), then XML/YNC (pre-2010). Returns
 * the transport controller that connected — each implements {@link ConnectionHandle},
 * so it is returned directly — or null when no transport answers this attempt. The
 * transport that connects owns the device's object tree, so the mappers never collide.
 *
 * @param device the configured device record
 * @param deps the adapter-bound callbacks
 * @returns a connection handle, or null when no transport connected
 */
export async function attemptDevice(device: DeviceRecord, deps: AttemptDeps): Promise<ConnectionHandle | null> {
  const { log, upsertObject, setStateAck, timers } = deps;

  // 1) YNCA — amp control over a held TCP connection; a socket drop reconnects
  //    through the supervisor.
  const yncaClient = new YncaClient(device.ip, timers);
  const ynca = new YncaDeviceController(device.id, { client: yncaClient, upsertObject, setStateAck, log });
  try {
    if (await ynca.start()) {
      return ynca;
    }
    ynca.close();
  } catch (e) {
    ynca.close();
    log.debug(`${device.id}: no YNCA (${errorMessage(e)})`);
  }

  // 2) YXC fallback — MusicCast; polled + push. No socket-drop event, so the
  //    controller reports a drop after a run of failed keepalive polls.
  const yxc = new YxcDeviceController(device.id, {
    client: new YamahaYxcClient(device.ip),
    registerPush: onPush => deps.registerPush(device.ip, onPush),
    scheduleKeepalive: deps.scheduleKeepalive,
    upsertObject,
    setStateAck,
    log,
  });
  try {
    if (await yxc.start()) {
      return yxc;
    }
    yxc.close();
  } catch (e) {
    yxc.close();
    log.debug(`${device.id}: no YXC (${errorMessage(e)})`);
  }

  // 3) XML/YNC fallback — pre-2010 receivers; polled. A drop is reported after a
  //    run of failed polls.
  const xml = new XmlDeviceController(device.id, {
    client: new XmlClient(device.ip),
    scheduleKeepalive: deps.scheduleKeepalive,
    upsertObject,
    setStateAck,
    log,
  });
  try {
    if (await xml.start()) {
      return xml;
    }
    xml.close();
  } catch (e) {
    xml.close();
    log.warn(`${device.id}: no reachable transport (YNCA/YXC/XML): ${errorMessage(e)}`);
  }
  return null;
}

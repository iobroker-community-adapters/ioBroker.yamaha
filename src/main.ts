import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { YamahaYXC } from "yamaha-yxc-nodejs";
import { legacyDeviceRow, parseDevices, stripNamespace } from "./lib/pure-helpers";
import { discoverYamaha } from "./lib/discovery";
import { YncaClient } from "./lib/ynca/ynca-client";
import { YncaDeviceController } from "./lib/device-controller";
import { YxcDeviceController } from "./lib/yxc/device-controller";
import { YxcPushReceiver } from "./lib/yxc/push-receiver";
import { XmlDeviceController } from "./lib/xml/device-controller";
import { XmlClient } from "./lib/xml/xml-client";
import type { ObjectDef } from "./lib/catalog/types";
import type { DeviceRecord } from "./lib/types";
import { DeviceSupervisor, type ConnectionHandle } from "./lib/lifecycle/device-supervisor";
import { ReconnectStrategy } from "./lib/lifecycle/reconnect-strategy";

/** Supervisor reconnect backoff bounds (exponential: 1s, 2s … capped at 60s). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/**
 * ioBroker.yamaha — controls Yamaha AV receivers and MusicCast devices.
 *
 * Each configured device is driven by a supervisor that keeps one transport
 * controller online, tried in order: YNCA (amp control over a held TCP
 * connection, event-pushed), then YXC (MusicCast speakers and soundbars), then
 * XML/YNC (pre-2010 receivers, polled over HTTP). All YXC devices share one UDP
 * push receiver, keyed by source IP.
 */
export class Yamaha extends utils.Adapter {
  private readonly supervisors: DeviceSupervisor[] = [];
  private readonly deviceConnected = new Map<string, boolean>();
  private pushReceiver: YxcPushReceiver | undefined;

  /**
   * @param options adapter options passed through by js-controller
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "yamaha",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Start a supervisor for each configured device, then subscribe to state changes. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      const devices = parseDevices(this.config.devices);
      this.subscribeStates("*");
      const pushReceiver = new YxcPushReceiver({
        debug: message => this.log.debug(message),
        warn: message => this.log.warn(message),
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      // One supervisor per device: it keeps retrying until a transport connects and
      // reconnects on a drop, so a device that is off at start joins on its own.
      for (const device of devices) {
        this.deviceConnected.set(device.id, false);
        const supervisor = new DeviceSupervisor({
          attempt: () => this.attemptDevice(device, pushReceiver),
          schedule: (cb, ms) => this.setTimeout(cb, ms),
          cancel: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
          onConnectionChange: connected => this.reportConnection(device.id, connected),
          backoff: new ReconnectStrategy(RECONNECT_BASE_MS, RECONNECT_MAX_MS),
          log: {
            debug: message => this.log.debug(message),
            info: message => this.log.info(message),
            warn: message => this.log.warn(message),
          },
        });
        this.supervisors.push(supervisor);
        supervisor.start();
      }
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Aggregate one device's connection state into the adapter's `info.connection`
   * (true while at least one device is connected).
   *
   * @param deviceId the device reporting
   * @param connected whether that device is currently connected
   */
  private reportConnection(deviceId: string, connected: boolean): void {
    this.deviceConnected.set(deviceId, connected);
    const anyConnected = [...this.deviceConnected.values()].some(Boolean);
    void this.setState("info.connection", { val: anyConnected, ack: true });
  }

  /**
   * Carry over the previous adapter's single-device config into the device table.
   * The old yamaha stored one receiver as `config.ip` (older installs: `config.IP`);
   * the new adapter uses a `devices` table, so an upgraded instance would otherwise
   * start with an empty table and lose its receiver. Persists the row so the admin
   * table shows it, and fills `this.config` in memory so this run already drives it.
   */
  private async migrateLegacyDevice(): Promise<void> {
    const config = this.config as unknown as Record<string, unknown>;
    const row = legacyDeviceRow(config);
    if (!row) {
      return;
    }
    // Fill the in-memory config first, so this run already drives the device even
    // if persisting the table below fails — persistence is a convenience for the
    // admin view, not a precondition for running.
    config.devices = [row];
    try {
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { devices: [row] } });
      this.log.info(`carried the previous single-device config (${row.ip}) over into the device table`);
    } catch (e) {
      this.log.warn(
        `could not persist the migrated device table (${e instanceof Error ? e.message : String(e)}); ` +
          `running with the in-memory value`,
      );
    }
  }

  /**
   * Bring one device online across its transports, tried in order: YNCA (amp
   * control over a held TCP connection), then YXC (MusicCast), then XML/YNC
   * (pre-2010). Returns a connection handle the supervisor keeps, or null when no
   * transport answers this attempt. The transport that connects owns the device's
   * object tree, so the mappers never collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @returns a connection handle, or null when no transport connected
   */
  private async attemptDevice(device: DeviceRecord, pushReceiver: YxcPushReceiver): Promise<ConnectionHandle | null> {
    const log = {
      debug: (message: string): void => this.log.debug(message),
      info: (message: string): void => this.log.info(message),
      warn: (message: string): void => this.log.warn(message),
    };
    const upsertObject = async (id: string, def: ObjectDef): Promise<void> => {
      await this.extendObject(id, { type: def.type, common: def.common, native: {} });
    };
    const setStateAck = (id: string, value: boolean | number | string): void =>
      void this.setState(id, { val: value, ack: true });
    const timers = {
      schedule: (handler: () => void, ms: number): ioBroker.Timeout | undefined => this.setTimeout(handler, ms),
      cancel: (handle: ioBroker.Timeout | undefined): void => this.clearTimeout(handle),
    };

    // 1) YNCA — amp control over a held TCP connection; a socket drop reconnects
    //    through the supervisor (the client no longer reconnects on its own).
    const yncaClient = new YncaClient(device.ip, timers);
    const ynca = new YncaDeviceController(device.id, { client: yncaClient, upsertObject, setStateAck, log });
    try {
      if (await ynca.start()) {
        return {
          onDrop: cb => yncaClient.onDrop(cb),
          handleStateChange: (id, ack, value) => ynca.handleStateChange(id, ack, value),
          close: () => ynca.close(),
        };
      }
      ynca.close();
    } catch (e) {
      ynca.close();
      this.log.debug(`${device.id}: no YNCA (${e instanceof Error ? e.message : String(e)})`);
    }

    // 2) YXC fallback — MusicCast; polled + push, no socket-drop event (no-op onDrop,
    //    the keepalive poll recovers on its own).
    const yxc = new YxcDeviceController(device.id, {
      client: new YamahaYXC(device.ip),
      registerPush: onPush => pushReceiver.register(device.ip, onPush),
      scheduleKeepalive: (handler, ms) => {
        const timer = this.setInterval(handler, ms);
        return () => {
          if (timer) {
            this.clearInterval(timer);
          }
        };
      },
      upsertObject,
      setStateAck,
      log,
    });
    try {
      if (await yxc.start()) {
        return {
          onDrop: () => {},
          handleStateChange: (id, ack, value) => yxc.handleStateChange(id, ack, value),
          close: () => yxc.close(),
        };
      }
      yxc.close();
    } catch (e) {
      yxc.close();
      this.log.debug(`${device.id}: no YXC (${e instanceof Error ? e.message : String(e)})`);
    }

    // 3) XML/YNC fallback — pre-2010 receivers; polled, no drop event.
    const xml = new XmlDeviceController(device.id, {
      client: new XmlClient(device.ip),
      scheduleKeepalive: (handler, ms) => {
        const timer = this.setInterval(handler, ms);
        return () => {
          if (timer) {
            this.clearInterval(timer);
          }
        };
      },
      upsertObject,
      setStateAck,
      log,
    });
    try {
      if (await xml.start()) {
        return {
          onDrop: () => {},
          handleStateChange: (id, ack, value) => xml.handleStateChange(id, ack, value),
          close: () => xml.close(),
        };
      }
      xml.close();
    } catch (e) {
      xml.close();
      this.log.warn(
        `${device.id}: no reachable transport (YNCA/YXC/XML): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }

  /**
   * Route a state change to every device's supervisor (each forwards to its
   * active controller, which ignores ids outside its subtree and its acked echoes).
   *
   * @param id the full state id
   * @param state the new state (null when deleted)
   */
  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state) {
      return;
    }
    const relative = stripNamespace(id, this.namespace);
    for (const supervisor of this.supervisors) {
      supervisor.handleStateChange(relative, state.ack, state.val);
    }
  }

  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      this.pushReceiver?.close();
      for (const supervisor of this.supervisors) {
        supervisor.close();
      }
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch {
      callback();
    }
  }

  /**
   * Handle an admin message: `discover` scans the network for Yamaha devices and
   * returns the configured plus discovered devices (deduped by IP) for the table.
   *
   * @param obj the incoming message
   */
  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (obj.command !== "discover") {
      return;
    }
    try {
      const found = await discoverYamaha({
        search: (target, ms) => this.ssdpSearch(target, ms),
        fetch: url => this.fetchUrl(url),
        log: { debug: message => this.log.debug(message), warn: message => this.log.warn(message) },
      });
      const devices = parseDevices(this.config.devices).map(device => ({ name: device.id, ip: device.ip }));
      for (const device of found) {
        if (!devices.some(existing => existing.ip === device.ip)) {
          devices.push({ name: device.name || device.ip, ip: device.ip });
        }
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { native: { devices } }, obj.callback);
      }
    } catch (e) {
      this.log.warn(`discover failed: ${e instanceof Error ? e.message : String(e)}`);
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: "discover failed" }, obj.callback);
      }
    }
  }

  /**
   * Run an SSDP M-SEARCH and collect the responders' description URL and address.
   *
   * @param target the search target (device type)
   * @param timeoutMs how long to collect responses
   * @returns the responders
   */
  private ssdpSearch(target: string, timeoutMs: number): Promise<Array<{ location: string; address: string }>> {
    return new Promise(resolve => {
      const socket = createSocket("udp4");
      const responders: Array<{ location: string; address: string }> = [];
      socket.on("message", (msg, rinfo) => {
        const location = /LOCATION:\s*(\S+)/i.exec(msg.toString());
        if (location) {
          responders.push({ location: location[1], address: rinfo.address });
        }
      });
      socket.on("error", () => socket.close());
      socket.bind(() => {
        const msearch = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ${target}\r\n\r\n`;
        socket.send(msearch, 1900, "239.255.255.250");
      });
      this.setTimeout(() => {
        socket.close();
        resolve(responders);
      }, timeoutMs);
    });
  }

  /**
   * Fetch a URL over HTTP and resolve its body.
   *
   * @param url the URL to fetch
   * @returns the response body
   */
  private fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      httpGet(url, res => {
        let data = "";
        res.on("data", chunk => (data += String(chunk)));
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Yamaha(options);
} else {
  // Start the instance directly
  (() => new Yamaha())();
}

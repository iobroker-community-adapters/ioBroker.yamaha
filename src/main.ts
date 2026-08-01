import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { YamahaYXC } from "yamaha-yxc-nodejs";
import { orphanedObjects, parseDevices, stripNamespace } from "./lib/pure-helpers";
import { discoverYamaha } from "./lib/discovery";
import { YncaClient } from "./lib/ynca/ynca-client";
import { YncaDeviceController } from "./lib/device-controller";
import { YxcDeviceController } from "./lib/yxc/device-controller";
import { YxcPushReceiver } from "./lib/yxc/push-receiver";
import { XmlDeviceController } from "./lib/xml/device-controller";
import { XmlClient } from "./lib/xml/xml-client";
import type { ObjectDef } from "./lib/capability-mapper";
import type { DeviceController, DeviceRecord } from "./lib/types";

/** Zones swept for their amplifier functions. */
const SWEEP_ZONES = ["MAIN", "ZONE2", "ZONE3", "ZONE4"];
/** Amplifier functions queried per zone. */
const SWEEP_FUNCS = ["PWR", "VOL", "MUTE", "INP", "SOUNDPRG"];
/** The init-sweep gets: model name plus each zone's amplifier functions. */
const SWEEP_GETS = [
  { subunit: "SYS", func: "MODELNAME" },
  ...SWEEP_ZONES.flatMap(zone => SWEEP_FUNCS.map(func => ({ subunit: zone, func }))),
];

/**
 * ioBroker.yamaha — controls Yamaha AV receivers and MusicCast devices.
 *
 * Each configured device is driven by one controller, tried in order: YNCA (amp
 * control over a held TCP connection, event-pushed), then YXC (MusicCast speakers
 * and soundbars), then XML/YNC (pre-2010 receivers, polled over HTTP). All YXC
 * devices share one UDP push receiver, keyed by source IP.
 */
export class Yamaha extends utils.Adapter {
  private readonly controllers: DeviceController[] = [];
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

  /** Start a controller for each configured device, then subscribe to state changes. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      const devices = parseDevices(this.config.devices);
      this.subscribeStates("*");
      const pushReceiver = new YxcPushReceiver({
        debug: message => this.log.debug(message),
        warn: message => this.log.warn(message),
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      const createdIds = new Set<string>([`${this.namespace}.info`, `${this.namespace}.info.connection`]);
      let anyConnected = false;
      for (const device of devices) {
        if (await this.startDevice(device, pushReceiver, createdIds)) {
          anyConnected = true;
        }
      }
      await this.setState("info.connection", { val: anyConnected, ack: true });
      await this.cleanupOrphans(createdIds);
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * One-shot migration/cleanup: remove objects not created this run (the previous
   * adapter's tree and dropped devices), deepest first so parents go last.
   *
   * @param createdIds the ids created this run, including parent paths
   */
  private async cleanupOrphans(createdIds: Set<string>): Promise<void> {
    const existing = Object.keys(await this.getAdapterObjectsAsync());
    const orphans = orphanedObjects(existing, createdIds, this.namespace).sort((a, b) => b.length - a.length);
    for (const id of orphans) {
      try {
        await this.delObjectAsync(stripNamespace(id, this.namespace));
      } catch {
        // already removed with its parent
      }
    }
    if (orphans.length > 0) {
      this.log.info(`cleaned up ${orphans.length} object(s) from a previous configuration`);
    }
  }

  /**
   * Bring one device online: try YNCA (amp control), else fall back to YXC
   * (MusicCast). The transport that connects owns the device's object tree, so
   * the two mappers never collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @param createdIds collects the object ids created this run, for orphan cleanup
   * @returns true if a transport connected
   */
  private async startDevice(
    device: DeviceRecord,
    pushReceiver: YxcPushReceiver,
    createdIds: Set<string>,
  ): Promise<boolean> {
    const log = {
      debug: (message: string): void => this.log.debug(message),
      info: (message: string): void => this.log.info(message),
      warn: (message: string): void => this.log.warn(message),
    };
    const upsertObject = async (id: string, def: ObjectDef): Promise<void> => {
      const parts = id.split(".");
      for (let i = 1; i <= parts.length; i++) {
        createdIds.add(`${this.namespace}.${parts.slice(0, i).join(".")}`);
      }
      await this.extendObject(id, { type: def.type, common: def.common, native: {} });
    };
    const setStateAck = (id: string, value: boolean | number | string): void =>
      void this.setState(id, { val: value, ack: true });
    const timers = {
      schedule: (handler: () => void, ms: number): ioBroker.Timeout | undefined => this.setTimeout(handler, ms),
      cancel: (handle: ioBroker.Timeout | undefined): void => this.clearTimeout(handle),
    };

    // 1) YNCA — amp control over a held TCP connection.
    const ynca = new YncaDeviceController(device.id, {
      client: new YncaClient(device.ip, timers),
      upsertObject,
      setStateAck,
      log,
    });
    try {
      if (await ynca.start(SWEEP_GETS)) {
        this.controllers.push(ynca);
        return true;
      }
      ynca.close();
    } catch (e) {
      ynca.close();
      this.log.debug(`${device.id}: no YNCA (${e instanceof Error ? e.message : String(e)})`);
    }

    // 2) YXC fallback — MusicCast speakers/soundbars without YNCA.
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
        this.controllers.push(yxc);
        return true;
      }
      yxc.close();
    } catch (e) {
      yxc.close();
      this.log.debug(`${device.id}: no YXC (${e instanceof Error ? e.message : String(e)})`);
    }

    // 3) XML/YNC fallback — pre-2010 receivers that speak neither YNCA nor YXC.
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
        this.controllers.push(xml);
        return true;
      }
      xml.close();
    } catch (e) {
      xml.close();
      this.log.warn(
        `${device.id}: no reachable transport (YNCA/YXC/XML): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return false;
  }

  /**
   * Route a state change to every device controller (each ignores ids outside
   * its own subtree and its own acked echoes).
   *
   * @param id the full state id
   * @param state the new state (null when deleted)
   */
  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state) {
      return;
    }
    const relative = stripNamespace(id, this.namespace);
    for (const controller of this.controllers) {
      controller.handleStateChange(relative, state.ack, state.val);
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
      for (const controller of this.controllers) {
        controller.close();
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

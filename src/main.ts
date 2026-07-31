import * as utils from "@iobroker/adapter-core";
import { parseDevices, stripNamespace } from "./lib/pure-helpers";
import { YncaClient } from "./lib/ynca/ynca-client";
import { YncaDeviceController } from "./lib/device-controller";

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
 * Each configured device is driven by a controller (YNCA transport for now):
 * connect, init sweep, unified object tree, and command dispatch both ways.
 */
export class Yamaha extends utils.Adapter {
  private readonly controllers: YncaDeviceController[] = [];

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
    this.on("unload", this.onUnload.bind(this));
  }

  /** Start a controller for each configured device, then subscribe to state changes. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      const devices = parseDevices(this.config.devices);
      this.subscribeStates("*");
      let anyConnected = false;
      for (const device of devices) {
        const controller = new YncaDeviceController(device.id, {
          client: new YncaClient(device.ip),
          upsertObject: async (id, def) => {
            await this.extendObject(id, { type: def.type, common: def.common, native: {} });
          },
          setStateAck: (id, value) => void this.setState(id, { val: value, ack: true }),
          log: {
            debug: message => this.log.debug(message),
            info: message => this.log.info(message),
            warn: message => this.log.warn(message),
          },
        });
        this.controllers.push(controller);
        try {
          if (await controller.start(SWEEP_GETS)) {
            anyConnected = true;
          }
        } catch (e) {
          this.log.warn(`${device.id}: could not connect: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await this.setState("info.connection", { val: anyConnected, ack: true });
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Route a state change to the owning device controller.
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
      for (const controller of this.controllers) {
        controller.close();
      }
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Yamaha(options);
} else {
  // Start the instance directly
  (() => new Yamaha())();
}

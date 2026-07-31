import * as utils from "@iobroker/adapter-core";

/**
 * ioBroker.yamaha — controls Yamaha AV receivers and MusicCast devices.
 *
 * Scaffold stage: the adapter boots, exposes `info.connection` and tears down
 * cleanly. The transport clients (YNCA / YXC / XML), the command router and the
 * unified object tree are added in the following build phases.
 */
export class Yamaha extends utils.Adapter {
  /**
   * @param options adapter options passed through by js-controller
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "yamaha",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Bring the adapter up. No transports are wired yet, so connection stays false. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
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

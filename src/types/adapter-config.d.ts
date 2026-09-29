// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
import type { DeviceRow } from "../lib/pure-helpers";

declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** IP of the network interface to bind discovery to; empty (or 0.0.0.0) = all interfaces. */
      networkInterface: string;
      /** The MusicCast event port the adapter listens on (fleet listen-port standard). */
      port: number;
      /** The address that port is bound to (0.0.0.0 = all). */
      bind: string;
      /** Configured Yamaha devices — the one row type (`DeviceRow`), the object id stored since 3.0.0. */
      devices: DeviceRow[];
      /**
       * Whether the network search runs: `auto` while the device table is empty (the behaviour
       * of every installation before 2.9.0), `always` next to a filled table (mixed operation),
       * `never` not at all. Three-valued so an upgrade needs no written value to keep behaving
       * exactly as it did.
       */
      discovery: "auto" | "always" | "never";
      /** Poll interval in seconds for XML/pre-2010 devices. */
      xmlPollInterval: number;
      /** Datapoint-group switches (default on); a false one skips that group's objects. */
      group_player: boolean;
      group_tuner: boolean;
      group_multiroom: boolean;
      group_hdmi: boolean;
      group_scene: boolean;
      group_sound: boolean;
      group_advanced: boolean;
      group_clock: boolean;
    }
  }
}

export {};

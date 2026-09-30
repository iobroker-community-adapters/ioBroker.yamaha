// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
import type { DeviceRow } from "../lib/pure-helpers";

declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** IP of the network interface to bind discovery to; empty (or 0.0.0.0) = all interfaces. */
      networkInterface: string;
      /** The MusicCast event port, declared for the admin's port-conflict check (fleet listen-port standard); the receiver always listens on 41100. */
      port: number;
      /** The address declared for that port (0.0.0.0 = all); the receiver binds all addresses. */
      bind: string;
      /** Configured Yamaha devices — the one row type (`DeviceRow`), the object id stored since 3.0.0. */
      devices: DeviceRow[];
      /**
       * Whether the network search runs: `auto` while the device table holds no row the user typed
       * (migrated rows do not count; the behaviour of every installation before 2.9.0), `always` next to a filled table (mixed operation),
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

// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** IP of the network interface to bind discovery to; empty (or 0.0.0.0) = all interfaces. */
      networkInterface: string;
      /** Configured Yamaha devices: a display name and the device IP address. */
      devices: { name: string; ip: string }[];
      /** Poll interval in seconds for XML/pre-2010 devices. */
      xmlPollInterval: number;
      /**
       * Present every volume datapoint as 0…100 % instead of the scale the device itself shows.
       * Off by default: the device's own scale is the truth, and percent is a conversion the user
       * asks for. Applies to every device on the instance and to every zone.
       */
      volumeAsPercent: boolean;
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

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
      /** Set once a device has connected over XML — drives the conditional admin field. */
      hasXmlDevice: boolean;
    }
  }
}

export {};

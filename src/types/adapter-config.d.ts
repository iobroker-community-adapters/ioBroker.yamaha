// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Configured Yamaha devices: a display name and the device IP address. */
      devices: { name: string; ip: string }[];
    }
  }
}

export {};

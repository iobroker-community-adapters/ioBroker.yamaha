// Fleet master — the release run copies this file byte for byte into every adapter's src-admin/; change it in
// Entwicklung/.consistency-master, never in an adapter. No rule is switched off here: the component and its tests
// are linted like the adapter itself.
import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    ignores: [".__mf__temp/", "admin/", "build/", "*.config.mjs"],
  },
];

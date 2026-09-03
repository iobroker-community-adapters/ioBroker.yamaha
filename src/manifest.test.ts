import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWITCHABLE_GROUPS } from "./lib/catalog/groups";

/**
 * Manifest and admin wiring the integration boot test cannot see. Both checks here guard
 * something that stays GREEN while being broken: the adapter boots, the linter and the type
 * check pass, and only the user notices that a button or a whole datapoint group is missing.
 */
describe("io-package.json manifest", () => {
  const root = join(__dirname, "..");
  const io = JSON.parse(readFileSync(join(root, "io-package.json"), "utf8")) as {
    common?: { supportedMessages?: { deviceManager?: boolean } };
    native?: Record<string, unknown>;
  };

  it("enables device-manager messages (common.supportedMessages.deviceManager)", () => {
    // The device manager only works with this flag: without it js-controller delivers no
    // `dm:*` message, so neither the add button nor the device cards appear — yet the
    // adapter still boots green.
    expect(io.common?.supportedMessages?.deviceManager).toBe(true);
  });

  it("offers a switch and a default for every switchable datapoint group", () => {
    // Three places have to agree, and nothing else notices when they drift: the groups the
    // code knows (a datapoint's group decides whether it is created at all), the switches on
    // the configuration page, and the defaults in the manifest. Add a group in the code and
    // forget the switch, and its datapoints can never be turned off; forget the default and
    // the switch starts out empty.
    const config = readFileSync(join(root, "admin", "jsonConfig.json"), "utf8");
    for (const group of SWITCHABLE_GROUPS) {
      expect(config, `switch for group_${group}`).toContain(`"group_${group}"`);
      expect(io.native, `default for group_${group}`).toHaveProperty(`group_${group}`);
    }
    // …and nothing the other way round either: a leftover switch would offer the user a
    // control over datapoints that no longer belong to a group.
    const switches = [...config.matchAll(/"(group_[a-z]+)"\s*:/g)].map(match => match[1]);
    for (const name of new Set(switches)) {
      expect(
        SWITCHABLE_GROUPS.map(group => `group_${group}`),
        `${name} has no group`,
      ).toContain(name);
    }
  });
});

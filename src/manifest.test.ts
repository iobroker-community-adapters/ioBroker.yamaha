import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWITCHABLE_GROUPS } from "./lib/catalog/groups";
import { YNCA_CATALOG } from "./lib/ynca/catalog";
import { YXC_AMP_CATALOG } from "./lib/yxc/catalog";

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

describe("every datapoint has a description decision", () => {
  /**
   * The fleet standard (`feedback_beschreibung_ist_erklaerung`) wants `common.desc` to be a real
   * explanation where the adapter has something to say, and EMPTY where it does not — an invented
   * sentence is worse than nothing. A gate therefore cannot simply demand a description everywhere.
   *
   * What it CAN demand is that the decision was made: every catalog entry either carries a
   * `descKey`, or its name key is listed below as self-explanatory. A new datapoint that is in
   * neither fails this test, so the gap can never be silent again — which is exactly how yamaha
   * ended up with 0 descriptions on 190 datapoints while every existing gate stayed green
   * (they only ever checked a description that was already there).
   */
  const SELF_EXPLANATORY = new Set<string>([
    "power",
    "volume",
    "mute",
    "input",
    "sleepTimer",
    "bass",
    "treble",
    "zoneName",
    "model",
    "firmwareVersion",
    "band",
    "frequency",
    "nextPreset",
    "previousPreset",
    "playback",
    "artist",
    "album",
    "track",
    "station",
    "channelName",
    "repeat",
    "shuffle",
    "next",
    "previous",
    "connected",
    "connect",
    "startPairing",
    "cancelPairing",
    "pairedDevice",
    "speakerA",
    "speakerB",
    "zoneBPower",
    "zoneBMute",
    "zoneBVolume",
    "zoneBName",
  ]);

  it("no catalog entry is left undecided", () => {
    const undecided = new Map<string, string>();
    for (const entry of [...YNCA_CATALOG, ...YXC_AMP_CATALOG]) {
      const nameKey = (entry as { nameKey?: string }).nameKey;
      const descKey = (entry as { descKey?: string }).descKey;
      const derived = (entry as { derived?: boolean }).derived;
      if (derived || !nameKey || descKey || SELF_EXPLANATORY.has(nameKey)) {
        continue;
      }
      const id = (entry as { id?: string; state?: string }).id ?? (entry as { state?: string }).state ?? "?";
      if (!undecided.has(nameKey)) {
        undecided.set(nameKey, id);
      }
    }
    expect(
      [...undecided].map(([key, id]) => `${key} (${id})`),
      "each of these needs either a descKey or an entry in SELF_EXPLANATORY",
    ).toEqual([]);
  });
});

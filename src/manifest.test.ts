import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SWITCHABLE_GROUPS } from "./lib/catalog/groups";
import { YNCA_CATALOG } from "./lib/ynca/catalog";
import { YXC_AMP_CATALOG } from "./lib/yxc/catalog";
import { XML_AMP_CATALOG } from "./lib/xml/catalog";
import { DAB_FIELDS } from "./lib/yxc/command-mapper";

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
    // MusicCast/XML-only, ebenfalls selbsterklaerend
    "balance",
    "monaural",
    "equalizerLow",
    "equalizerMid",
    "equalizerHigh",
    "inputNameDisplay",
  ]);

  it("no catalog entry is left undecided", () => {
    const undecided = new Map<string, string>();
    // ALL four catalogs, and BOTH entry shapes. The YNCA table carries `nameKey`/`descKey` on the
    // entry itself; the MusicCast and XML tables carry them inside `common`. A first version of
    // this test only read the top level — so it silently skipped every MusicCast and XML entry
    // and reported "all decided" while 29 of them had no explanation. Measured on the live tree:
    // 59 datapoints should have carried one, 25 did.
    for (const entry of [...YNCA_CATALOG, ...YXC_AMP_CATALOG, ...XML_AMP_CATALOG, ...DAB_FIELDS]) {
      const shallow = entry as { nameKey?: string; descKey?: string; derived?: boolean };
      const nested = (entry as { common?: { nameKey?: string; descKey?: string } }).common;
      const nameKey = shallow.nameKey ?? nested?.nameKey;
      const descKey = shallow.descKey ?? nested?.descKey;
      if (shallow.derived || !nameKey || descKey || SELF_EXPLANATORY.has(nameKey)) {
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

describe("no object is built without the explanation that exists for it", () => {
  /**
   * The catalog invariant above walks the four TABLES. It cannot see the objects that the
   * MusicCast and XML controllers build inline with `tName("someKey")` — and those were exactly
   * the ones left without a description twice in a row: first because the insertion only matched
   * table entries, then because `ObjectDef["common"]` had no `desc` field at all, so the key had
   * nowhere to go. Both times the tree looked complete and eight tuner/scene datapoints were bare.
   *
   * This check reads the SOURCE instead: wherever a translation key is used to name an object and
   * an explanation key exists for it, the explanation has to be used too.
   */
  it("every name key with an explanation uses it", () => {
    const root = join(__dirname);
    const en = JSON.parse(readFileSync(join(root, "../admin/i18n/en.json"), "utf8")) as Record<string, string>;
    const explained = new Map<string, string>();
    for (const key of Object.keys(en)) {
      if (key.startsWith("desc") && !key.startsWith("descChannel")) {
        explained.set(key[4].toLowerCase() + key.slice(5), key);
      }
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(full);
        }
      }
    };
    walk(root);
    const missing: string[] = [];
    const undecidedNames: string[] = [];
    /** Object names that need no explanation — the name already says it. */
    const NAMES_WITHOUT_EXPLANATION = new Set<string>([
      "alarm",
      "alarmArmed",
      "alarmMode",
      "alarmVolume",
      "allDevicesOnline",
      "band",
      "browse",
      "cd",
      "connected",
      "dab",
      "deviceOrServiceConnected",
      "devicesOnline",
      "devicesTotal",
      "discTime",
      "favouritesStoredPresets",
      "frequency",
      "info",
      "information",
      "ipAddress",
      "mediaPlayer",
      "model",
      "musiccastPlaylists",
      "networkPlayer",
      "nextPreset",
      "playQueue",
      "previousPreset",
      "recentlyPlayed",
      "source",
      "storedPresets",
      "totalTracks",
      "trackNumber",
      "tuner",
    ]);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:nameKey:\s*"|tName\(\s*")([A-Za-z0-9]+)"/g)) {
        const descKey = explained.get(match[1]);
        if (!descKey) {
          continue;
        }
        const around = source.slice(Math.max(0, match.index - 200), match.index + 240);
        if (!around.includes(descKey)) {
          missing.push(`${file.slice(root.length + 1)}: ${match[1]} → ${descKey}`);
        }
      }
      // The symmetric half: an object NAME that carries no explanation at all must be a
      // deliberate decision, not an oversight. Two datapoints slipped through the rule above
      // because the same meaning had a SECOND key (`tuned` beside `tunedToAStation`), for which
      // no explanation existed — so nothing was demanded and the tree stayed bare.
      for (const match of source.matchAll(/name:\s*tName\("([A-Za-z0-9]+)"\)/g)) {
        const after = source.slice(match.index, match.index + 300);
        if (after.includes("desc: tName(") || NAMES_WITHOUT_EXPLANATION.has(match[1])) {
          continue;
        }
        undecidedNames.push(`${file.slice(root.length + 1)}: ${match[1]}`);
      }
    }
    expect(missing, "these build an object but drop the explanation that exists for it").toEqual([]);
    expect(undecidedNames, "these name an object with no explanation and are not listed as self-explanatory").toEqual(
      [],
    );
  });
});

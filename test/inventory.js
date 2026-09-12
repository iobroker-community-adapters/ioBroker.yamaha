"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller against eight
//   fake devices covering every device class the adapter distinguishes (AV receiver, stereo
//   receiver, speaker, soundbar, CD system) and every transport combination — YNCA-only,
//   MusicCast-only, XML-only (the 2008 dialect), MusicCast+YNCA and all three on one receiver —
//   then dump every yamaha.0.* object to test/objects.inventory.json in the ioBroker
//   object-structure bot's format, and prove two dropdown rules on it: every dropdown carries the
//   value the device reports, and none offers a value the device did not declare.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is set — pre-release.py
//   exports the last tag's inventory): seed the previous objects BEFORE start, start, feed, then
//   assert that every object carries the current name/desc/role/type and that removed ones are gone.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");
const {
  startFixtureDevices,
  loadFixtures,
  declaredListsOf,
  declaredVolumeRangesOf,
} = require("./inventory-fixtures.cjs");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const VOLATILE = ["ts", "from", "user", "acl"];
/**
 * The fields an update must bring to EVERY existing object. `states`, `min`, `max` and `step`
 * joined on 2026-09-09: a dropdown or a bound that stays stale on an existing installation is
 * exactly the defect of #619 (54 catalog inputs kept although the receiver declares 21), and
 * without them the upgrade suite could not fail on it.
 */
const COMPARED = ["name", "desc", "role", "type", "unit", "states", "min", "max", "step"];
/** How many fixture devices devices.json lists — every one of them must build a tree. */
const FIXTURE_DEVICES = loadFixtures().length;
/** The English texts, to prove a datapoint carries the explanation its MODE deserves. */
const EN = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, "admin", "i18n", "en.json"), "utf8"));
/** The ids removed in 2.8.0 — none of them may exist anywhere, in main or in any zone. */
const REMOVED_IN_2_8_0 = ["actualVolume", "actualVolumeMode", "inputText"];
/** A device-relative `volume` id: the main zone's, or one of zones 2-4. */
const VOLUME_ID = /^(?:multiroom\.zone[234]\.)?volume$/;

/**
 * Device `native` fields that record what THIS run learned (probe answers, the sweep's
 * availability map, the purge marker). They are legitimate object content but carry run
 * state, so they are dropped from the inventory — otherwise two runs of the same fixtures
 * could differ over nothing that describes the object tree.
 */
const RUN_STATE_NATIVE = ["capabilityProfile", "probeCache", "yncaAvail", "purgeVersion"];

let fixtures;

/**
 * Bring up the fake devices and point the adapter at them.
 *
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
 * @param {Record<string, unknown>} [extraNative] instance settings on top of the manifest defaults
 */
async function startWithFixtures(harness, extraNative = {}) {
  fixtures = await startFixtureDevices();
  await harness.changeAdapterConfig(ADAPTER, { native: { devices: fixtures.devices, ...extraNative } });
  // The routing table reaches the adapter process through its environment; the require hook
  // rewrites the device addresses to the fixture servers there. The adapter has no test seam.
  await harness.startAdapterAndWait(false, {
    NODE_OPTIONS: `--require ${path.join(__dirname, "inventory-hook.cjs")}`,
    YAMAHA_FIXTURE_ROUTES: JSON.stringify(fixtures.routes),
  });
}

/**
 * Wait until the object tree stops growing. A YNCA sweep is paced at the 100 ms the
 * specification demands, so a receiver needs the better part of a minute; the datapoint
 * balance then settles for another five seconds before the tree is final.
 *
 * ⚠️ On a SEEDED tree (the upgrade suite) both of the old conditions were true one second
 * after the start: every device already had its states, and the row count of an existing
 * tree does not grow when the adapter merely refreshes it. The dump was therefore taken
 * while the three YNCA receivers were still sweeping, and the suite compared the SEED with
 * itself — it reported "everything reached" for 174 datapoints the run had not touched yet.
 * Two conditions close that: a device counts as built only once it REPORTS connected (the
 * supervisor flips that flag after `attempt()` has written the tree), and the quiet loop
 * compares the object CONTENT, not the row count, so a refreshed description resets it.
 *
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
 */
async function waitForSettledTree(harness, deviceCount) {
  // Two conditions, in this order. A device that has ONLY its `info.*` header is not connected —
  // and a tree of nothing but headers looks perfectly "stable", which is how an empty inventory
  // passes a naive count check. The header is exactly the `info.` subtree, so "carries a
  // datapoint outside info." is the precise question, not a threshold that has to be guessed.
  // The adapter's OWN `yamaha.0.info.*` branch sits at the same depth as a device's header and
  // must be excluded by its first segment — counted as a device it inflates the tally by one,
  // which lets the loop leave while a real device is still missing and fails the assert once
  // every device has in fact arrived.
  let withTree = 0;
  let built = new Set();
  for (let i = 0; i < 240 && withTree < deviceCount; i++) {
    await new Promise(done => setTimeout(done, 1000));
    const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
    const devices = new Set();
    for (const row of list.rows) {
      const rest = row.id.slice(NS.length).split(".");
      if (rest.length > 1 && rest[0] !== "info" && rest[1] !== "info" && row.value?.type === "state") {
        devices.add(rest[0]);
      }
    }
    withTree = devices.size;
    built = devices;
  }
  assert.strictEqual(withTree, deviceCount, `only ${withTree} of ${deviceCount} fixture devices built a tree`);
  // Then connected: a tree can be there and still be the OLD one. The supervisor reports a
  // device connected only after `attempt()` has built its objects, so this is the signal that
  // the run has actually touched them — the only one a seeded tree does not fake (the states
  // database starts empty even when the objects are pre-filled).
  const deviceIds = [...built];
  let connected = 0;
  for (let i = 0; i < 240 && connected < deviceCount; i++) {
    await new Promise(done => setTimeout(done, 1000));
    const states = await Promise.all(deviceIds.map(id => harness.states.getStateAsync(`${NS}${id}.info.connection`)));
    connected = states.filter(state => state?.val === true).length;
  }
  assert.strictEqual(connected, deviceCount, `only ${connected} of ${deviceCount} fixture devices connected`);
  // Then quiet: the datapoint balance settles five seconds after the last device, and the
  // object tree is only final once that has passed. Compared is the CONTENT of the fields the
  // upgrade assertion reads — a second transport that joins late refreshes texts without
  // adding a row, and a row count would call that "quiet".
  let previous = "";
  let stable = 0;
  for (let i = 0; i < 60 && stable < 8; i++) {
    await new Promise(done => setTimeout(done, 1000));
    const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
    const fingerprint = JSON.stringify(
      list.rows
        .map(row => [row.id, row.value?.type, ...COMPARED.map(field => row.value?.common?.[field])])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    stable = fingerprint === previous && list.rows.length > 0 ? stable + 1 : 0;
    previous = fingerprint;
  }
  assert.ok(previous.length > 2, "no objects created — the fixture devices did not reach the adapter");
}

/**
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
 * @returns {Promise<Record<string, any>>} every adapter object, bot dump format
 */
async function dumpObjects(harness) {
  // The range starts at "yamaha.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) {
      delete obj[key];
    }
    if (obj.native) {
      obj.native = { ...obj.native };
      for (const key of RUN_STATE_NATIVE) {
        delete obj.native[key];
      }
    }
    out[row.id] = obj;
  }
  return out;
}

/**
 * Join the fixtures to the device objects the adapter built for them. The device id derives from
 * the CONFIGURED address (10.10.0.13 → 10_10_0_13), not from the fixture's name, so the `info.ip`
 * datapoint the adapter writes for every device is the only reliable join.
 *
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
 * @param {Record<string, any>} objects a dump of the object tree
 * @returns {Promise<Map<string, string>>} configured address → device object id
 */
async function deviceIdByIp(harness, objects) {
  const map = new Map();
  for (const [id, obj] of Object.entries(objects)) {
    if (obj.type === "device") {
      const ip = await harness.states.getStateAsync(`${id}.info.ip`);
      if (typeof ip?.val === "string") {
        map.set(ip.val, id);
      }
    }
  }
  return map;
}

/**
 * Every amplifier `volume` state in a dump, grouped by the device it belongs to — the main
 * zone's and zones 2–4. `advanced.maxVolume`, `sound.subwooferVolume` and the rest are other
 * datapoints on other scales and are none of this grouping's business.
 *
 * @param {Record<string, any>} objects a dump of the object tree
 * @returns {Map<string, {id: string, common: any}[]>} device object id → its volume states
 */
function volumeStatesOf(objects) {
  const byDevice = new Map();
  for (const [id, obj] of Object.entries(objects)) {
    const device = id.split(".").slice(0, 3).join(".");
    const relative = id.slice(device.length + 1);
    if (obj.type !== "state" || !VOLUME_ID.test(relative)) {
      continue;
    }
    byDevice.set(device, [...(byDevice.get(device) ?? []), { id, common: obj.common ?? {} }]);
  }
  return byDevice;
}

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(240000);
        harness = getHarness();
        await startWithFixtures(harness);
        await waitForSettledTree(harness, fixtures.devices.length);
      });

      after(async function () {
        this.timeout(60000);
        // Order matters: a still-running adapter reconnects a dropped transport at once, so
        // closing the fixture servers first is a race against its own retry loop.
        await harness?.stopAdapter();
        await fixtures?.stop();
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("keeps every device's capability profile small (one JSON string per device object)", async function () {
        this.timeout(60000);
        // The profile is the one persisted memory per device (2.7.0): parsed declarations only,
        // never raw XML (desc.xml is 90–160 KB). Read from the RAW objects — dumpObjects strips it.
        const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
        const sizes = [];
        for (const row of list.rows) {
          if (row.value?.type !== "device") {
            continue;
          }
          const profile = row.value.native?.capabilityProfile;
          assert.strictEqual(typeof profile, "string", `${row.id}: no capability profile after the connect`);
          for (const legacy of ["probeCache", "yncaAvail", "purgeVersion"]) {
            assert.ok(
              row.value.native?.[legacy] === undefined || row.value.native?.[legacy] === null,
              `${row.id}: legacy key native.${legacy} still present next to the profile`,
            );
          }
          sizes.push(`${row.id}: ${profile.length} bytes`);
          assert.ok(profile.length < 40000, `${row.id}: capability profile is ${profile.length} bytes (limit 40000)`);
        }
        assert.ok(sizes.length >= FIXTURE_DEVICES, `only ${sizes.length} device profiles found`);
        console.log(`capability profile sizes:\n  ${sizes.join("\n  ")}`);
      });

      it("covers every device class the adapter distinguishes", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        const devices = Object.values(objects).filter(o => o.type === "device");
        assert.ok(
          devices.length >= FIXTURE_DEVICES,
          `only ${devices.length} devices reached the tree, expected ${FIXTURE_DEVICES}`,
        );
      });

      it("every dropdown contains the value the device currently reports", async function () {
        this.timeout(60000);
        // A dropdown that lacks the value the receiver reports right now is the worst form of
        // the #619 class: the admin shows a raw value nobody can select back. Measured over
        // every string datapoint with a `states` map, against the live state the fixture seeded.
        const objects = await dumpObjects(harness);
        const misses = [];
        for (const [id, obj] of Object.entries(objects)) {
          const states = obj.common?.states;
          if (obj.type !== "state" || !states || typeof states !== "object" || obj.common.type !== "string") {
            continue;
          }
          const state = await harness.states.getStateAsync(id);
          const value = state?.val;
          if (typeof value === "string" && value.length > 0 && !(value in states)) {
            misses.push(`${id}: reports ${JSON.stringify(value)}, dropdown lacks it`);
          }
        }
        assert.deepStrictEqual(misses, [], `dropdowns that miss the live value:\n${misses.join("\n")}`);
      });

      it("no dropdown offers a value the device did not declare (where it declares one)", async function () {
        this.timeout(60000);
        // Where a fixture declares a list (XML Input_Sel_Item, desc.xml programs, MusicCast
        // getFeatures lists), the built dropdown must be a subset of it. A MusicCast list reaches
        // a YNCA-owned datapoint in the classic spelling, through the SAME dictionary the adapter
        // uses — an id the dictionary refuses fails here loudly instead of passing by vacuity.
        const objects = await dumpObjects(harness);
        // The dictionary module exists from 2.6.0 on; a build without it (the RED run before the
        // dictionary landed) translates nothing, so a MusicCast list on a YNCA-owned datapoint
        // fails as undeclared — which is the truth of that build.
        let translateDeclaredStates = (_key, _states) => undefined;
        try {
          ({ translateDeclaredStates } = require(path.join(ADAPTER_DIR, "build/lib/catalog/musiccast-vocabulary.js")));
        } catch {
          // no dictionary in this build
        }
        // The device object's id derives from the configured address (10.10.0.13 → 10_10_0_13),
        // not from the fixture's name — map fixtures to devices through the `info.ip` datapoint
        // the adapter writes for every device, and refuse to pass on a device that was not found.
        const byIp = await deviceIdByIp(harness, objects);
        const violations = [];
        for (const fixture of loadFixtures()) {
          const deviceId = byIp.get(fixture.ip);
          assert.ok(deviceId, `no device object reports info.ip ${fixture.ip} (fixture ${fixture.id})`);
          for (const [relativeId, list] of Object.entries(declaredListsOf(fixture))) {
            const states = objects[`${deviceId}.${relativeId}`]?.common?.states;
            if (!states) {
              continue; // the datapoint does not exist on this device — not this assertion's question
            }
            const key = relativeId.replace(/^multiroom\.zone[234]\./, "");
            const translated = translateDeclaredStates(key, Object.fromEntries(list.map(v => [v, v]))) ?? {};
            const allowed = new Set([...list, ...Object.keys(translated)]);
            // What the device REPORTS is as good as declared: a receiver that lists only
            // "manual" as tone-control mode and answers "auto" (RX-A2070 capture) contradicts
            // itself, and the value it reports must stay selectable.
            const live = await harness.states.getStateAsync(`${deviceId}.${relativeId}`);
            if (typeof live?.val === "string") {
              allowed.add(live.val);
            }
            for (const value of Object.keys(states)) {
              if (!allowed.has(value)) {
                violations.push(`${fixture.id}.${relativeId}: offers ${JSON.stringify(value)}, not declared`);
              }
            }
          }
        }
        assert.deepStrictEqual(violations, [], `undeclared dropdown values:\n${violations.join("\n")}`);
      });

      it("no device mixes two volume scales across its zones", async function () {
        this.timeout(60000);
        // The BOUNDS may differ from zone to zone — a receiver declares its range per zone and
        // the RX-V6A really does say main 0…97 and zone 2 0…90.5, so a zone that reports its
        // own range is computed on that range. What must NOT differ is the SCALE the numbers
        // are in, and until 2.8.0 the RX-A2070 carried decibels in main and zone 2 and a raw
        // step count in zone 3 — one device, two scales.
        const objects = await dumpObjects(harness);
        const mixed = [];
        for (const [device, states] of volumeStatesOf(objects)) {
          const scales = new Set(states.map(s => `${s.common.unit || "(none)"} step ${s.common.step}`));
          if (scales.size > 1) {
            mixed.push(`${device}: ${[...scales].join(" vs ")}`);
          }
        }
        assert.deepStrictEqual(mixed, [], `devices carrying two volume scales:\n${mixed.join("\n")}`);
      });

      it("every volume datapoint carries the bounds its zone declares", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        const bare = [];
        for (const states of volumeStatesOf(objects).values()) {
          for (const { id, common } of states) {
            const usable =
              typeof common.min === "number" &&
              typeof common.max === "number" &&
              typeof common.step === "number" &&
              common.max > common.min;
            if (!usable) {
              bare.push(`${id}: min=${common.min} max=${common.max} step=${common.step}`);
            }
          }
        }
        assert.deepStrictEqual(bare, [], `volume datapoints without usable bounds:\n${bare.join("\n")}`);

        // And those bounds are the DECLARED ones — taken, never derived: the display range where
        // the zone declares a display of its own (decibels, or the plain number scale), the raw
        // wire range where it declares none. A fixture that speaks no MusicCast declares nothing
        // here; its volume comes from the YNCA or XML catalog and is not this assertion's question.
        const byIp = await deviceIdByIp(harness, objects);
        const wrong = [];
        for (const fixture of loadFixtures()) {
          const deviceId = byIp.get(fixture.ip);
          assert.ok(deviceId, `no device object reports info.ip ${fixture.ip} (fixture ${fixture.id})`);
          for (const [relative, ranges] of Object.entries(declaredVolumeRangesOf(fixture))) {
            const common = objects[`${deviceId}.${relative}`]?.common;
            if (!common) {
              continue; // the zone builds no volume datapoint at all
            }
            const want = common.unit === "dB" ? ranges.db : (ranges.numeric ?? ranges.raw);
            const got = { min: common.min, max: common.max, step: common.step };
            if (!want || JSON.stringify(got) !== JSON.stringify(want)) {
              wrong.push(`${fixture.id}.${relative}: carries ${JSON.stringify(got)}, declares ${JSON.stringify(want)}`);
            }
          }
        }
        assert.deepStrictEqual(wrong, [], `volume bounds that are not the declared ones:\n${wrong.join("\n")}`);
      });

      it("the datapoints 2.8.0 removed are gone from the whole tree", async function () {
        this.timeout(60000);
        // Removal by attrition would leave them here on the FIRST start after the update, which
        // reads like a failure; they go through the explicit removal path instead.
        const objects = await dumpObjects(harness);
        const leftovers = Object.keys(objects).filter(id => REMOVED_IN_2_8_0.includes(id.split(".").pop()));
        assert.deepStrictEqual(leftovers, [], `removed datapoints still in the tree:\n${leftovers.join("\n")}`);
      });

      it("input survived the removal of inputText, with its labels", async function () {
        this.timeout(60000);
        // `inputText` carried the plain-text source name. It went because `input` has carried the
        // same names as its dropdown LABELS since 2.7.2 — so a regression that took the labels
        // away would turn this removal into a loss of information.
        const objects = await dumpObjects(harness);
        const devices = Object.keys(objects).filter(id => objects[id].type === "device");
        assert.strictEqual(devices.length, FIXTURE_DEVICES, `only ${devices.length} devices in the dump`);
        const bare = [];
        for (const device of devices) {
          const states = objects[`${device}.input`]?.common?.states;
          const labelled = states && typeof states === "object" && Object.keys(states).length > 0;
          if (!labelled) {
            bare.push(`${device}.input: ${states ? "no labels" : "missing"}`);
          }
        }
        assert.deepStrictEqual(bare, [], `input datapoints without labels:\n${bare.join("\n")}`);
      });
    });

    // The second switch position, on the same eight fixtures. Unit tests cover the mapping; only
    // a full run proves that EVERY device class — dB receiver, numeric receiver, speaker,
    // soundbar, CD system, and the YNCA-only and XML-only receivers — actually reaches the
    // percent presentation, in every zone.
    suite("volume as percent", getHarness => {
      let harness;
      before(async function () {
        this.timeout(240000);
        harness = getHarness();
        await startWithFixtures(harness, { volumeAsPercent: true });
        await waitForSettledTree(harness, fixtures.devices.length);
      });

      after(async function () {
        this.timeout(60000);
        await harness?.stopAdapter();
        await fixtures?.stop();
      });

      it("turns every volume datapoint of every device into 0-100 %", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        const want = {
          role: "level.volume",
          unit: "%",
          min: 0,
          max: 100,
          step: 0.5,
          desc: EN.descVolumePercent,
        };
        const wrong = [];
        for (const states of volumeStatesOf(objects).values()) {
          for (const { id, common } of states) {
            const got = {
              role: common.role,
              unit: common.unit,
              min: common.min,
              max: common.max,
              step: common.step,
              desc: common.desc?.en,
            };
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              wrong.push(`${id}: ${JSON.stringify(got)}`);
            }
          }
        }
        assert.deepStrictEqual(wrong, [], `volume datapoints not presented as percent:\n${wrong.join("\n")}`);
      });

      it("covers exactly the datapoints the default mode builds", async function () {
        this.timeout(60000);
        // Without this the assertion above could pass by vacuity: a device class that silently
        // stopped building `volume` in percent mode would simply not be checked.
        const ids = tree =>
          [...volumeStatesOf(tree).values()]
            .flat()
            .map(state => state.id)
            .sort();
        const truth = ids(JSON.parse(fs.readFileSync(INVENTORY, "utf8")));
        const percent = ids(await dumpObjects(harness));
        assert.ok(truth.length > 0, "the default-mode inventory carries no volume datapoint");
        assert.deepStrictEqual(percent, truth, "the percent tree carries other volume datapoints than the default one");
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(240000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one, so the seed
          // survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await startWithFixtures(harness);
          await waitForSettledTree(harness, fixtures.devices.length);
        });

        after(async function () {
          this.timeout(60000);
          await harness?.stopAdapter();
          await fixtures?.stop();
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(60000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            for (const f of COMPARED) {
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The object's KIND (state/channel/device/folder) sits one level above `common`;
            // the `type` in COMPARED is the VALUE type and something else entirely — they only
            // share a name. Without this comparison a failed type migration passes green.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(60000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});

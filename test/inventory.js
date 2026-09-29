/* global describe, it, before, after */
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
// Suite 2 "second system language": the same run in German, dumped for the readable-values judge.
// Suite 3 "volume as percent": the second position of the volume switch on the same fixtures.
// Suite 4 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is set — pre-release.py
//   exports the last tag's inventory): seed the previous objects BEFORE start, start, feed, then
//   assert that every object carries the current common (every field) and object type, that removed
//   ones are gone, and that a room assignment survives a device-id move.
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
// An object is written at most three times in one start: created, its name refreshed, enriched once after
// discovery. More is churn — every write goes to the database and to every subscriber (round 60, measured
// 2026-09-28 over the fleet: 1-3 everywhere, 251 for an object whose stored key flipped on every resync).
const MAX_OBJECT_WRITES = 3;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
// Value dumps for the readable-values judge (`iobroker-adapter-checks values`, gate D08 + CI job): the states
// after the fixture run, and the objects once more from a run in a second system language. Generated, not
// committed (.gitignore) — timestamps and counters would make a golden file drift on every run.
const STATES_INVENTORY = path.join(__dirname, "states.inventory.json");
const OBJECTS_SECOND_LANGUAGE = path.join(__dirname, "objects.inventory.de.json");
const FIRST_LANGUAGE = "en";
const SECOND_LANGUAGE = "de";
const VOLATILE = ["ts", "from", "user", "acl"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );
// How long the upgrade suite keeps watching after its verdict: a write in that window means the wait ended before
// the adapter did (round 61, measured 2026-09-29 over the fleet: none in 10 s at HEAD; parcelapp's old wait judged
// 5 ms before the first of 187 writes).
const SETTLE_MS = 10000;
const INSTANCE_OBJECTS = new Set(
  (require(path.join(ADAPTER_DIR, "io-package.json")).instanceObjects ?? []).map(o => `${NS}${o._id}`),
);
// Round 62: every adapter start loads test/resource-probe.js (fleet master) FIRST; at its exit it records what the
// adapter or one of its libraries left open after onUnload, and the run fails on any of it (the after() at the end).
const RESOURCE_PROBE = path.join(__dirname, "resource-probe.js");
const RESOURCE_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `${ADAPTER}-resources-`));
// Round 62: the adapter's read-only states (`common.write: false`) — only the adapter writes them, so it compares them
// in memory; a database read of one in the quiet window after the verdict is a finding.
const READ_ONLY = new Set();

/**
 * The environment of every adapter start: the resource probe first, then the test hooks of this adapter.
 *
 * @param {...string} hooks absolute paths of `--require` hooks (fixture servers, DNS)
 */
function adapterEnv(...hooks) {
  return {
    NODE_OPTIONS: [RESOURCE_PROBE, ...hooks].map(file => `--require ${file}`).join(" "),
    RESOURCE_PROBE_DIR: RESOURCE_DIR,
    RESOURCE_PROBE_NS: NS,
  };
}

/**
 * The fixture hook: it rewrites the device addresses to the fixture servers inside the adapter process. The
 * routing table reaches it through `YAMAHA_FIXTURE_ROUTES` in the environment — set in THIS process before a
 * start, because @iobroker/testing hands `process.env` on to the adapter (`{ ...process.env, ...env }`), the
 * restart the harness plays included. The adapter has no test seam.
 */
const HOOK = path.join(__dirname, "inventory-hook.cjs");

/**
 * Every object write of the adapter in this suite, and which of them changed nothing (round 61). An unchanged
 * rewrite still goes to the database and to every subscriber — the adapter writes only what differs. The FIRST
 * write of an `instanceObjects` entry is js-controller's own (`_createInstancesObjects` extends every entry before
 * `onReady`, 7.2.2) and not the adapter's choice. Called as the suite's first await, so the start is watched from
 * its first write; the known content comes from the database, a seed included.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function watchObjectWrites(harness) {
  const watch = { writes: new Map(), peak: new Map(), unchanged: [], deleted: [], times: [], unchangedIndicators: [] };
  const known = new Map();
  const roles = new Map();
  const states = new Map();
  const content = obj => {
    const { ts, from, user, ...rest } = obj;
    return canonical(rest);
  };
  harness.on("objectChange", (id, obj) => {
    if (!id.startsWith(NS)) {
      return;
    }
    if (!obj) {
      watch.deleted.push(id);
      known.delete(id);
      roles.delete(id);
      return;
    }
    roles.set(id, obj.common?.role);
    if (obj.type === "state" && obj.common?.write === false) {
      READ_ONLY.add(id);
    } else {
      READ_ONLY.delete(id);
    }
    const now = content(obj);
    if (obj.from === `system.adapter.${ADAPTER}.0`) {
      const n = (watch.writes.get(id) ?? 0) + 1;
      watch.writes.set(id, n);
      watch.peak.set(id, Math.max(watch.peak.get(id) ?? 0, n));
      watch.times.push([id, Date.now()]);
      if (known.get(id) === now && !(n === 1 && INSTANCE_OBJECTS.has(id))) {
        watch.unchanged.push(id);
      }
    }
    known.set(id, now);
  });
  // Round 62: an indicator state (`indicator.*`) is written only on a change (read-only: compared in memory,
  // writable: setStateChangedAsync) — a write that changes nothing is a finding. Compared is what js-controller
  // 7.2.2 compares in setStateChangedAsync: val strictly, ack, q, c; an object value always counts as changed.
  harness.on("stateChange", (id, state) => {
    if (!id.startsWith(NS) || !state || state.from !== `system.adapter.${ADAPTER}.0`) {
      return;
    }
    const now =
      state.val !== null && typeof state.val === "object" ? null : canonical([state.val, state.ack, state.q, state.c]);
    if (now !== null && states.get(id) === now && String(roles.get(id)).startsWith("indicator")) {
      watch.unchangedIndicators.push(id);
    }
    states.set(id, now);
  });
  // Round 64: a restart the harness plays (playControllerRestarts) is a new start — the per-start counts begin again,
  // the known object content stays (it is the database's).
  watch.newStart = () => {
    watch.writes.clear();
    states.clear();
  };
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  for (const row of list.rows) {
    if (row.value) {
      known.set(row.id, content(row.value));
      roles.set(row.id, row.value.common?.role);
      if (row.value.type === "state" && row.value.common?.write === false) {
        READ_ONLY.add(row.id);
      }
    }
  }
  return watch;
}

/**
 * The fields an update must bring to EVERY existing object — what the settle loop compares. Since round 61 the
 * upgrade assertion compares every field of `common`; the settle loop keeps this list: a second transport that
 * joins late refreshes these without adding a row.
 */
const COMPARED = ["name", "desc", "role", "type", "unit", "states", "min", "max", "step", "icon"];
/** How many fixture devices devices.json lists — every one of them must build a tree. */
const FIXTURE_DEVICES = loadFixtures().length;
/** The English texts, to prove a datapoint carries the explanation its MODE deserves. */
const EN = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, "admin", "i18n", "en.json"), "utf8"));
/** The ids removed in 2.8.0 — none of them may exist anywhere, in main or in any zone. */
const REMOVED_IN_2_8_0 = ["actualVolume", "actualVolumeMode", "inputText"];
/** A device-relative `volume` id: the main zone's, or one of zones 2-4. */
// Zone B is a zone too (audit 2026-09-29, D13).
const VOLUME_ID = /^(?:multiroom\.(?:zone[234]|zoneB)\.)?volume$/;
/** The instance settings every start of the manifest carries, next to what a suite configures. */
const MANIFEST_NATIVE = require(path.join(ADAPTER_DIR, "io-package.json")).native ?? {};
/** The room a user put every previous device and one of its datapoints into (upgrade suite). */
const SEEDED_ROOM = "enum.rooms.inventory_upgrade";

/**
 * Device `native` fields that record what THIS run learned (probe answers, the sweep's
 * availability map, the purge marker). They are legitimate object content but carry run
 * state, so they are dropped from the inventory — otherwise two runs of the same fixtures
 * could differ over nothing that describes the object tree.
 */
const RUN_STATE_NATIVE = ["capabilityProfile", "probeCache", "yncaAvail", "purgeVersion"];

let fixtures;

/**
 * Bring up the fake devices and point the adapter at them. The throwaway js-controller keeps its instance
 * object between suites, and changeAdapterConfig only EXTENDS native — a key an older version wrote (or an
 * earlier suite set) would survive and trigger the start-up settings migration, and with it a host restart,
 * in every suite. Every key that is neither the manifest's nor this suite's is nulled (null is the
 * post-migration state of a dropped key).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the harness
 * @param {Record<string, unknown>} [extraNative] instance settings on top of the manifest defaults
 * @param {boolean} [legacyRows] configure the device table as 2.x held it (address only, the id
 *   derived from it) instead of as 3.0.0 writes it (the id stored)
 */
async function startFixtures(harness, extraNative = {}, legacyRows = false) {
  fixtures = await startFixtureDevices();
  process.env.YAMAHA_FIXTURE_ROUTES = JSON.stringify(fixtures.routes);
  const native = { devices: legacyRows ? fixtures.legacyDevices : fixtures.devices, ...extraNative };
  const instance = await harness.objects.getObjectAsync(`system.adapter.${ADAPTER}.0`);
  const stale = {};
  for (const key of Object.keys(instance?.native ?? {})) {
    if (!Object.hasOwn(native, key) && !Object.hasOwn(MANIFEST_NATIVE, key)) {
      stale[key] = null;
    }
  }
  await harness.changeAdapterConfig(ADAPTER, { native: { ...MANIFEST_NATIVE, ...stale, ...native } });
}

/**
 * Wait until the adapter has DONE its work: every fixture device built a tree, reported connected in the CURRENT
 * process, and the tree is quiet.
 *
 * A YNCA sweep is paced at the 100 ms the specification demands, so a receiver needs the better part of a minute;
 * the datapoint balance then settles for another five seconds before the tree is final.
 *
 * ⚠️ On a SEEDED tree (the upgrade suite) the old conditions were true one second after the start: every device
 * already had its states, and the row count of an existing tree does not grow when the adapter merely refreshes
 * it. Three conditions close that: a device counts only once it REPORTS connected, the report must come from the
 * running process (its `info.connection` changed after the instance's `alive` last turned true — a start the
 * harness plays after an instance-object write, or a second start, leaves the previous process's `true` behind),
 * and the quiet loop compares object CONTENT, not the row count.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the harness
 */
async function waitForAdapterWork(harness) {
  const deviceCount = fixtures.devices.length;
  const deadline = Date.now() + 300000;
  // Built and connected in the running process. The adapter's OWN `yamaha.0.info.*` branch sits at the same
  // depth as a device's header and must be excluded by its first segment; a device that has ONLY its header is
  // not connected.
  let connected = 0;
  for (;;) {
    const alive = await harness.states.getStateAsync(`system.adapter.${ADAPTER}.0.alive`);
    const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
    const devices = new Set();
    for (const row of list.rows) {
      const rest = row.id.slice(NS.length).split(".");
      if (rest.length > 1 && rest[0] !== "info" && rest[1] !== "info" && row.value?.type === "state") {
        devices.add(rest[0]);
      }
    }
    connected = 0;
    if (alive?.val === true && harness.isAdapterRunning()) {
      for (const id of devices) {
        const state = await harness.states.getStateAsync(`${NS}${id}.info.connection`);
        if (state?.val === true && typeof state.lc === "number" && state.lc >= alive.lc) {
          connected++;
        }
      }
    }
    if (connected >= deviceCount) {
      break;
    }
    assert.ok(Date.now() < deadline, `only ${connected} of ${deviceCount} fixture devices connected`);
    await new Promise(done => setTimeout(done, 1000));
  }
  // Then quiet: the datapoint balance settles five seconds after the last device, and the object tree is only
  // final once that has passed.
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
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the harness
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
 * Set the throwaway controller's system language — what the adapter reads from `system.config`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} language an ioBroker language code
 */
async function setSystemLanguage(harness, language) {
  const config = await harness.objects.getObject("system.config");
  config.common.language = language;
  await harness.objects.setObject("system.config", config);
}

/**
 * Dump the value of every state of the instance: `{ "<id>": { val, ack } }`, sorted. The states client has no
 * `getKeysAsync` — `getKeys`/`getStates` (like `getObject`/`setObject`) return a promise without a callback.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function dumpStates(harness) {
  const keys = (await harness.states.getKeys(`${NS}*`)).sort();
  const values = await harness.states.getStates(keys);
  const out = {};
  keys.forEach((key, i) => {
    if (values[i]) {
      out[key] = { val: values[i].val, ack: values[i].ack };
    }
  });
  return out;
}

/**
 * js-controller 7.2.2 restarts an instance on EVERY change of its instance object while it runs (controller main.ts,
 * objects `change` handler: `stopInstance`, then `startInstance` after `stopTimeout` + 2.5 s) — whoever wrote it, the
 * adapter's own settings migration or device table included. The harness has no host; this plays it (round 64): the
 * first change while the adapter runs stops it and starts it once more with the same hooks, so what the adapter did
 * after that write in the same start is cut off here as it is on a real host. A change after that restart is a finding:
 * on a host the instance would restart again, for good.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object | null} watch the suite's write watcher (watchObjectWrites), null in a suite without one
 * @param {...string} hooks the test hooks the suite starts the adapter with (as for adapterEnv)
 */
function playControllerRestarts(harness, watch, ...hooks) {
  const restarts = { count: 0, again: [], done: Promise.resolve() };
  harness.on("objectChange", id => {
    if (id !== `system.adapter.${ADAPTER}.0` || !harness.isAdapterRunning()) {
      return;
    }
    if (restarts.count > 0) {
      restarts.again.push(Date.now());
      return;
    }
    restarts.count++;
    restarts.done = (async () => {
      await harness.stopAdapter();
      watch?.newStart();
      // What the host does when the process exits: `alive` false (a start that still sees it true ends with
      // ADAPTER_ALREADY_RUNNING, exit code 7), then the start after stopTimeout + 2.5 s.
      await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, {
        val: false,
        ack: true,
        from: "system.host.testing",
      });
      await new Promise(resolve => setTimeout(resolve, RESTART_DELAY_MS));
      // @iobroker/testing refuses a second start of one harness ("already been used"); the host starts the same
      // instance again — reset the exit marker, and fail loudly should the harness no longer keep it there.
      harness._adapterExit = undefined;
      assert.ok(
        !harness.didAdapterStop(),
        "@iobroker/testing changed its exit marker — the restart play needs a new form",
      );
      await harness.startAdapterAndWait(false, adapterEnv(...hooks));
    })();
  });
  return restarts;
}

/** Round 64: the host's wait before it starts a stopped instance again (controller main.ts, `stopTimeout || 500` + 2.5 s). */
const RESTART_DELAY_MS = (require(path.join(ADAPTER_DIR, "io-package.json")).common.stopTimeout || 500) + 2500;
/** Round 64: the recording marker every seeded state carries in `common.custom`, naming the id it was seeded under. */
const RECORDING = "inventory-recording.0";

/**
 * Seed the previous release's objects before the start. Every state carries a recording marker (round 64): what hangs
 * on a datapoint is the user's — it goes on with the SAME datapoint (its id, or the one id a move gives it), never onto
 * a new datapoint, and never decides what the adapter creates, keeps or deletes (that shows up as a leftover or a
 * missing object against the committed inventory).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, ioBroker.Object>} previous the previous release's inventory
 */
async function seedPrevious(harness, previous) {
  for (const [id, obj] of Object.entries(previous)) {
    const common =
      obj.type === "state"
        ? { ...obj.common, custom: { ...obj.common?.custom, [RECORDING]: { enabled: true, origin: id } } }
        : obj.common;
    await harness.objects.setObjectAsync(id, { ...obj, common });
  }
}

/**
 * The room a user built on the previous release: every previous device and its first datapoint. A device-id move
 * deletes the old tree, and js-controller takes every deleted id out of every enum (7.2.2 `_deleteObjects` →
 * `removeIdFromAllEnums`) — the move has to carry each membership to the new id, and an interrupted move (the
 * restart its own device-table write causes) must not lose them.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, ioBroker.Object>} previous the previous release's inventory
 * @returns {Promise<string[]>} the seeded members
 */
async function seedRoom(harness, previous) {
  const members = [];
  for (const [id, obj] of Object.entries(previous)) {
    if (obj.type !== "device") {
      continue;
    }
    members.push(id);
    const first = Object.keys(previous)
      .filter(other => other.startsWith(`${id}.`) && previous[other].type === "state")
      .sort()[0];
    if (first) {
      members.push(first);
    }
  }
  await harness.objects.setObjectAsync(SEEDED_ROOM, {
    type: "enum",
    common: { name: "Inventory upgrade room", members },
    native: {},
  });
  return members;
}

/**
 * The device objects of a dump that do not run under their final 3.0.0 id — a missing mark
 * (`native.idScheme`) or a move still due (`native.movingTo`). Empty when every id is final.
 *
 * @param {Record<string, any>} objects a dump of the object tree
 * @returns {string[]} one line per device that is not final
 */
function devicesNotFinal(objects) {
  const out = [];
  for (const [id, obj] of Object.entries(objects)) {
    if (obj.type !== "device") {
      continue;
    }
    if (obj.native?.idScheme !== 3 || (obj.native?.movingTo !== undefined && obj.native?.movingTo !== null)) {
      out.push(
        `${id}: idScheme ${JSON.stringify(obj.native?.idScheme)}, movingTo ${JSON.stringify(obj.native?.movingTo)}`,
      );
    }
  }
  return out;
}

/**
 * Join the fixtures to the device objects the adapter built for them — the `info.ip` datapoint the adapter
 * writes for every device is the one reliable join.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the harness
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
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let watch;
      let restarts;
      before(async function () {
        this.timeout(600000);
        harness = getHarness();
        watch = await watchObjectWrites(harness);
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        await startFixtures(harness);
        restarts = playControllerRestarts(harness, watch, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await waitForAdapterWork(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
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

      it("writes test/states.inventory.json", async function () {
        this.timeout(30000);
        const states = await dumpStates(harness);
        assert.ok(Object.keys(states).length > 0, "no states written — fixtures did not reach the adapter");
        fs.writeFileSync(STATES_INVENTORY, `${JSON.stringify(states, null, 2)}\n`);
      });

      it("writes no object more than MAX_OBJECT_WRITES times", function () {
        const churn = [...watch.peak].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
        assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
      });

      it("rewrites no object unchanged", function () {
        const idle = [...new Set(watch.unchanged)];
        assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
      });

      it("rewrites no indicator state unchanged", function () {
        const idle = [...new Set(watch.unchangedIndicators)];
        assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("runs every device under its final id — model and serial, the model alone without one", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        const devices = Object.keys(objects)
          .filter(id => objects[id].type === "device")
          .sort();
        const expected = fixtures.devices.map(device => `${NS}${device.id}`).sort();
        assert.deepStrictEqual(devices, expected, "the device ids are not the ones the 3.0.0 rule gives");
        assert.deepStrictEqual(devicesNotFinal(objects), [], "devices whose id is not final");
      });

      it("gives every device object one of the five pictograms, as an inline data URL", async function () {
        this.timeout(60000);
        // The value the admin gets is the SVG itself (data URL) — a path would land in a bare
        // <img> that keeps a fixed colour; the five constants are the only allowed values.
        const { DEVICE_TYPE_ICONS } = require(path.join(ADAPTER_DIR, "build", "lib", "device-type.js"));
        const allowed = new Set(Object.values(DEVICE_TYPE_ICONS));
        const objects = await dumpObjects(harness);
        const devices = Object.entries(objects).filter(([, object]) => object.type === "device");
        assert.ok(devices.length > 0, "no device objects in the inventory");
        for (const [id, object] of devices) {
          const icon = object.common && object.common.icon;
          assert.ok(typeof icon === "string" && icon.startsWith("data:image/svg+xml;base64,"), `${id}: no inline icon`);
          assert.ok(allowed.has(icon), `${id}: common.icon is not one of the five pictograms`);
        }
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
        const { translateDeclaredStates } = require(
          path.join(ADAPTER_DIR, "build/lib/catalog/musiccast-vocabulary.js"),
        );
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

    // The same run once more in a second system language: a label that stays the same in both was never
    // translated. A suite of its own — the harness starts an adapter only once per suite (a second
    // startAdapterAndWait in the same suite never resolves), and every suite gets a fresh database.
    suite("second system language", getHarness => {
      let harness;
      let restarts;
      before(async function () {
        this.timeout(600000);
        harness = getHarness();
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        await startFixtures(harness);
        restarts = playControllerRestarts(harness, null, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await waitForAdapterWork(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      after(async function () {
        this.timeout(60000);
        await harness?.stopAdapter();
        await fixtures?.stop();
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("writes test/objects.inventory.de.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(OBJECTS_SECOND_LANGUAGE, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    // The second switch position, on the same eight fixtures. Unit tests cover the mapping; only
    // a full run proves that EVERY device class — dB receiver, numeric receiver, speaker,
    // soundbar, CD system, and the YNCA-only and XML-only receivers — actually reaches the
    // percent presentation, in every zone.
    //
    // Since 2.9.0 the switch is a DEVICE setting; the instance-wide one this suite writes is the
    // UPGRADE path, inherited once by a device that has no answer of its own. So the run proves
    // both at once: the inheritance, and the presentation on every device class.
    suite("volume as percent", getHarness => {
      let harness;
      let restarts;
      before(async function () {
        this.timeout(600000);
        harness = getHarness();
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        await startFixtures(harness, { volumeAsPercent: true });
        restarts = playControllerRestarts(harness, null, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await waitForAdapterWork(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      after(async function () {
        this.timeout(60000);
        await harness?.stopAdapter();
        await fixtures?.stop();
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("every device took the inherited switch down as its own answer", async function () {
        this.timeout(60000);
        // Written down, not merely inherited: turning ONE device back later must not be undone
        // by the instance value still sitting in the instance object.
        const objects = await dumpObjects(harness);
        const devices = Object.entries(objects).filter(([, obj]) => obj.type === "device");
        assert.ok(devices.length > 0, "no device objects in the dump");
        for (const [id, obj] of devices) {
          assert.strictEqual(obj.native?.volumeAsPercent, true, `${id} did not record the switch`);
        }
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
        let watch;
        let restarts;
        let verdictAt;
        let roomMembers = [];
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(900000);
          harness = getHarness();
          watch = await watchObjectWrites(harness);
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await seedPrevious(harness, previous);
          roomMembers = await seedRoom(harness, previous);
          // The device table in the form the previous release left it. From 2.x that is the
          // address only (the id derived from it): a device whose model and serial the stored tree
          // knows moves to its 3.0.0 id at this start; the others tell theirs at the first contact
          // and move at the next start — the second one below, as the host gives it after an update
          // or a reboot. From 3.0.0 on the table carries the final id next to the address; a 3.x tree
          // started with 2.x rows is a state no installation reaches.
          await startFixtures(harness, {}, devicesNotFinal(previous).length > 0);
          // The inventory was written in FIRST_LANGUAGE: labels an adapter localises itself (`states`)
          // only compare in the same language.
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          restarts = playControllerRestarts(harness, watch, HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(HOOK));
          await waitForAdapterWork(harness);
          await restarts.done;
          await waitForAdapterWork(harness);
          // The next start, days later on a real host (an update, a reboot): what the first contact decided
          // moves now. A new start plays its own restart — the one its move's table write causes.
          await harness.stopAdapter();
          watch.newStart();
          await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, {
            val: false,
            ack: true,
            from: "system.host.testing",
          });
          harness._adapterExit = undefined;
          restarts = playControllerRestarts(harness, watch, HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(HOOK));
          await waitForAdapterWork(harness);
          // A migration that wrote the instance object restarts the instance (round 64) — the verdict
          // comes after the second start has done its work.
          await restarts.done;
          await waitForAdapterWork(harness);
          verdictAt = Date.now();
          fs.writeFileSync(
            path.join(RESOURCE_DIR, "window.json"),
            JSON.stringify({ start: verdictAt, end: verdictAt + SETTLE_MS }),
          );
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
            // Every field of `common`, not a chosen few: an adapter writes only what differs (round 61),
            // so every changed field must reach an existing installation.
            for (const f of new Set([...Object.keys(obj.common ?? {}), ...Object.keys(got.common ?? {})])) {
              if (f === "custom") {
                continue; // the user's recording — judged on its own below (round 64)
              }
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The object's KIND (state/channel/device/folder) sits one level above `common`;
            // `common.type` is the VALUE type and something else entirely — they only share a
            // name. Without this comparison a failed type migration passes green.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        // The discovery-schema jump of an update drops every device's learned memory
        // (`native.probeCache`) — the device's own settings and what it is known by live in their
        // own keys next to it and must come through unchanged; the model is kept outside the
        // memory so an offline migrated receiver is still recognised by it (audit 2026-09-24, A22).
        it("every device keeps its settings, identity and label, and carries its model", async function () {
          this.timeout(60000);
          const live = await dumpObjects(harness);
          // A device lives under its 3.0.0 id now: the previous one is found by the address it
          // was configured with (2.x derived the id from it), the current one by its info.ip.
          const liveIdByIp = await deviceIdByIp(harness, live);
          const lost = [];
          for (const [id, obj] of Object.entries(previous)) {
            if (obj.type !== "device") {
              continue;
            }
            const ip = id.slice(NS.length).replace(/_/g, ".");
            const now = live[id] ? id : liveIdByIp.get(ip);
            for (const key of ["volumeAsPercent", "identity", "label", "labelRank", "source"]) {
              if (
                obj.native?.[key] !== undefined &&
                canonical(live[now]?.native?.[key]) !== canonical(obj.native[key])
              ) {
                lost.push(
                  `${id} → ${now}: native.${key} ${JSON.stringify(obj.native[key])} became ${JSON.stringify(live[now]?.native?.[key])}`,
                );
              }
            }
            const model = await harness.states.getStateAsync(`${now}.info.model`);
            if (typeof model?.val === "string" && model.val !== "" && live[now]?.native?.model !== model.val) {
              lost.push(
                `${id} → ${now}: reports model ${model.val} but native.model is ${JSON.stringify(live[now]?.native?.model)}`,
              );
            }
          }
          assert.deepStrictEqual(lost, [], `device settings an update did not keep:\n${lost.join("\n")}`);
        });

        it("every device ran under its final id after the second start", async function () {
          this.timeout(60000);
          const live = await dumpObjects(harness);
          assert.deepStrictEqual(devicesNotFinal(live), [], "devices whose id is not final");
          const devices = Object.keys(live)
            .filter(id => live[id].type === "device")
            .sort();
          const expected = fixtures.devices.map(device => `${NS}${device.id}`).sort();
          assert.deepStrictEqual(devices, expected, "the device ids after the update are not the 3.0.0 ones");
        });

        // A move carries every room assignment to the new ids, through the restart its own table write causes
        // (audit 2026-09-29, A23): the room lists as many members as it did, and every one of them exists.
        it("keeps every room assignment through a device-id move", async function () {
          this.timeout(60000);
          const room = await harness.objects.getObjectAsync(SEEDED_ROOM);
          const members = room?.common?.members ?? [];
          const live = await dumpObjects(harness);
          const dead = members.filter(id => !(id in live));
          assert.deepStrictEqual(dead, [], `room members that point nowhere:\n${dead.join("\n")}`);
          assert.strictEqual(
            members.length,
            roomMembers.length,
            `the room lists ${members.length} of the ${roomMembers.length} seeded members`,
          );
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(60000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });

        it("rewrites no object unchanged", function () {
          const idle = [...new Set(watch.unchanged)];
          assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
        });

        it("rewrites no indicator state unchanged", function () {
          const idle = [...new Set(watch.unchangedIndicators)];
          assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
        });

        // A kept object that is deleted and created anew makes the suite judge a fresh object, not the
        // upgraded one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
        it("deletes no object the release keeps", function () {
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const lost = [...new Set(watch.deleted)].filter(id => id in previous && id in current);
          assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
        });

        it("a recording goes on only with its own datapoint", async function () {
          this.timeout(30000);
          const live = await dumpObjects(harness);
          const carriers = new Map();
          for (const [id, obj] of Object.entries(live)) {
            const origin = obj.common?.custom?.[RECORDING]?.origin;
            if (origin) {
              carriers.set(origin, [...(carriers.get(origin) ?? []), id]);
            }
          }
          const wrong = [];
          for (const [origin, ids] of carriers) {
            if (ids.length > 1) {
              wrong.push(`${origin} → ${ids.join(", ")}: one recording on several datapoints`);
            } else if (ids[0] !== origin && origin in live) {
              wrong.push(`${origin} → ${ids[0]}: copied while ${origin} lives on`);
            } else if (ids[0] !== origin && live[ids[0]].common?.type !== previous[origin]?.common?.type) {
              wrong.push(`${origin} → ${ids[0]}: another value type — a new datapoint, not the same one moved`);
            }
          }
          // A state that lives on keeps what hangs on it — the recording is the user's, never destroyed.
          for (const [id, obj] of Object.entries(previous)) {
            if (obj.type === "state" && live[id]?.type === "state" && !carriers.get(id)?.includes(id)) {
              wrong.push(`${id}: its recording is gone although the datapoint lives on`);
            }
          }
          assert.deepStrictEqual(wrong, [], `recordings that left their datapoint:\n${wrong.join("\n")}`);
        });

        // What a fresh installation does not have, an upgrade must not have either — whatever made it (round 64:
        // a datapoint created because the old one was recorded is exactly that).
        it("creates nothing a fresh installation lacks", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const extra = Object.keys(live).filter(id => !(id in current));
          assert.deepStrictEqual(extra, [], `objects a fresh installation does not have:\n${extra.join("\n")}`);
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });

        // Last in the suite: a write after the verdict means waitForAdapterWork ended before the adapter did.
        it("writes nothing after the verdict", async function () {
          this.timeout(SETTLE_MS + 5000);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, verdictAt + SETTLE_MS - Date.now())));
          const late = [...new Set(watch.times.filter(([, t]) => t > verdictAt).map(([id]) => id))];
          assert.deepStrictEqual(late, [], `objects written after the verdict:\n${late.join("\n")}`);
        });
      });
    }
  },
});

// Round 62: after every suite, every adapter process of this run has exited — what it left open after onUnload fails
// the run. Every start leaves a marker: no marker means a start without adapterEnv(), a marker without a report a
// process that never reached its exit (killed after a hanging onUnload, or crashed).
after(function () {
  const files = fs.readdirSync(RESOURCE_DIR);
  const starts = files.filter(f => f.endsWith(".start")).map(f => f.slice(0, -".start".length));
  const silent = starts.filter(pid => !files.includes(`${pid}.json`));
  const reports = starts
    .filter(pid => !silent.includes(pid))
    .map(pid => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, `${pid}.json`), "utf8")));
  const left = reports.flatMap(r => r.left);
  const reread = reports.flatMap(r =>
    Object.entries(r.quiet)
      .filter(([id]) => READ_ONLY.has(id))
      .map(([id, n]) => `${id} ×${n}`),
  );
  fs.rmSync(RESOURCE_DIR, { recursive: true, force: true });
  assert.ok(starts.length > 0, "no adapter start loaded the resource probe — a start without adapterEnv()");
  assert.deepStrictEqual(silent, [], "adapter processes that never reached their exit (killed or crashed)");
  assert.deepStrictEqual(left, [], `left open after onUnload:\n${left.join("\n")}`);
  assert.deepStrictEqual(
    reread,
    [],
    `read-only states read back from the database while nothing changed:\n${reread.join("\n")}`,
  );
});

"use strict";
// The fake devices behind the object inventory: one YNCA (TCP) server and one HTTP server per
// device — the latter serving MusicCast, the XML control endpoint and the XML device
// description by path, like a receiver's port 80 — answering from the captures in
// test/fixtures/inventory/.
//
// The captures are real device answers, taken from the bundled reference material — 16 YNCA
// protocols recorded by the `ynca` Python tool, the MusicCast endpoint collections of
// `yamaha-yxc-nodejs`, the 2026-09-01 three-protocol harvest of an RX-V6A and the openHAB
// captures of a 2008 RX-V3900 (all scrubbed of their owners' configuration). No device answers
// what the model it stands for cannot answer: an unknown YNCA function gets `@UNDEFINED`, an
// unknown MusicCast endpoint response_code 5, an unknown XML node `RC="2"`, a missing device
// description HTTP 404 — exactly as a real device does. That is what keeps the inventory honest.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

const DIR = path.join(__dirname, "fixtures", "inventory");

/** @returns {any[]} every device fixture, in the order devices.json lists them */
function loadFixtures() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "devices.json"), "utf8"));
  return manifest.map(entry => JSON.parse(fs.readFileSync(path.join(DIR, `${entry.id}.json`), "utf8")));
}

/**
 * A receiver speaking YNCA over TCP. Answers `@SUB:FUNC=?` from the capture and `@UNDEFINED`
 * for everything else — the same rule the hardware-free test harness follows.
 *
 * @param {Record<string, string>} answers the capture's SUBUNIT:FUNC -> value table
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the listening server
 */
function startYnca(answers) {
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^@([A-Z0-9_]+):([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (!match) {
          continue;
        }
        const [, subunit, func, value] = match;
        const key = `${subunit}:${func}`;
        if (value !== "?") {
          // A write: a real receiver echoes the new value back when it accepts it.
          if (key in answers) {
            answers[key] = value;
            socket.write(`@${key}=${value}\r\n`);
          } else {
            socket.write("@UNDEFINED\r\n");
          }
          continue;
        }
        socket.write(key in answers ? `@${key}=${answers[key]}\r\n` : "@UNDEFINED\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return listen(server);
}

/** MusicCast error body for an endpoint the device does not implement. */
const YXC_UNSUPPORTED = { response_code: 5 };

/**
 * Build the answers a MusicCast device gives, filling the endpoints the capture does not carry
 * with ones derived from its own getFeatures — never with invented capabilities.
 *
 * @param {any} yxc the fixture's yxc block
 * @returns {Record<string, any>} endpoint -> response
 */
function yxcAnswers(yxc) {
  const answers = { ...yxc.answers };
  const features = answers["system/getFeatures"] ?? { response_code: 0 };
  const zones = (features.zone ?? []).map(zone => zone.id).filter(Boolean);
  if (!answers["system/getDeviceInfo"]) {
    answers["system/getDeviceInfo"] = {
      response_code: 0,
      model_name: yxc.model,
      device_id: `${yxc.model.replace(/[^A-Za-z0-9]/g, "")}0000`,
      system_version: 1,
      api_version: 2,
    };
  }
  // Every zone the device declares must answer getStatus — a MusicCast transport whose zones
  // all stay silent is a dead transport, and the adapter is right to treat it as one. The
  // filler reports an input the zone DECLARES (its first), never an invented one: a zone-4
  // status saying "net_radio" on an HDMI-only zone was a harness artefact, not a device fact.
  for (const entry of features.zone ?? []) {
    const zone = entry?.id;
    if (typeof zone === "string" && !answers[`${zone}/getStatus`]) {
      const input = Array.isArray(entry.input_list) && entry.input_list.length > 0 ? entry.input_list[0] : "net_radio";
      answers[`${zone}/getStatus`] = { response_code: 0, power: "standby", volume: 0, mute: false, input };
    }
  }
  if (zones.length === 0 && !answers["main/getStatus"]) {
    answers["main/getStatus"] = { response_code: 0, power: "standby", volume: 0, mute: false, input: "net_radio" };
  }
  return answers;
}

/**
 * The device's ONE web server: a real receiver serves MusicCast (`/YamahaExtendedControl/…`),
 * the XML control endpoint (`/YamahaRemoteControl/ctrl`) and its device description
 * (`/YamahaRemoteControl/desc.xml`) on the same port 80 — so does the fixture, dispatching by
 * path. Before 2026-09-09 one port served EITHER protocol, so a device speaking both (the
 * common case for every 2015+ receiver) could not be expressed, and the description could not
 * be served at all — a plain GET fell through to the XML handler's `RC="2"`.
 *
 * @param {any} fixture the device fixture (its yxc and/or xml block)
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the listening server
 */
function startHttp(fixture) {
  const yxc = fixture.yxc ? yxcAnswers(fixture.yxc) : undefined;
  const xml = fixture.xml;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://device");
    if (yxc && url.pathname.startsWith("/YamahaExtendedControl/")) {
      const endpoint = url.pathname.replace(/^\/YamahaExtendedControl\/v\d+\//, "");
      // A setter the device declares is accepted; the inventory only needs the object to exist,
      // and a refusal here would be a device verdict the capture does not support.
      const body =
        yxc[endpoint] ??
        (/^[a-z]+\/(set|toggle|recall|start|stop|manage|prepare)/.test(endpoint)
          ? { response_code: 0 }
          : YXC_UNSUPPORTED);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (xml && url.pathname === "/YamahaRemoteControl/desc.xml") {
      // The device description is a plain GET. A device without one answers 404 — the adapter
      // takes that as the definite "declares none" (the RX-V6A's own behaviour).
      if (typeof xml.descriptor === "string") {
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(xml.descriptor);
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (xml && url.pathname === "/YamahaRemoteControl/ctrl") {
      // The request names a node path (`<Main_Zone><Basic_Status>`); the capture is indexed
      // by exactly that path.
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        const match = /<YAMAHA_AV[^>]*>\s*<([A-Za-z0-9_]+)>\s*<([A-Za-z0-9_]+)>/.exec(body);
        const key = match ? `${match[1]}/${match[2]}` : "";
        const answer = xml.answers[key] ?? xml.answers[match?.[1] ?? ""];
        res.writeHead(200, { "Content-Type": "text/xml" });
        // RC=2 is the device's own "I do not have that node" — the adapter treats it as a final
        // refusal and remembers it, which is precisely the behaviour under test.
        res.end(answer ?? `<YAMAHA_AV rsp="GET" RC="2"></YAMAHA_AV>`);
      });
      return;
    }
    // A host with a web server, but not this API on this path.
    res.writeHead(404);
    res.end();
  });
  return listen(server);
}

/**
 * The value lists a fixture device DECLARES, by state id relative to the device — what the
 * adapter's dropdowns may at most contain. XML: the `Input_Sel_Item` Params per zone and the
 * desc.xml program enumeration; MusicCast: the zone's input_list, sound_program_list,
 * surr_decoder_type_list, menu_list and cursor_list. A YNCA-only fixture declares nothing
 * (its dropdowns are candidates the device cannot confirm).
 *
 * @param {any} fixture one device fixture
 * @returns {Record<string, string[]>} state id → declared values (in the transport's own spelling)
 */
function declaredListsOf(fixture) {
  const lists = /** @type {Record<string, string[]>} */ ({});
  const zonePrefix = zone => (zone === "main" ? "" : `multiroom.${zone}.`);
  if (fixture.xml) {
    const zones = [
      ["Main_Zone", "main"],
      ["Zone_2", "zone2"],
      ["Zone_3", "zone3"],
      ["Zone_4", "zone4"],
    ];
    for (const [element, zone] of zones) {
      const body = fixture.xml.answers[`${element}/Input`];
      if (body) {
        lists[`${zonePrefix(zone)}input`] = [...body.matchAll(/<Item_\d+>\s*<Param>([^<]+)<\/Param>/g)].map(m => m[1]);
      }
    }
    if (typeof fixture.xml.descriptor === "string") {
      const block = /Program_Sel,Current,Sound_Program=Param_1<\/Cmd>\s*<Param_1>([\s\S]*?)<\/Param_1>/.exec(
        fixture.xml.descriptor,
      );
      if (block) {
        lists.soundProgram = [...block[1].matchAll(/<Direct(?:\s[^>]*)?>([^<]+)<\/Direct>/g)].map(m => m[1]);
      }
    }
  }
  if (fixture.yxc) {
    const features = fixture.yxc.answers["system/getFeatures"];
    for (const zone of features?.zone ?? []) {
      const prefix = zonePrefix(zone.id);
      const put = (id, list) => {
        if (Array.isArray(list) && list.length > 0) {
          lists[prefix + id] = list;
        }
      };
      put("input", zone.input_list);
      put("soundProgram", zone.sound_program_list);
      put("sound.surroundDecoder", zone.surr_decoder_type_list);
      put("remote.menu", zone.menu_list);
      put("remote.cursor", zone.cursor_list);
    }
  }
  return lists;
}

/**
 * What a MusicCast fixture DECLARES about its volume, per zone. `range_step` carries the raw
 * wire range under `volume` and, where the receiver has a display of its own, that display's
 * range under `actual_volume_db` / `actual_volume_numeric`. Those declarations are what the
 * built datapoint must carry — taken, never derived (krobi 2026-09-11: "der receiver schickt
 * min und max und das ist dann eben min und max fertig"), and per zone, because a receiver
 * declares them per zone (RX-V6A: main 0…97, zone 2 0…90.5).
 *
 * A fixture that speaks no MusicCast declares nothing here; its `volume` comes from the YNCA
 * or XML catalog instead and is not this reader's business.
 *
 * @param {any} fixture one device fixture
 * @returns {Record<string, {raw?: {min: number, max: number, step: number}, db?: {min: number, max: number, step: number}, numeric?: {min: number, max: number, step: number}}>}
 *   zone-prefixed `volume` id → the ranges that zone declares
 */
function declaredVolumeRangesOf(fixture) {
  const out = /** @type {Record<string, any>} */ ({});
  const features = fixture.yxc?.answers?.["system/getFeatures"];
  for (const zone of features?.zone ?? []) {
    const prefix = zone.id === "main" ? "" : `multiroom.${zone.id}.`;
    const by = /** @type {Record<string, any>} */ ({});
    for (const entry of zone.range_step ?? []) {
      by[entry.id] = { min: entry.min, max: entry.max, step: entry.step };
    }
    const ranges = { raw: by.volume, db: by.actual_volume_db, numeric: by.actual_volume_numeric };
    if (ranges.raw || ranges.db || ranges.numeric) {
      out[`${prefix}volume`] = ranges;
    }
  }
  return out;
}

/**
 * @param {any} server a net or http server
 * @returns {Promise<{port: number, close: () => Promise<void>}>} resolved once it listens
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        // The adapter holds its YNCA socket open for the whole run, so a plain close() would
        // wait for a connection that never ends on its own. Drop the live ones first.
        close: () =>
          new Promise(done => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Start every fixture device and report how the adapter process must be routed to them.
 *
 * @returns {Promise<{devices: {id: string, ip: string}[], routes: Record<string, {http: number, ynca: number|null}>, stop: () => Promise<void>}>}
 *   the device list for the adapter's configuration, the hook's routing table, and a stopper
 */
async function startFixtureDevices() {
  const fixtures = loadFixtures();
  const servers = [];
  const routes = {};
  for (const fixture of fixtures) {
    const ynca = fixture.ynca ? await startYnca({ ...fixture.ynca.answers }) : undefined;
    // One HTTP port per device serves BOTH HTTP protocols by path, like the real port 80; a
    // device that speaks neither still needs a listener that refuses, or an XML probe would hang.
    const httpServer =
      fixture.yxc || fixture.xml
        ? await startHttp(fixture)
        : await listen(http.createServer((_req, res) => res.destroy()));
    servers.push(ynca, httpServer);
    routes[fixture.ip] = { http: httpServer.port, ynca: ynca ? ynca.port : null };
  }
  return {
    devices: fixtures.map(f => ({ id: f.id, ip: f.ip })),
    routes,
    stop: async () => {
      for (const server of servers) {
        if (server) {
          await server.close();
        }
      }
    },
  };
}

module.exports = { startFixtureDevices, loadFixtures, declaredListsOf, declaredVolumeRangesOf };

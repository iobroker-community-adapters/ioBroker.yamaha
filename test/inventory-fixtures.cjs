"use strict";
// The fake devices behind the object inventory: one YNCA (TCP), one MusicCast (HTTP) and one
// XML/YNC (HTTP) server, answering from the captures in test/fixtures/inventory/.
//
// The captures are real device answers, taken from the bundled reference material — 16 YNCA
// protocols recorded by the `ynca` Python tool, the MusicCast endpoint collections of
// `yamaha-yxc-nodejs`, and the 2026-09-01 XML harvest (scrubbed of the owner's own
// configuration). No device answers what the model it stands for cannot answer: an unknown
// YNCA function gets `@UNDEFINED` and an unknown MusicCast endpoint gets response_code 5,
// exactly as a real device does. That is what keeps the inventory honest.
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
  // all stay silent is a dead transport, and the adapter is right to treat it as one.
  for (const zone of zones.length ? zones : ["main"]) {
    if (!answers[`${zone}/getStatus`]) {
      answers[`${zone}/getStatus`] = { response_code: 0, power: "standby", volume: 0, mute: false, input: "net_radio" };
    }
  }
  return answers;
}

/**
 * A MusicCast device over HTTP. Serves `/YamahaExtendedControl/v1/<endpoint>` from the capture.
 *
 * @param {any} yxc the fixture's yxc block
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the listening server
 */
function startYxc(yxc) {
  const answers = yxcAnswers(yxc);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://device");
    const endpoint = url.pathname.replace(/^\/YamahaExtendedControl\/v\d+\//, "");
    // A setter the device declares is accepted; the inventory only needs the object to exist,
    // and a refusal here would be a device verdict the capture does not support.
    const body =
      answers[endpoint] ??
      (/^[a-z]+\/(set|toggle|recall|start|stop|manage|prepare)/.test(endpoint)
        ? { response_code: 0 }
        : YXC_UNSUPPORTED);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return listen(server);
}

/**
 * An XML/YNC device over HTTP. The request names a node path (`<Main_Zone><Basic_Status>`);
 * the capture is indexed by exactly that path.
 *
 * @param {any} xml the fixture's xml block
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the listening server
 */
function startXml(xml) {
  const server = http.createServer((req, res) => {
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
  });
  return listen(server);
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
    // One HTTP port per device serves whichever of the two HTTP protocols it speaks; a device
    // that speaks neither still needs a listener that refuses, or an XML probe would hang.
    const httpServer = fixture.yxc
      ? await startYxc(fixture.yxc)
      : fixture.xml
        ? await startXml(fixture.xml)
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

module.exports = { startFixtureDevices, loadFixtures };

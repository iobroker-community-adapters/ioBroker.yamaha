"use strict";
// Routes the adapter's device traffic to the inventory fixture servers — loaded into the
// ADAPTER process via NODE_OPTIONS=--require, so the adapter itself needs no test seam.
//
// Why a hook and not the production seams: `XmlClient`/`YamahaYxcClient` do take an injectable
// transport (`XmlPoster`, `YxcSend`), but `attempt-device.ts` builds them with the defaults and
// nothing in the configuration reaches those parameters. Adding a path from the config to them
// would be a test seam in production code; rewriting the destination outside the adapter is not.
//
// Two rules, and the second one is what makes the hook safe: a known device address is routed to
// its fixture port and an unknown DEVICE address is refused (a forgotten route fails loudly
// instead of quietly leaving the machine) — but every call this hook does not positively
// recognise is passed through completely untouched. The adapter process also talks to the
// js-controller's states/objects database over the same APIs, and a hook that "normalises"
// those arguments takes the adapter down before it ever reaches a device.
const net = require("node:net");
const http = require("node:http");

/** ip -> { http: port, ynca: port|null } — handed over by the test process. */
const ROUTES = JSON.parse(process.env.YAMAHA_FIXTURE_ROUTES || "{}");

/** The port every Yamaha speaks YNCA on; the fixture servers listen elsewhere. */
const YNCA_PORT = 50000;

/**
 * Refuse a connection the way a host with nothing listening does, so the adapter's own
 * error handling runs unchanged.
 *
 * @param {string} target what was addressed, for the message
 * @returns {Error} an ECONNREFUSED error
 */
function refusal(target) {
  const error = new Error(`connect ECONNREFUSED ${target} (no inventory fixture for this address)`);
  error.code = "ECONNREFUSED";
  return error;
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // Two call shapes reach here: the plain `socket.connect(options, cb)`, and the one
  // `net.connect(options)` produces — Node normalises its arguments first and hands the whole
  // [options, cb] array through as a SINGLE argument. Reading only the first shape is why an
  // earlier version of this hook left every YNCA connection running into the real network.
  const normalised = Array.isArray(args[0]) ? args[0] : args;
  const options = normalised[0];
  // Only the options form with an explicit YNCA port and host can address a device. Anything
  // else — a bare connect(), a path, a port-only call — belongs to something that is not a
  // receiver (the states/objects database, for one) and is handed on exactly as it came in.
  const isDeviceCall =
    typeof options === "object" && options !== null && options.port === YNCA_PORT && typeof options.host === "string";
  if (!isDeviceCall) {
    return realConnect.apply(this, args);
  }
  const route = ROUTES[options.host];
  if (!route || !route.ynca) {
    // A device the fixture gives no YNCA port to must look like a receiver that does not answer
    // on 50000 — that is what makes an XML-only or MusicCast-only device single-transport.
    setImmediate(() => this.destroy(refusal(`${options.host}:${YNCA_PORT}`)));
    return this;
  }
  // Rewrite IN PLACE. Node marks its normalised argument array with an internal symbol and
  // re-normalises anything that lacks it — a freshly built array is rejected with ERR_MISSING_ARGS.
  normalised[0] = { ...options, host: "127.0.0.1", port: route.ynca };
  return realConnect.apply(this, args);
};

/**
 * The fixture port for an HTTP call's destination, or undefined when the call does not
 * address one of the fixture devices.
 *
 * @param {any} first the first argument of http.request/http.get
 * @returns {{options: any, port: number}|undefined} the rewritten options and the fixture port
 */
function deviceTarget(first) {
  // The MusicCast client addresses the device with a URL string, the XML client with an options
  // object. Both shapes have to be recognised — reading only the object form left every
  // MusicCast request going to the real address while XML already answered from the fixture.
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(String(first));
    const route = ROUTES[url.hostname];
    if (!route) {
      return undefined;
    }
    url.hostname = "127.0.0.1";
    url.port = String(route.http);
    return { options: url.toString(), port: route.http };
  }
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const host = first.hostname || first.host;
  if (typeof host !== "string") {
    return undefined;
  }
  const route = ROUTES[host.replace(/:\d+$/, "")];
  return route
    ? { options: { ...first, hostname: "127.0.0.1", host: "127.0.0.1", port: route.http }, port: route.http }
    : undefined;
}

const realRequest = http.request;
http.request = function request(...args) {
  const target = deviceTarget(args[0]);
  return target ? realRequest.call(http, target.options, ...args.slice(1)) : realRequest.apply(http, args);
};

const realGet = http.get;
http.get = function get(...args) {
  const target = deviceTarget(args[0]);
  return target ? realGet.call(http, target.options, ...args.slice(1)) : realGet.apply(http, args);
};

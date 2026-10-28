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
  const error = /** @type {NodeJS.ErrnoException} */ (
    new Error(`connect ECONNREFUSED ${target} (no inventory fixture for this address)`)
  );
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
    return Reflect.apply(realConnect, this, args);
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
  return Reflect.apply(realConnect, this, args);
};

/**
 * The fixture port for an HTTP call's destination, or undefined when the call does not
 * address one of the fixture devices.
 *
 * @param {unknown} first the first argument of http.request/http.get
 * @returns {{options: string | Record<string, unknown>, port: number}|undefined} the rewritten options and the fixture port
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
  const given = /** @type {Record<string, unknown>} */ (first);
  const host = given.hostname || given.host;
  if (typeof host !== "string") {
    return undefined;
  }
  const route = ROUTES[host.replace(/:\d+$/, "")];
  return route
    ? { options: { ...given, hostname: "127.0.0.1", host: "127.0.0.1", port: route.http }, port: route.http }
    : undefined;
}

const realRequest = http.request;
http.request = function request(...args) {
  const target = deviceTarget(args[0]);
  return Reflect.apply(realRequest, http, target ? [target.options, ...args.slice(1)] : args);
};

const realGet = http.get;
http.get = function get(...args) {
  const target = deviceTarget(args[0]);
  return Reflect.apply(realGet, http, target ? [target.options, ...args.slice(1)] : args);
};

// UDP stays inside the run (round 104, measured 2026-10-07: the network search sent its M-SEARCH into the real LAN and
// receivers there answered). A datagram to an address that is neither this machine nor a fixture device — the SSDP
// multicast group, a broadcast, a host of the LAN — is dropped as if the network lost it, and a datagram from such an
// address never reaches the adapter. The sockets are still bound and joined as in production, so the suites about the
// chosen address see them; only nothing outside the fixtures takes part.
const dgram = require("node:dgram");

/**
 * Whether an address belongs to this run: this machine or a fixture device.
 *
 * @param {unknown} address the address
 * @returns {boolean} true when the datagram may pass
 */
function insideTheRun(address) {
  return typeof address === "string" && (/^127\./.test(address) || address === "::1" || address in ROUTES);
}

const realSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function send(...args) {
  // send(msg, port, address, cb) or send(msg, offset, length, port, address, cb); a connected socket names no address
  const withOffset = typeof args[1] === "number" && typeof args[2] === "number";
  const address = withOffset ? args[4] : args[2];
  if (typeof address !== "string" || insideTheRun(address)) {
    return Reflect.apply(realSend, this, args);
  }
  const callback = args.findLast(a => typeof a === "function");
  if (callback) {
    setImmediate(() => callback(null, 0));
  }
  return undefined;
};

const realEmit = dgram.Socket.prototype.emit;
dgram.Socket.prototype.emit = function emit(event, ...rest) {
  if (event === "message" && rest[1] && !insideTheRun(rest[1].address)) {
    return false;
  }
  return Reflect.apply(realEmit, this, [event, ...rest]);
};

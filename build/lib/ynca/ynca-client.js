"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ynca_client_exports = {};
__export(ynca_client_exports, {
  YNCA_PORT: () => YNCA_PORT,
  YncaClient: () => YncaClient
});
module.exports = __toCommonJS(ynca_client_exports);
var import_node_net = require("node:net");
var import_line_buffer = require("./line-buffer");
var import_protocol = require("./protocol");
var import_capability = require("./capability");
var import_command_gate = require("../lifecycle/command-gate");
const YNCA_PORT = 5e4;
const SWEEP_MARKER_TIMEOUT_MS = 5e3;
const CONNECT_TIMEOUT_MS = 5e3;
const REFUSAL_ATTRIBUTION_MS = 2e3;
const KEEPALIVE_INTERVAL_MS = 3e4;
function defaultFactory(host, port) {
  const socket = (0, import_node_net.connect)({ host, port });
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.on("timeout", () => socket.destroy(new Error("connect timeout")));
  socket.on("connect", () => socket.setTimeout(0));
  return {
    write: (data) => {
      socket.write(data);
    },
    destroy: () => {
      socket.destroy();
    },
    onData: (handler) => {
      socket.on("data", (chunk) => handler(chunk.toString()));
    },
    onConnect: (handler) => {
      socket.on("connect", handler);
    },
    onClose: (handler) => {
      socket.on("close", handler);
    },
    onError: (handler) => {
      socket.on("error", handler);
    }
  };
}
class YncaClient {
  /**
   * @param host the receiver IP or hostname
   * @param timers adapter-managed timers, so no native timer outlives onUnload
   * @param gate the device's command gate — EVERY line this client puts on the wire goes
   *   through it, so the specification's 100 ms spacing holds across user writes, the init
   *   sweep, the keepalive and browsing alike
   * @param factory socket factory (defaults to a node:net socket)
   */
  constructor(host, timers, gate, factory = defaultFactory) {
    this.host = host;
    this.timers = timers;
    this.gate = gate;
    this.factory = factory;
  }
  socket;
  lineBuffer = new import_line_buffer.LineBuffer();
  messageHandlers = [];
  dropHandler;
  refusalHandler;
  /** The last user PUT actually written, so a refusal right after it can be attributed. */
  lastUserWrite;
  reachable = false;
  everReachable = false;
  closed = false;
  keepaliveTimer;
  lastError;
  /** A genuine drop that fired before onDrop was registered — delivered once it is. */
  pendingDrop = false;
  /**
   * Open the connection. Resolves on the first successful connect, rejects if the
   * first connection attempt errors before connecting.
   *
   * @returns a promise that resolves once connected
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.openSocket(resolve, reject);
    });
  }
  openSocket(onFirstConnect, onFirstError) {
    const socket = this.factory(this.host, YNCA_PORT);
    this.socket = socket;
    socket.onConnect(() => {
      this.reachable = true;
      this.everReachable = true;
      onFirstConnect == null ? void 0 : onFirstConnect();
    });
    socket.onData((chunk) => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
    socket.onError((err) => {
      this.lastError = err;
      if (!this.reachable) {
        onFirstError == null ? void 0 : onFirstError(err);
      }
    });
  }
  handleData(chunk) {
    var _a;
    for (const line of this.lineBuffer.push(chunk)) {
      const response = (0, import_protocol.decodeLine)(line);
      if (response.status === "ok") {
        const message = { subunit: response.subunit, func: response.func, value: response.value };
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      } else if (response.status === "restricted" || response.status === "undefined") {
        const write = this.lastUserWrite;
        if (write && Date.now() - write.at <= REFUSAL_ATTRIBUTION_MS) {
          this.lastUserWrite = void 0;
          (_a = this.refusalHandler) == null ? void 0 : _a.call(this, write.line, response.status);
        }
      }
    }
  }
  handleClose() {
    var _a;
    this.reachable = false;
    this.stopKeepalive();
    if (this.closed) {
      return;
    }
    (_a = this.socket) == null ? void 0 : _a.destroy();
    this.socket = void 0;
    if (this.everReachable) {
      if (this.dropHandler) {
        this.dropHandler(this.lastError);
      } else {
        this.pendingDrop = true;
      }
    }
  }
  /**
   * Start the keepalive poll. Call once, AFTER the init sweep has finished — not on
   * connect — so the 30 s `@SYS:MODELNAME=?` poll never fires a command into the
   * paced sweep and breaks the ~100 ms spacing the receiver needs. The poll keeps
   * the otherwise-idle YNCA socket open (the ynca-spec keepalive, supported by every
   * model); it self-reschedules and is stopped on drop and on close.
   */
  startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = this.timers.schedule(() => {
      this.get("SYS", "MODELNAME");
      this.startKeepalive();
    }, KEEPALIVE_INTERVAL_MS);
  }
  /** Cancel the keepalive timer, if any. */
  stopKeepalive() {
    this.timers.cancel(this.keepaliveTimer);
    this.keepaliveTimer = void 0;
  }
  /**
   * Send a PUT command. Queued as a USER command: a button press must not sit behind a
   * ~190-line init sweep.
   *
   * @param subunit target subunit (e.g. `MAIN`)
   * @param func function name (e.g. `PWR`)
   * @param value value to set
   */
  send(subunit, func, value) {
    const line = (0, import_protocol.encodeCommand)(subunit, func, value);
    void this.writeLine(line, "user").then(() => {
      this.lastUserWrite = { line, at: Date.now() };
    });
  }
  /**
   * Register the handler called when the device REFUSES a user command
   * (`@RESTRICTED`: not possible right now / not allowed; `@UNDEFINED`: this model
   * does not know the function). The controller logs it — a dead button must leave
   * a trace.
   *
   * @param handler called with the refused command line and the device's verdict
   */
  onRefusal(handler) {
    this.refusalHandler = handler;
  }
  /**
   * Send a GET request (background priority — reads yield to user commands).
   *
   * @param subunit target subunit
   * @param func function name
   */
  get(subunit, func) {
    void this.writeLine((0, import_protocol.encodeGet)(subunit, func), "background");
  }
  /**
   * Put one line on the wire through the command gate — the single choke point that keeps
   * the specification's spacing. NEVER rejects: a closed gate is the normal teardown path,
   * and a socket write that fails reports through the socket's own error/close handlers
   * (the drop the supervisor reconnects on). A rejection here would surface as an
   * unhandled promise rejection in the fire-and-forget send()/get() callers — and
   * js-controller stops the adapter on those.
   *
   * @param line the encoded YNCA line (without the terminator)
   * @param priority user command or background read
   * @returns resolves once the line was written, or once it is clear it never will be
   */
  writeLine(line, priority) {
    return this.gate.run(() => {
      var _a;
      (_a = this.socket) == null ? void 0 : _a.write(`${line}\r
`);
    }, priority).catch((e) => {
      if (!(e instanceof import_command_gate.CommandGateClosedError)) {
        this.lastError = e instanceof Error ? e : new Error(String(e));
      }
    });
  }
  /**
   * Register a handler for decoded messages from the receiver.
   *
   * @param handler called with each ok message
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }
  /**
   * Register the handler called once when an established connection drops (not on an
   * explicit close, and not for a socket that never connected). The supervisor uses
   * it to reconnect; the optional reason is the last socket error, for logging.
   *
   * @param handler called on an unexpected drop, with the last error if any
   */
  onDrop(handler) {
    this.dropHandler = handler;
    if (this.pendingDrop) {
      this.pendingDrop = false;
      handler(this.lastError);
    }
  }
  /**
   * Run an init sweep: send a GET for each requested function and collect the responses.
   *
   * Pacing is the command gate's job — every GET goes through it, so the sweep is spaced
   * against user writes and the keepalive instead of only against itself.
   *
   * The end of the sweep is CONFIRMED, not guessed: after the last GET the sweep sends
   * `@SYS:VERSION=?` as a closing marker and waits for its answer (every receiver answers
   * it — the reference implementation syncs on the same function). A fixed settle window
   * would silently drop the functions of a busy receiver that answers a moment late, and
   * those datapoints would then never be created.
   *
   * @param gets the subunit/function pairs to query
   * @returns the assembled capabilities
   */
  async readCapabilities(gets) {
    const collected = [];
    let markerSeen;
    const collector = (message) => {
      collected.push(message);
      if (message.subunit === "SYS" && message.func === "VERSION") {
        markerSeen == null ? void 0 : markerSeen();
      }
    };
    this.messageHandlers.push(collector);
    try {
      for (const request of gets) {
        if (!this.reachable) {
          throw new Error("connection lost during capability sweep");
        }
        await this.writeLine((0, import_protocol.encodeGet)(request.subunit, request.func), "background");
      }
      if (!this.reachable) {
        throw new Error("connection lost during capability sweep");
      }
      await this.awaitSweepMarker((handler) => markerSeen = handler);
      return (0, import_capability.buildCapabilities)(collected);
    } finally {
      const index = this.messageHandlers.indexOf(collector);
      if (index >= 0) {
        this.messageHandlers.splice(index, 1);
      }
    }
  }
  /**
   * Send the closing marker and wait for the device to answer it — or for the timeout,
   * so an unusual firmware that stays silent costs a delay, never the whole connection.
   *
   * @param arm registers the resolve callback with the sweep's collector
   * @returns resolves when the marker was answered or the wait timed out
   */
  async awaitSweepMarker(arm) {
    let settled = false;
    const answered = new Promise((resolve) => {
      arm(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
    await this.writeLine((0, import_protocol.encodeGet)("SYS", "VERSION"), "background");
    await Promise.race([
      answered,
      this.gate.delay(SWEEP_MARKER_TIMEOUT_MS).then(() => {
        settled = true;
      })
    ]);
  }
  /** Whether the connection is currently up. */
  isReachable() {
    return this.reachable;
  }
  /**
   * Close the connection permanently (no reconnect). Synchronous — safe to call from
   * onUnload. Closing the gate empties its queue and aborts its signal, so a sweep or a
   * browse walk that is still awaiting ends instead of hanging on a cancelled timer.
   */
  close() {
    var _a;
    this.closed = true;
    this.reachable = false;
    this.stopKeepalive();
    this.gate.close();
    (_a = this.socket) == null ? void 0 : _a.destroy();
    this.socket = void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YNCA_PORT,
  YncaClient
});
//# sourceMappingURL=ynca-client.js.map

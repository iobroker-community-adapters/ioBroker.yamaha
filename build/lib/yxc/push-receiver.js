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
var push_receiver_exports = {};
__export(push_receiver_exports, {
  YxcPushReceiver: () => YxcPushReceiver
});
module.exports = __toCommonJS(push_receiver_exports);
var import_node_dgram = require("node:dgram");
const YXC_PUSH_PORT = 41100;
const REBIND_DELAY_MS = 1e4;
function defaultFactory() {
  const socket = (0, import_node_dgram.createSocket)("udp4");
  return {
    onMessage: (handler) => {
      socket.on("message", (msg, rinfo) => handler(msg.toString(), rinfo.address));
    },
    onError: (handler) => {
      socket.on("error", handler);
    },
    onListening: (handler) => {
      socket.on("listening", handler);
    },
    bind: (port) => {
      socket.bind(port);
    },
    close: () => {
      socket.close();
    }
  };
}
class YxcPushReceiver {
  /**
   * @param deps adapter logger and timer callbacks
   * @param factory socket factory (defaults to a node:dgram socket)
   */
  constructor(deps, factory = defaultFactory) {
    this.deps = deps;
    this.factory = factory;
  }
  socket;
  handlers = /* @__PURE__ */ new Map();
  listening = false;
  closed = false;
  retryTimer;
  /**
   * Register a handler for pushes from a device IP.
   *
   * @param ip the device IP, matched against the UDP source address
   * @param onPush invoked with each parsed push event from that IP
   * @returns a function that unregisters this handler
   */
  register(ip, onPush) {
    this.handlers.set(ip, onPush);
    return () => {
      this.handlers.delete(ip);
    };
  }
  /** Open the shared socket and start listening on :41100. */
  start() {
    const socket = this.factory();
    this.socket = socket;
    socket.onError((err) => this.handleError(err));
    socket.onMessage((payload, address) => this.dispatch(payload, address));
    socket.onListening(() => {
      this.listening = true;
      this.deps.log.debug(`YXC push receiver listening on :${YXC_PUSH_PORT}`);
    });
    socket.bind(YXC_PUSH_PORT);
  }
  handleError(err) {
    var _a;
    (_a = this.socket) == null ? void 0 : _a.close();
    this.socket = void 0;
    if (this.closed) {
      return;
    }
    if (!this.listening) {
      this.deps.log.warn(
        `YXC push port :${YXC_PUSH_PORT} unavailable \u2014 MusicCast devices are polled, not pushed: ${err.message}`
      );
      return;
    }
    this.listening = false;
    this.deps.log.warn(`YXC push socket error, rebinding in ${REBIND_DELAY_MS / 1e3}s: ${err.message}`);
    this.retryTimer = this.deps.schedule(() => this.start(), REBIND_DELAY_MS);
  }
  /** Close the socket and cancel any pending rebind. Synchronous — safe from onUnload. */
  close() {
    var _a;
    this.closed = true;
    this.deps.cancel(this.retryTimer);
    this.retryTimer = void 0;
    (_a = this.socket) == null ? void 0 : _a.close();
    this.socket = void 0;
  }
  /**
   * Route one datagram to the handler for its source IP, ignoring unknown senders
   * and malformed payloads.
   *
   * @param payload the datagram payload text
   * @param address the source IP
   */
  dispatch(payload, address) {
    const handler = this.handlers.get(address);
    if (!handler) {
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      this.deps.log.debug(`ignoring malformed YXC push from ${address}`);
      return;
    }
    handler(event);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YxcPushReceiver
});
//# sourceMappingURL=push-receiver.js.map

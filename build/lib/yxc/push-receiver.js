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
   * @param log logger for diagnostics
   * @param factory socket factory (defaults to a node:dgram socket)
   */
  constructor(log, factory = defaultFactory) {
    this.log = log;
    this.factory = factory;
  }
  socket;
  handlers = /* @__PURE__ */ new Map();
  /**
   * Register a handler for pushes from a device IP.
   *
   * @param ip the device IP, matched against the UDP source address
   * @param onPush invoked with each parsed push event from that IP
   */
  register(ip, onPush) {
    this.handlers.set(ip, onPush);
  }
  /** Open the shared socket and start listening on :41100. */
  start() {
    const socket = this.factory();
    this.socket = socket;
    socket.onError((err) => {
      this.log.warn(`YXC push port unavailable \u2014 MusicCast devices are polled, not pushed: ${err.message}`);
      this.socket = void 0;
    });
    socket.onMessage((payload, address) => this.dispatch(payload, address));
    socket.onListening(() => this.log.debug(`YXC push receiver listening on :${YXC_PUSH_PORT}`));
    socket.bind(YXC_PUSH_PORT);
  }
  /** Close the socket synchronously — safe to call from onUnload. */
  close() {
    var _a;
    (_a = this.socket) == null ? void 0 : _a.close();
    this.socket = void 0;
  }
  /**
   * Route one datagram to the handler for its source IP, ignoring unknown
   * senders and malformed payloads.
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
      this.log.debug(`ignoring malformed YXC push from ${address}`);
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

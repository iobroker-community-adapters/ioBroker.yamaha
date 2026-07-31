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
var import_reconnect_strategy = require("./reconnect-strategy");
const YNCA_PORT = 5e4;
const RECONNECT_BASE_MS = 1e3;
const RECONNECT_MAX_MS = 3e4;
function defaultFactory(host, port) {
  const socket = (0, import_node_net.connect)({ host, port });
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
   * @param factory socket factory (defaults to a node:net socket)
   */
  constructor(host, factory = defaultFactory) {
    this.host = host;
    this.factory = factory;
  }
  socket;
  lineBuffer = new import_line_buffer.LineBuffer();
  messageHandlers = [];
  reconnect = new import_reconnect_strategy.ReconnectStrategy(RECONNECT_BASE_MS, RECONNECT_MAX_MS);
  reconnectTimer;
  reachable = false;
  closed = false;
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
      this.reconnect.reset();
      onFirstConnect == null ? void 0 : onFirstConnect();
    });
    socket.onData((chunk) => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
    socket.onError((err) => {
      if (!this.reachable) {
        onFirstError == null ? void 0 : onFirstError(err);
      }
    });
  }
  handleData(chunk) {
    for (const line of this.lineBuffer.push(chunk)) {
      const response = (0, import_protocol.decodeLine)(line);
      if (response.status === "ok") {
        const message = { subunit: response.subunit, func: response.func, value: response.value };
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      }
    }
  }
  handleClose() {
    var _a;
    this.reachable = false;
    if (this.closed) {
      return;
    }
    (_a = this.socket) == null ? void 0 : _a.destroy();
    this.socket = void 0;
    this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnect.nextDelay());
  }
  /**
   * Send a PUT command.
   *
   * @param subunit target subunit (e.g. `MAIN`)
   * @param func function name (e.g. `PWR`)
   * @param value value to set
   */
  send(subunit, func, value) {
    var _a;
    (_a = this.socket) == null ? void 0 : _a.write(`${(0, import_protocol.encodeCommand)(subunit, func, value)}\r
`);
  }
  /**
   * Send a GET request.
   *
   * @param subunit target subunit
   * @param func function name
   */
  get(subunit, func) {
    var _a;
    (_a = this.socket) == null ? void 0 : _a.write(`${(0, import_protocol.encodeGet)(subunit, func)}\r
`);
  }
  /**
   * Register a handler for decoded messages from the receiver.
   *
   * @param handler called with each ok message
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }
  /** Whether the connection is currently up. */
  isReachable() {
    return this.reachable;
  }
  /** Close the connection permanently (no reconnect). Synchronous — safe to call from onUnload. */
  close() {
    var _a;
    this.closed = true;
    this.reachable = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
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

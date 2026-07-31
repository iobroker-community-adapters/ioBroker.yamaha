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
var command_router_exports = {};
__export(command_router_exports, {
  CommandRouter: () => CommandRouter
});
module.exports = __toCommonJS(command_router_exports);
const YXC_EXCLUSIVE_PREFIXES = ["netusb", "tuner", "cd", "clock", "dist"];
class CommandRouter {
  /**
   * Resolve which protocol should carry a command for a device.
   *
   * @param device the target device with its known protocols
   * @param command the command to route
   * @returns the chosen protocol, or "skip" if none can serve it
   */
  resolveTransport(device, command) {
    if (isYxcExclusive(command.kind)) {
      return device.protocols.has("yxc") ? "yxc" : "skip";
    }
    if (device.protocols.has("ynca")) {
      return "ynca";
    }
    if (device.protocols.has("yxc")) {
      return "yxc";
    }
    if (device.protocols.has("xml")) {
      return "xml";
    }
    return "skip";
  }
}
function isYxcExclusive(kind) {
  return YXC_EXCLUSIVE_PREFIXES.some((prefix) => kind === prefix || kind.startsWith(`${prefix}.`));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandRouter
});
//# sourceMappingURL=command-router.js.map

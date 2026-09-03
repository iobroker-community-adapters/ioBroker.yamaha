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
var network_interfaces_exports = {};
__export(network_interfaces_exports, {
  searchInterfaces: () => searchInterfaces
});
module.exports = __toCommonJS(network_interfaces_exports);
function searchInterfaces(configured, ifaces) {
  if (configured && configured !== "0.0.0.0") {
    return [configured];
  }
  const addresses = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list != null ? list : []) {
      if (!info.internal && (info.family === "IPv4" || info.family === 4)) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  searchInterfaces
});
//# sourceMappingURL=network-interfaces.js.map

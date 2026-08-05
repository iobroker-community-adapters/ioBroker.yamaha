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
var pure_helpers_exports = {};
__export(pure_helpers_exports, {
  legacyDeviceRow: () => legacyDeviceRow,
  parseDevices: () => parseDevices,
  sanitizeId: () => sanitizeId,
  staleObjects: () => staleObjects,
  stripNamespace: () => stripNamespace
});
module.exports = __toCommonJS(pure_helpers_exports);
function isConfiguredDevice(entry) {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry;
  return typeof candidate.name === "string" && candidate.name.length > 0 && typeof candidate.ip === "string" && candidate.ip.length > 0;
}
function sanitizeId(raw) {
  return raw.replace(/[^A-Za-z0-9\-_]/g, "_");
}
function stripNamespace(fullId, namespace) {
  return fullId.slice(namespace.length + 1);
}
function parseDevices(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const records = [];
  const taken = /* @__PURE__ */ new Set(["info"]);
  for (const entry of raw) {
    if (!isConfiguredDevice(entry)) {
      continue;
    }
    const id = sanitizeId(entry.name);
    if (taken.has(id)) {
      continue;
    }
    taken.add(id);
    records.push({ id, ip: entry.ip });
  }
  return records;
}
function staleObjects(existing, deviceIds, namespace) {
  if (deviceIds.size === 0) {
    return [];
  }
  const isKept = (fullId) => {
    const top = stripNamespace(fullId, namespace).split(".")[0];
    return top === "info" || deviceIds.has(top);
  };
  return existing.filter((id) => !isKept(id)).sort((a, b) => b.length - a.length);
}
function legacyDeviceRow(config) {
  if (Array.isArray(config.devices) && config.devices.length > 0) {
    return void 0;
  }
  const ip = typeof config.ip === "string" && config.ip ? config.ip : typeof config.IP === "string" && config.IP ? config.IP : void 0;
  return ip ? { name: ip, ip } : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  legacyDeviceRow,
  parseDevices,
  sanitizeId,
  staleObjects,
  stripNamespace
});
//# sourceMappingURL=pure-helpers.js.map

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
  orphanedObjects: () => orphanedObjects,
  parseDevices: () => parseDevices,
  sanitizeId: () => sanitizeId,
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
  for (const entry of raw) {
    if (isConfiguredDevice(entry)) {
      records.push({ id: sanitizeId(entry.name), ip: entry.ip, protocols: /* @__PURE__ */ new Set() });
    }
  }
  return records;
}
function orphanedObjects(existing, created, namespace) {
  const info = `${namespace}.info`;
  return existing.filter((id) => id !== info && !id.startsWith(`${info}.`) && !created.has(id));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  orphanedObjects,
  parseDevices,
  sanitizeId,
  stripNamespace
});
//# sourceMappingURL=pure-helpers.js.map

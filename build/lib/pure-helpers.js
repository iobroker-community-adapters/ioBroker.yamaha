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
  RENAMED_CHANNELS: () => RENAMED_CHANNELS,
  RENAMED_STATE_IDS: () => RENAMED_STATE_IDS,
  legacyDeviceRow: () => legacyDeviceRow,
  mergeDiscovered: () => mergeDiscovered,
  parseDevices: () => parseDevices,
  renamedObjectIds: () => renamedObjectIds,
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
  return typeof candidate.ip === "string" && candidate.ip.length > 0 && (candidate.name === void 0 || typeof candidate.name === "string");
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
    const id = sanitizeId(entry.name && entry.name.length > 0 ? entry.name : entry.ip);
    if (taken.has(id)) {
      continue;
    }
    taken.add(id);
    records.push({ id, ip: entry.ip });
  }
  return records;
}
function mergeDiscovered(known, found) {
  const byIp = /* @__PURE__ */ new Map();
  const takenIds = /* @__PURE__ */ new Set(["info"]);
  for (const device of known) {
    if (byIp.has(device.ip) || takenIds.has(device.id)) {
      continue;
    }
    byIp.set(device.ip, device);
    takenIds.add(device.id);
  }
  for (const device of found) {
    if (byIp.has(device.ip)) {
      continue;
    }
    const id = sanitizeId(device.name || device.ip);
    if (takenIds.has(id)) {
      continue;
    }
    takenIds.add(id);
    byIp.set(device.ip, { id, ip: device.ip });
  }
  return [...byIp.values()];
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
const RENAMED_STATE_IDS = ["hdmiOut", "directMode"];
const RENAMED_CHANNELS = ["system"];
function renamedObjectIds(existing, deviceIds, namespace) {
  const stale = [];
  for (const deviceId of deviceIds) {
    const base = `${namespace}.${deviceId}.`;
    for (const full of existing) {
      if (!full.startsWith(base)) {
        continue;
      }
      const rel = full.slice(base.length);
      const renamedState = RENAMED_STATE_IDS.includes(rel);
      const underRenamedChannel = RENAMED_CHANNELS.some((ch) => rel === ch || rel.startsWith(`${ch}.`));
      if (renamedState || underRenamedChannel) {
        stale.push(full);
      }
    }
  }
  return stale.sort((a, b) => b.length - a.length);
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
  RENAMED_CHANNELS,
  RENAMED_STATE_IDS,
  legacyDeviceRow,
  mergeDiscovered,
  parseDevices,
  renamedObjectIds,
  sanitizeId,
  staleObjects,
  stripNamespace
});
//# sourceMappingURL=pure-helpers.js.map

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
var device_management_helpers_exports = {};
__export(device_management_helpers_exports, {
  TRANSPORTS: () => TRANSPORTS,
  buildDeviceForm: () => buildDeviceForm,
  findClash: () => findClash,
  rowId: () => rowId
});
module.exports = __toCommonJS(device_management_helpers_exports);
var import_i18n = require("./lib/i18n");
var import_pure_helpers = require("./lib/pure-helpers");
var import_ready_line = require("./lib/ready-line");
const RESERVED_IDS = /* @__PURE__ */ new Set(["info"]);
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const TRANSPORTS = import_ready_line.TRANSPORT_LABELS;
function rowId(row) {
  return (0, import_pure_helpers.sanitizeId)(row.name && row.name.length > 0 ? row.name : row.ip);
}
function buildDeviceForm(usedIps) {
  const ipList = JSON.stringify([...usedIps]);
  return {
    type: "panel",
    items: {
      name: {
        type: "text",
        label: (0, import_i18n.t)("columnName"),
        sm: 12,
        md: 6
      },
      ip: {
        type: "text",
        label: (0, import_i18n.t)("columnIp"),
        validator: `!!(data.ip && ${IP_RE.toString()}.test(data.ip)) && !${ipList}.includes(data.ip)`,
        validatorErrorText: (0, import_i18n.t)("invalidIp"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 6
      }
    }
  };
}
function findClash(rows, candidate, exceptIndex) {
  const id = rowId(candidate);
  if (id === "" || RESERVED_IDS.has(id) || !IP_RE.test(candidate.ip)) {
    return (0, import_i18n.t)("invalidIp");
  }
  for (let i = 0; i < rows.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (rows[i].ip === candidate.ip || rowId(rows[i]) === id) {
      return (0, import_i18n.t)("invalidIp");
    }
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TRANSPORTS,
  buildDeviceForm,
  findClash,
  rowId
});
//# sourceMappingURL=device-management-helpers.js.map

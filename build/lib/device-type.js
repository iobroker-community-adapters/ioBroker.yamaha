"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_type_exports = {};
__export(device_type_exports, {
  DEVICE_TYPE_ICONS: () => DEVICE_TYPE_ICONS,
  detectDeviceType: () => detectDeviceType,
  iconForModel: () => iconForModel,
});
module.exports = __toCommonJS(device_type_exports);
const TYPE_PREFIXES = [
  ["stereoReceiver", ["R-N", "RN-", "WXA", "WXC", "A-S", "R-S"]],
  ["soundbar", ["YSP", "YAS", "ATS", "SRT", "SR-B", "SR-C", "MUSICCAST BAR"]],
  ["cdSystem", ["CRX", "MCR", "CD-N", "CD-NT"]],
  ["speaker", ["WX", "NX-", "ISX", "MUSICCAST 20", "MUSICCAST 50", "MUSICCAST 500"]],
  ["avReceiver", ["RX-V", "RX-A", "RX-S", "TSR", "HTR", "CX-A", "MX-A", "RX-D"]],
];
function detectDeviceType(model) {
  const normalized = (model != null ? model : "").trim().toUpperCase();
  if (normalized.length > 0) {
    for (const [type, prefixes] of TYPE_PREFIXES) {
      if (prefixes.some(prefix => normalized.startsWith(prefix))) {
        return type;
      }
    }
  }
  return "avReceiver";
}
function svgUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
const S = 'fill="none" stroke="#8a8f98" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const DEVICE_TYPE_ICONS = {
  // Wide box, display slit left, one big volume knob right.
  avReceiver: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}><rect x="2" y="7" width="20" height="10" rx="1.5"/><rect x="5" y="10" width="7" height="2.4"/><circle cx="17.5" cy="12" r="2.4"/><path d="M5 17v2M19 17v2"/></g></svg>`,
  ),
  // Box with two large knobs and a tuning scale line.
  stereoReceiver: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}><rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M5 10h14"/><circle cx="8" cy="13.5" r="1.8"/><circle cx="16" cy="13.5" r="1.8"/><path d="M5 17v2M19 17v2"/></g></svg>`,
  ),
  // Upright cabinet: small tweeter above a large woofer.
  speaker: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}><rect x="7" y="3" width="10" height="18" rx="1.5"/><circle cx="12" cy="8" r="1.3"/><circle cx="12" cy="15" r="3"/></g></svg>`,
  ),
  // Flat long bar with a speaker-grille dot row.
  soundbar: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}><rect x="2" y="10" width="20" height="5" rx="2.5"/><path d="M6 12.5h.01M9.5 12.5h.01M13 12.5h.01M16.5 12.5h.01" stroke-width="2"/></g></svg>`,
  ),
  // Box with a disc (ring + hub) and the tray slit.
  cdSystem: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}><rect x="2" y="6" width="20" height="12" rx="1.5"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="0.8"/><path d="M5 15.5h4"/></g></svg>`,
  ),
};
function iconForModel(model) {
  return DEVICE_TYPE_ICONS[detectDeviceType(model)];
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    DEVICE_TYPE_ICONS,
    detectDeviceType,
    iconForModel,
  });
//# sourceMappingURL=device-type.js.map

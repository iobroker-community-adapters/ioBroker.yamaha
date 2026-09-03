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
var ready_line_exports = {};
__export(ready_line_exports, {
  TRANSPORT_LABELS: () => TRANSPORT_LABELS,
  readyLine: () => readyLine,
});
module.exports = __toCommonJS(ready_line_exports);
const TRANSPORT_LABELS = [
  { id: "ynca", label: "YNCA" },
  { id: "yxc", label: "MusicCast" },
  { id: "xml", label: "XML" },
];
function readyLine(deviceId, transportIds) {
  const live = new Set(transportIds);
  const parts = TRANSPORT_LABELS.filter(({ id }) => live.has(id)).map(({ label }) => `${label} \u2713`);
  return `${deviceId}: ready \u2014 ${parts.join("  ")}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    TRANSPORT_LABELS,
    readyLine,
  });
//# sourceMappingURL=ready-line.js.map

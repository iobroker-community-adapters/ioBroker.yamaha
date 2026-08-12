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
var owner_policy_exports = {};
__export(owner_policy_exports, {
  pickOwner: () => pickOwner,
  resolveOwnership: () => resolveOwnership
});
module.exports = __toCommonJS(owner_policy_exports);
const MODERNITY = ["yxc", "ynca", "xml"];
const OWNER_OVERRIDES = {
  // §3a scale conflict — YXC volume is the raw 0..161 device scale, YNCA/XML are dB. Keep dB.
  volume: ["ynca", "xml", "yxc"],
  // §3c write loss — YXC is read-only for these, YNCA (and often XML) is writable.
  maxVolume: ["ynca", "xml", "yxc"],
  extraBass: ["ynca", "xml", "yxc"],
  adaptiveDrc: ["ynca", "xml", "yxc"],
  surroundDecoder: ["ynca", "yxc"],
  "media.playback": ["ynca", "yxc"],
  "media.repeat": ["ynca", "yxc"],
  "media.shuffle": ["ynca", "yxc"],
  // §3d richness loss — YNCA carries an enum dropdown that YXC/XML flatten to a free string.
  input: ["ynca", "yxc", "xml"],
  soundProgram: ["ynca", "yxc", "xml"],
  sleep: ["ynca", "xml", "yxc"],
  "tuner.band": ["ynca", "yxc"]
};
function pickOwner(key, candidates) {
  var _a, _b;
  const preference = (_a = OWNER_OVERRIDES[key]) != null ? _a : MODERNITY;
  const owner = (_b = preference.find((t) => candidates.includes(t))) != null ? _b : MODERNITY.find((t) => candidates.includes(t));
  return owner != null ? owner : candidates[0];
}
function resolveOwnership(offered) {
  var _a;
  const candidates = /* @__PURE__ */ new Map();
  for (const transport of MODERNITY) {
    for (const key of (_a = offered[transport]) != null ? _a : []) {
      const list = candidates.get(key);
      if (list) {
        list.push(transport);
      } else {
        candidates.set(key, [transport]);
      }
    }
  }
  const owners = /* @__PURE__ */ new Map();
  for (const [key, cands] of candidates) {
    owners.set(key, pickOwner(key, cands));
  }
  return owners;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  pickOwner,
  resolveOwnership
});
//# sourceMappingURL=owner-policy.js.map

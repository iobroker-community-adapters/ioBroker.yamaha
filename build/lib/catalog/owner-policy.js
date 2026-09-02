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
  ZONE_PREFIX: () => ZONE_PREFIX,
  canonicalIdOf: () => canonicalIdOf,
  capabilityKeyOf: () => capabilityKeyOf,
  pickOwner: () => pickOwner,
  resolveOwnership: () => resolveOwnership
});
module.exports = __toCommonJS(owner_policy_exports);
const MODERNITY = ["yxc", "ynca", "xml"];
const OWNER_OVERRIDES = {
  // §3a scale conflict — YXC volume is the raw 0..161 device scale, YNCA/XML are dB. Keep dB.
  volume: ["ynca", "xml", "yxc"],
  // §3c write loss — YXC is read-only for these, YNCA (and often XML) is writable.
  "advanced.maxVolume": ["ynca", "xml", "yxc"],
  // §3c write loss on the unified player block (v2.0.0): YXC reads playback/repeat/
  // shuffle but cannot WRITE them (its API has only toggle/transport endpoints, which
  // stay YXC-owned buttons); YNCA sets all three directly. Zone mirrors collapse to
  // the same template, so this covers multiroom.zoneN.player.* too.
  "player.playback": ["ynca", "yxc"],
  "player.repeat": ["ynca", "yxc"],
  "player.shuffle": ["ynca", "yxc"],
  "sound.extraBass": ["ynca", "xml", "yxc"],
  "sound.adaptiveDrc": ["ynca", "xml", "yxc"],
  "sound.surroundDecoder": ["ynca", "yxc"],
  "sound.dialogueLift": ["xml", "yxc"],
  // Write-proof beats modernity rank for the scene TRIGGER (#615): YXC declares the
  // recall endpoint per zone (device-verified), XML declares the write value in its
  // Scene_Sel_Item list — but YNCA's claim rests on the scene NAMES being readable,
  // and the 2012 generation (RX-V473/V475) answers the YNCA scene put with
  // @RESTRICTED (ynca-python PRACTICALITIES). The proven writers go first.
  "scene.recall": ["yxc", "xml", "ynca"],
  // The scene LIST is presentation: number + title per slot. MusicCast knows the slot
  // COUNT but no titles; XML declares the titles per zone, YNCA the main zone's names.
  // By modernity MusicCast would own it and — connecting in seconds while the YNCA
  // names ride a 19 s sweep — publish a title-less list on the first contact that then
  // stands until the next restart. The title sources come first; a MusicCast-only
  // device still owns its list alone.
  "scene.list": ["xml", "ynca", "yxc"],
  // §3d richness loss — YNCA carries an enum dropdown that YXC/XML flatten to a free string.
  input: ["ynca", "yxc", "xml"],
  soundProgram: ["ynca", "yxc", "xml"],
  sleep: ["ynca", "xml", "yxc"],
  "tuner.band": ["ynca", "yxc"]
};
const ZONE_PREFIX = /^multiroom\.zone[234]\./;
const ID_DRIFT = {
  yxc: { subwooferVolume: "sound.subwooferTrim", "multiroom.partyEnable": "multiroom.party" },
  xml: { hdmiOut1: "hdmi.out1", hdmiOut2: "hdmi.out2" }
};
function capabilityKeyOf(transport, stateId) {
  var _a, _b;
  const template = stateId.replace(ZONE_PREFIX, "");
  return (_b = (_a = ID_DRIFT[transport]) == null ? void 0 : _a[template]) != null ? _b : template;
}
function canonicalIdOf(transport, stateId) {
  var _a, _b, _c, _d;
  const zone = (_b = (_a = ZONE_PREFIX.exec(stateId)) == null ? void 0 : _a[0]) != null ? _b : "";
  const template = stateId.slice(zone.length);
  return zone + ((_d = (_c = ID_DRIFT[transport]) == null ? void 0 : _c[template]) != null ? _d : template);
}
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
  ZONE_PREFIX,
  canonicalIdOf,
  capabilityKeyOf,
  pickOwner,
  resolveOwnership
});
//# sourceMappingURL=owner-policy.js.map

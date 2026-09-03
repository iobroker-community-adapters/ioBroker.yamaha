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
var object_tree_coordinator_exports = {};
__export(object_tree_coordinator_exports, {
  coordinateObjectTree: () => coordinateObjectTree,
});
module.exports = __toCommonJS(object_tree_coordinator_exports);
var import_owner_policy = require("./owner-policy");
function coordinateObjectTree(contributions) {
  const byId = /* @__PURE__ */ new Map();
  for (const { transport, objects } of contributions) {
    for (const obj of objects) {
      const canonicalId = (0, import_owner_policy.canonicalIdOf)(transport, obj.id);
      let entry = byId.get(canonicalId);
      if (!entry) {
        entry = { key: (0, import_owner_policy.capabilityKeyOf)(transport, obj.id), defs: /* @__PURE__ */ new Map() };
        byId.set(canonicalId, entry);
      }
      entry.defs.set(transport, obj);
    }
  }
  const ownerByCanonicalId = /* @__PURE__ */ new Map();
  const resolved = [...byId].map(([canonicalId, entry]) => {
    const owner = (0, import_owner_policy.pickOwner)(entry.key, [...entry.defs.keys()]);
    ownerByCanonicalId.set(canonicalId, owner);
    const ownerDef = entry.defs.get(owner);
    if (!ownerDef) {
      throw new Error(`coordinateObjectTree: owner ${owner} has no def for ${canonicalId}`);
    }
    const resolvedDef = { ...ownerDef, id: canonicalId };
    if (!resolvedDef.common.states) {
      for (const def of entry.defs.values()) {
        if (def.common.states) {
          resolvedDef.common = { ...resolvedDef.common, states: def.common.states };
          break;
        }
      }
    }
    return resolvedDef;
  });
  resolved.sort((a, b) => a.id.split(".").length - b.id.split(".").length);
  return { objects: resolved, ownerByCanonicalId };
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    coordinateObjectTree,
  });
//# sourceMappingURL=object-tree-coordinator.js.map

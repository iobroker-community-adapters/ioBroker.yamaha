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
var subunit_cache_exports = {};
__export(subunit_cache_exports, {
  createSubunitCache: () => createSubunitCache,
  isAvailSnapshot: () => isAvailSnapshot,
});
module.exports = __toCommonJS(subunit_cache_exports);
function isAvailSnapshot(value) {
  const candidate = value;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Array.isArray(candidate.subunits) &&
    candidate.subunits.every(entry => typeof entry === "string") &&
    typeof candidate.model === "string" &&
    typeof candidate.firmware === "string"
  );
}
function createSubunitCache(initial, persist) {
  let current = initial;
  return {
    get: () => current,
    set: snapshot => {
      current = snapshot;
      persist(snapshot);
    },
    clear: () => {
      current = void 0;
      persist(void 0);
    },
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    createSubunitCache,
    isAvailSnapshot,
  });
//# sourceMappingURL=subunit-cache.js.map

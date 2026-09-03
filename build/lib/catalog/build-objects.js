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
var build_objects_exports = {};
__export(build_objects_exports, {
  catalogToObjects: () => catalogToObjects,
});
module.exports = __toCommonJS(build_objects_exports);
var import_value_coerce = require("./value-coerce");
var import_types = require("./types");
var import_i18n = require("../i18n");
function capitalize(segment) {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}
function catalogToObjects(entries) {
  var _a;
  const objects = [];
  const channels = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const segments = entry.id.split(".");
    for (let i = 1; i < segments.length; i++) {
      const channelId = segments.slice(0, i).join(".");
      if (!channels.has(channelId)) {
        channels.add(channelId);
        const segment = segments[i - 1];
        objects.push({
          id: channelId,
          type: "channel",
          // A listed channel is translated; an unlisted one keeps its capitalised id, which is
          // a device-derived name and therefore has no translation to give.
          common: {
            name: import_types.CHANNEL_NAME_KEYS[segment]
              ? (0, import_i18n.tName)(import_types.CHANNEL_NAME_KEYS[segment])
              : capitalize(segment),
            ...(import_types.CHANNEL_DESC_KEYS[segment]
              ? { desc: (0, import_i18n.tName)(import_types.CHANNEL_DESC_KEYS[segment]) }
              : {}),
          },
        });
      }
    }
    const common = (0, import_value_coerce.specToCommon)(entry.spec, { write: entry.write, role: entry.role });
    objects.push({
      id: entry.id,
      type: "state",
      common: {
        name: (0, import_i18n.tName)(entry.nameKey, ...((_a = entry.nameArgs) != null ? _a : [])),
        // Only written when the catalog carries one. An absent key means "explains itself" —
        // the fleet standard wants the field empty there, not filled with invented prose.
        ...(entry.descKey ? { desc: (0, import_i18n.tName)(entry.descKey) } : {}),
        ...common,
      },
    });
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    catalogToObjects,
  });
//# sourceMappingURL=build-objects.js.map

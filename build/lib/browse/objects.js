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
var objects_exports = {};
__export(objects_exports, {
  browseObjectDefs: () => browseObjectDefs,
});
module.exports = __toCommonJS(objects_exports);
var import_i18n = require("../i18n");
function browseObjectDefs(sources) {
  const line = n => ({
    id: `player.browse.line${n}`,
    type: "state",
    common: { name: (0, import_i18n.tName)("line", n), type: "string", role: "text", read: true, write: false },
  });
  const button = (id, name) => ({
    id: `player.browse.${id}`,
    type: "state",
    common: { name, type: "boolean", role: "button", read: false, write: true },
  });
  return [
    { id: "player", type: "channel", common: { name: (0, import_i18n.tName)("mediaPlayer") } },
    { id: "player.browse", type: "channel", common: { name: (0, import_i18n.tName)("browse") } },
    {
      id: "player.browse.source",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("source"),
        type: "string",
        role: "state",
        read: true,
        write: true,
        states: sources,
      },
    },
    {
      id: "player.browse.menuName",
      type: "state",
      common: { name: (0, import_i18n.tName)("menuName"), type: "string", role: "text", read: true, write: false },
    },
    {
      id: "player.browse.layer",
      type: "state",
      common: { name: (0, import_i18n.tName)("menuLevel"), type: "number", role: "value", read: true, write: false },
    },
    {
      id: "player.browse.totalItems",
      type: "state",
      common: { name: (0, import_i18n.tName)("totalEntries"), type: "number", role: "value", read: true, write: false },
    },
    {
      id: "player.browse.currentLine",
      type: "state",
      common: { name: (0, import_i18n.tName)("currentLine"), type: "number", role: "value", read: true, write: false },
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(line),
    {
      id: "player.browse.selectLine",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("selectLineFolderOpensItemPlays"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
        max: 8,
        step: 1,
      },
    },
    button("pageUp", (0, import_i18n.tName)("pageUp")),
    button("pageDown", (0, import_i18n.tName)("pageDown")),
    button("back", (0, import_i18n.tName)("back")),
    button("home", (0, import_i18n.tName)("menuRoot")),
    {
      id: "player.browse.path",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("navigatePathEGBookmarksRadioParadise"),
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
    },
    {
      id: "player.browse.rows",
      type: "state",
      common: { name: (0, import_i18n.tName)("rowsJSON"), type: "string", role: "json", read: true, write: false },
    },
    {
      id: "player.browse.busy",
      type: "state",
      common: { name: (0, import_i18n.tName)("busy"), type: "boolean", role: "indicator", read: true, write: false },
    },
  ];
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    browseObjectDefs,
  });
//# sourceMappingURL=objects.js.map

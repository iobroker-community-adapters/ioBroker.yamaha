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
var objects_exports = {};
__export(objects_exports, {
  browseObjectDefs: () => browseObjectDefs,
  remoteObjectDefs: () => remoteObjectDefs
});
module.exports = __toCommonJS(objects_exports);
var import_types = require("../catalog/types");
var import_i18n = require("../i18n");
function browseObjectDefs(sources) {
  const line = (n) => ({
    id: `player.browse.line${n}`,
    type: "state",
    common: { name: (0, import_i18n.tName)("line", n), type: "string", role: "text", read: true, write: false }
  });
  const button = (id, name) => ({
    id: `player.browse.${id}`,
    type: "state",
    common: { name, type: "boolean", role: "button", read: false, write: true }
  });
  return [
    { id: "player", type: "channel", common: { name: (0, import_i18n.tName)("mediaPlayer") } },
    { id: "player.browse", type: "channel", common: { name: (0, import_i18n.tName)("browse") } },
    {
      id: "player.browse.source",
      type: "state",
      common: { name: (0, import_i18n.tName)("source"), type: "string", role: "state", read: true, write: true, states: sources }
    },
    {
      id: "player.browse.menuName",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("menuName"),
        desc: (0, import_i18n.tName)("descMenuName"),
        type: "string",
        role: "text",
        read: true,
        write: false
      }
    },
    {
      id: "player.browse.layer",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("menuLevel"),
        desc: (0, import_i18n.tName)("descMenuLevel"),
        type: "number",
        role: "value",
        read: true,
        write: false
      }
    },
    {
      id: "player.browse.totalItems",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("totalEntries"),
        desc: (0, import_i18n.tName)("descTotalEntries"),
        type: "number",
        role: "value",
        read: true,
        write: false
      }
    },
    {
      id: "player.browse.currentLine",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("currentLine"),
        desc: (0, import_i18n.tName)("descCurrentLine"),
        type: "number",
        role: "value",
        read: true,
        write: false
      }
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(line),
    {
      id: "player.browse.selectLine",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("selectLineFolderOpensItemPlays"),
        desc: (0, import_i18n.tName)("descSelectLineFolderOpensItemPlays"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
        max: 8,
        step: 1
      }
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
        desc: (0, import_i18n.tName)("descNavigatePathEGBookmarksRadioParadise"),
        type: "string",
        role: "text",
        read: true,
        write: true
      }
    },
    {
      id: "player.browse.rows",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("rowsJSON"),
        desc: (0, import_i18n.tName)("descRowsJSON"),
        type: "string",
        role: "json",
        read: true,
        write: false
      }
    },
    {
      id: "player.browse.busy",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("busy"),
        desc: (0, import_i18n.tName)("descBusy"),
        type: "boolean",
        role: "indicator",
        read: true,
        write: false
      }
    }
  ];
}
function remoteObjectDefs(cursorValues, menuValues) {
  const states = (values) => Object.fromEntries(values.map((value) => [value, value]));
  const defs = [];
  if (!(cursorValues == null ? void 0 : cursorValues.length) && !(menuValues == null ? void 0 : menuValues.length)) {
    return defs;
  }
  defs.push({
    id: "remote",
    type: "channel",
    common: { name: (0, import_i18n.tName)(import_types.CHANNEL_NAME_KEYS.remote), desc: (0, import_i18n.tName)(import_types.CHANNEL_DESC_KEYS.remote) }
  });
  if (cursorValues == null ? void 0 : cursorValues.length) {
    defs.push({
      id: "remote.cursor",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("cursorPad"),
        desc: (0, import_i18n.tName)("descCursorPad"),
        type: "string",
        role: "state",
        read: false,
        write: true,
        states: states(cursorValues)
      }
    });
  }
  if (menuValues == null ? void 0 : menuValues.length) {
    defs.push({
      id: "remote.menu",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("menuKey"),
        desc: (0, import_i18n.tName)("descMenuKey"),
        type: "string",
        role: "state",
        read: false,
        write: true,
        states: states(menuValues)
      }
    });
  }
  return defs;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  browseObjectDefs,
  remoteObjectDefs
});
//# sourceMappingURL=objects.js.map

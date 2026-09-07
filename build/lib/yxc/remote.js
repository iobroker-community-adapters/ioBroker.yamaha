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
var remote_exports = {};
__export(remote_exports, {
  YXC_CURSOR_VALUES: () => YXC_CURSOR_VALUES,
  YXC_MENU_VALUES: () => YXC_MENU_VALUES,
  isRemoteWord: () => isRemoteWord
});
module.exports = __toCommonJS(remote_exports);
var import_types = require("../browse/types");
const YXC_CURSOR_VALUES = import_types.CURSOR_VALUES.filter((value) => value !== "home");
const YXC_MENU_VALUES = import_types.MENU_VALUES;
function isRemoteWord(values, value) {
  return typeof value === "string" && values.includes(value);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YXC_CURSOR_VALUES,
  YXC_MENU_VALUES,
  isRemoteWord
});
//# sourceMappingURL=remote.js.map

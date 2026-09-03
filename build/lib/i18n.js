"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var i18n_exports = {};
__export(i18n_exports, {
  t: () => t,
  tName: () => tName
});
module.exports = __toCommonJS(i18n_exports);
var import_de = __toESM(require("../../admin/i18n/de.json"));
var import_en = __toESM(require("../../admin/i18n/en.json"));
var import_es = __toESM(require("../../admin/i18n/es.json"));
var import_fr = __toESM(require("../../admin/i18n/fr.json"));
var import_it = __toESM(require("../../admin/i18n/it.json"));
var import_nl = __toESM(require("../../admin/i18n/nl.json"));
var import_pl = __toESM(require("../../admin/i18n/pl.json"));
var import_pt = __toESM(require("../../admin/i18n/pt.json"));
var import_ru = __toESM(require("../../admin/i18n/ru.json"));
var import_uk = __toESM(require("../../admin/i18n/uk.json"));
var import_zh_cn = __toESM(require("../../admin/i18n/zh-cn.json"));
const LANGUAGES = {
  en: import_en.default,
  de: import_de.default,
  ru: import_ru.default,
  pt: import_pt.default,
  nl: import_nl.default,
  fr: import_fr.default,
  it: import_it.default,
  es: import_es.default,
  pl: import_pl.default,
  uk: import_uk.default,
  "zh-cn": import_zh_cn.default
};
function translated(key, args) {
  var _a, _b;
  const out = {};
  for (const [lang, words] of Object.entries(LANGUAGES)) {
    let text = (_b = (_a = words[key]) != null ? _a : import_en.default[key]) != null ? _b : key;
    for (const arg of args) {
      text = text.replace("%s", arg === null ? "null" : String(arg));
    }
    out[lang] = text;
  }
  return out;
}
function t(key, ...args) {
  return translated(key, args);
}
function tName(key, ...args) {
  return translated(key, args);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  t,
  tName
});
//# sourceMappingURL=i18n.js.map

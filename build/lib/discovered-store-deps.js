"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (
  (target = mod != null ? __create(__getProtoOf(mod)) : {}),
  __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod,
  )
);
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var discovered_store_deps_exports = {};
__export(discovered_store_deps_exports, {
  discoveredStoreDeps: () => discoveredStoreDeps,
  ignoredStoreDeps: () => ignoredStoreDeps,
});
module.exports = __toCommonJS(discovered_store_deps_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
function discoveredStoreDeps(adapter) {
  return fileStoreDeps(adapter, "discovered.json");
}
function ignoredStoreDeps(adapter) {
  return fileStoreDeps(adapter, "ignored.json");
}
function fileStoreDeps(adapter, fileName) {
  const path = (0, import_node_path.join)(utils.getAbsoluteInstanceDataDir(adapter), fileName);
  return {
    read: async () => {
      try {
        return await (0, import_promises.readFile)(path, "utf8");
      } catch {
        return void 0;
      }
    },
    write: async content => {
      await (0, import_promises.mkdir)((0, import_node_path.dirname)(path), { recursive: true });
      await (0, import_promises.writeFile)(path, content, "utf8");
    },
    log: { debug: message => adapter.log.debug(message) },
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    discoveredStoreDeps,
    ignoredStoreDeps,
  });
//# sourceMappingURL=discovered-store-deps.js.map

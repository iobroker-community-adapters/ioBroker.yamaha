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
var discovered_store_exports = {};
__export(discovered_store_exports, {
  readDiscovered: () => readDiscovered,
  readIgnored: () => readIgnored,
  writeDiscovered: () => writeDiscovered,
  writeIgnored: () => writeIgnored,
});
module.exports = __toCommonJS(discovered_store_exports);
var import_util = require("./util");
function isRecord(entry) {
  const candidate = entry;
  return (
    typeof (candidate == null ? void 0 : candidate.id) === "string" &&
    typeof (candidate == null ? void 0 : candidate.ip) === "string"
  );
}
async function readDiscovered(deps) {
  try {
    const raw = await deps.read();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch (e) {
    deps.log.debug(`discovered store: read failed, starting empty (${(0, import_util.errorMessage)(e)})`);
    return [];
  }
}
async function writeDiscovered(deps, devices) {
  try {
    await deps.write(JSON.stringify(devices));
  } catch (e) {
    deps.log.debug(`discovered store: write failed (${(0, import_util.errorMessage)(e)})`);
  }
}
async function readIgnored(deps) {
  try {
    const raw = await deps.read();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : [];
  } catch (e) {
    deps.log.debug(`ignored store: read failed, starting empty (${(0, import_util.errorMessage)(e)})`);
    return [];
  }
}
async function writeIgnored(deps, ids) {
  try {
    await deps.write(JSON.stringify([...new Set(ids)]));
  } catch (e) {
    deps.log.debug(`ignored store: write failed (${(0, import_util.errorMessage)(e)})`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    readDiscovered,
    readIgnored,
    writeDiscovered,
    writeIgnored,
  });
//# sourceMappingURL=discovered-store.js.map

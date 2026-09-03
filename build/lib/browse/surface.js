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
var surface_exports = {};
__export(surface_exports, {
  createBrowseSurface: () => createBrowseSurface,
});
module.exports = __toCommonJS(surface_exports);
var import_browse_engine = require("./browse-engine");
var import_objects = require("./objects");
async function createBrowseSurface(driver, deviceId, deps) {
  const sources = driver.sources();
  if (Object.keys(sources).length === 0) {
    return void 0;
  }
  for (const def of (0, import_objects.browseObjectDefs)(sources)) {
    await deps.upsertObject(`${deviceId}.${def.id}`, def);
  }
  const engine = new import_browse_engine.BrowseEngine(driver, {
    emit: (id, value) => deps.emit(id, value),
    log: deps.log,
    delay: deps.delay,
  });
  driver.attach(engine);
  engine.seed();
  return engine;
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    createBrowseSurface,
  });
//# sourceMappingURL=surface.js.map

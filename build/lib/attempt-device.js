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
var attempt_device_exports = {};
__export(attempt_device_exports, {
  attemptDevice: () => attemptDevice
});
module.exports = __toCommonJS(attempt_device_exports);
var import_ynca_client = require("./ynca/ynca-client");
var import_device_controller = require("./device-controller");
var import_device_controller2 = require("./yxc/device-controller");
var import_http_client = require("./yxc/http-client");
var import_device_controller3 = require("./xml/device-controller");
var import_xml_client = require("./xml/xml-client");
var import_util = require("./util");
async function attemptDevice(device, deps) {
  const { log, upsertObject, setStateAck, timers } = deps;
  const yncaClient = new import_ynca_client.YncaClient(device.ip, timers);
  const ynca = new import_device_controller.YncaDeviceController(device.id, { client: yncaClient, upsertObject, setStateAck, log });
  try {
    if (await ynca.start()) {
      return ynca;
    }
    ynca.close();
  } catch (e) {
    ynca.close();
    log.debug(`${device.id}: no YNCA (${(0, import_util.errorMessage)(e)})`);
  }
  const yxc = new import_device_controller2.YxcDeviceController(device.id, {
    client: new import_http_client.YamahaYxcClient(device.ip),
    // Resolve another configured device's client for a multiroom link — never this device itself.
    clientFor: (ip) => ip !== device.ip && deps.knownDeviceIps.has(ip) ? new import_http_client.YamahaYxcClient(ip) : void 0,
    registerPush: (onPush) => deps.registerPush(device.ip, onPush),
    scheduleKeepalive: deps.scheduleKeepalive,
    upsertObject,
    setStateAck,
    log
  });
  try {
    if (await yxc.start()) {
      return yxc;
    }
    yxc.close();
  } catch (e) {
    yxc.close();
    log.debug(`${device.id}: no YXC (${(0, import_util.errorMessage)(e)})`);
  }
  const xml = new import_device_controller3.XmlDeviceController(
    device.id,
    {
      client: new import_xml_client.XmlClient(device.ip),
      scheduleKeepalive: deps.scheduleKeepalive,
      upsertObject,
      setStateAck,
      log
    },
    deps.xmlPollIntervalMs
  );
  try {
    if (await xml.start()) {
      deps.onXmlConnected();
      return xml;
    }
    xml.close();
  } catch (e) {
    xml.close();
    log.warn(`${device.id}: no reachable transport (YNCA/YXC/XML): ${(0, import_util.errorMessage)(e)}`);
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  attemptDevice
});
//# sourceMappingURL=attempt-device.js.map

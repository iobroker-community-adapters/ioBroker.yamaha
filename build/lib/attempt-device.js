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
var import_multi_transport_handle = require("./lifecycle/multi-transport-handle");
var import_transport_connection_adapter = require("./lifecycle/transport-connection-adapter");
var import_util = require("./util");
async function attemptDevice(device, deps) {
  const { log, upsertObject, setStateAck, timers } = deps;
  const connections = [];
  const ynca = new import_transport_connection_adapter.TransportConnectionAdapter("ynca", device.id, setStateAck);
  ynca.bind(
    new import_device_controller.YncaDeviceController(device.id, {
      client: new import_ynca_client.YncaClient(device.ip, timers),
      upsertObject: ynca.interceptUpsert,
      setStateAck: ynca.interceptSetStateAck,
      log
    })
  );
  await tryConnect(ynca, connections, log, `${device.id}: no YNCA`);
  const yxc = new import_transport_connection_adapter.TransportConnectionAdapter("yxc", device.id, setStateAck);
  yxc.bind(
    new import_device_controller2.YxcDeviceController(device.id, {
      client: new import_http_client.YamahaYxcClient(device.ip),
      // Resolve another configured device's client for a multiroom link — never this device itself.
      clientFor: (ip) => ip !== device.ip && deps.knownDeviceIps.has(ip) ? new import_http_client.YamahaYxcClient(ip) : void 0,
      registerPush: (onPush) => deps.registerPush(device.ip, onPush),
      scheduleKeepalive: deps.scheduleKeepalive,
      upsertObject: yxc.interceptUpsert,
      setStateAck: yxc.interceptSetStateAck,
      log
    })
  );
  await tryConnect(yxc, connections, log, `${device.id}: no YXC`);
  const xml = new import_transport_connection_adapter.TransportConnectionAdapter("xml", device.id, setStateAck);
  xml.bind(
    new import_device_controller3.XmlDeviceController(
      device.id,
      {
        client: new import_xml_client.XmlClient(device.ip),
        scheduleKeepalive: deps.scheduleKeepalive,
        upsertObject: xml.interceptUpsert,
        setStateAck: xml.interceptSetStateAck,
        log
      },
      deps.xmlPollIntervalMs
    )
  );
  if (await tryConnect(xml, connections, log, `${device.id}: no XML`)) {
    deps.onXmlConnected();
  }
  if (connections.length === 0) {
    log.warn(`${device.id}: no reachable transport (YNCA/YXC/XML)`);
    return null;
  }
  const handle = new import_multi_transport_handle.MultiTransportHandle(device.id, connections, { upsertObject, log });
  await handle.start();
  return handle;
}
async function tryConnect(adapter, connections, log, failMessage) {
  try {
    if (await adapter.connect()) {
      connections.push(adapter);
      return true;
    }
    adapter.close();
  } catch (e) {
    adapter.close();
    log.debug(`${failMessage} (${(0, import_util.errorMessage)(e)})`);
  }
  return false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  attemptDevice
});
//# sourceMappingURL=attempt-device.js.map

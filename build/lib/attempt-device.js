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
var attempt_device_exports = {};
__export(attempt_device_exports, {
  attemptDevice: () => attemptDevice,
  connectTransports: () => connectTransports,
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
var import_reconnect_strategy = require("./lifecycle/reconnect-strategy");
var import_command_gate = require("./lifecycle/command-gate");
var import_ready_line = require("./ready-line");
var import_util = require("./util");
const TRANSPORT_RECONNECT_BASE_MS = 1e3;
const TRANSPORT_RECONNECT_MAX_MS = 6e4;
const COMMAND_SPACING_MS = { ynca: 100, yxc: 0, xml: 0 };
async function connectTransports(deviceId, attempts, deps) {
  var _a, _b, _c;
  const results = await Promise.all(
    attempts.map(async attempt => {
      const conn = attempt.build();
      try {
        if (await conn.connect()) {
          return conn;
        }
      } catch (e) {
        deps.log.debug(
          `${deviceId}/${conn.transport}: transport did not connect (${(0, import_util.errorMessage)(e)})`,
        );
      }
      conn.close();
      return null;
    }),
  );
  const live = results.filter(conn => conn !== null);
  if (live.length === 0) {
    const level = (_b = (_a = deps.reachability) == null ? void 0 : _a.reportUnreachable()) != null ? _b : "warn";
    deps.log[level](`${deviceId}: no reachable transport (YNCA/YXC/XML)`);
    return null;
  }
  (_c = deps.reachability) == null ? void 0 : _c.reportReachable();
  const rebuilds = new Map(attempts.map(attempt => [attempt.transport, attempt.build]));
  const handle = new import_multi_transport_handle.MultiTransportHandle(deviceId, live, {
    upsertObject: deps.upsertObject,
    log: deps.log,
    onTransports: deps.onTransports,
    rebuild: deps.timers ? transport => rebuilds.get(transport)() : void 0,
    schedule: deps.timers ? (cb, ms) => deps.timers.schedule(cb, ms) : void 0,
    cancel: deps.timers ? handle_ => deps.timers.cancel(handle_) : void 0,
    backoffFactory: () =>
      new import_reconnect_strategy.ReconnectStrategy(TRANSPORT_RECONNECT_BASE_MS, TRANSPORT_RECONNECT_MAX_MS),
  });
  try {
    await handle.start();
  } catch (e) {
    handle.close();
    throw e;
  }
  deps.log.info(
    (0, import_ready_line.readyLine)(
      deviceId,
      live.map(conn => conn.transport),
    ),
  );
  return handle;
}
function attemptDevice(device, deps) {
  const { log, upsertObject, setStateAck, timers } = deps;
  const gateFor = transport =>
    new import_command_gate.CommandGate({ minSpacingMs: COMMAND_SPACING_MS[transport], timers });
  const buildYnca = () => {
    const ynca = new import_transport_connection_adapter.TransportConnectionAdapter("ynca", device.id, setStateAck);
    const gate = gateFor("ynca");
    ynca.bind(
      new import_device_controller.YncaDeviceController(device.id, {
        client: new import_ynca_client.YncaClient(device.ip, timers, gate),
        gate,
        upsertObject: ynca.interceptUpsert,
        setStateAck: ynca.interceptSetStateAck,
        log,
        isEntryEnabled: deps.isEntryEnabled,
        subunitCache: deps.yncaSubunitCache,
        probeMemory: deps.probeMemory,
      }),
    );
    return ynca;
  };
  const buildYxc = () => {
    const yxc = new import_transport_connection_adapter.TransportConnectionAdapter("yxc", device.id, setStateAck);
    const gate = gateFor("yxc");
    yxc.bind(
      new import_device_controller2.YxcDeviceController(device.id, {
        client: new import_http_client.YamahaYxcClient(device.ip, void 0, gate),
        // Resolve another configured device's client for a multiroom link — never this device
        // itself. The partner's own gate belongs to its own connection, so this one-off client
        // stays ungated (a single link call, not a stream of commands).
        clientFor: ip =>
          ip !== device.ip && deps.knownDeviceIps.has(ip) ? new import_http_client.YamahaYxcClient(ip) : void 0,
        registerPush: onPush => deps.registerPush(device.ip, onPush),
        pushActive: deps.pushActive,
        probeMemory: deps.probeMemory,
        scheduleKeepalive: deps.scheduleKeepalive,
        upsertObject: yxc.interceptUpsert,
        setStateAck: yxc.interceptSetStateAck,
        reportDeviceName: deps.onDeviceName,
        log,
        gate,
      }),
    );
    return yxc;
  };
  const buildXml = () => {
    const xml = new import_transport_connection_adapter.TransportConnectionAdapter("xml", device.id, setStateAck);
    const gate = gateFor("xml");
    xml.bind(
      new import_device_controller3.XmlDeviceController(
        device.id,
        {
          client: new import_xml_client.XmlClient(device.ip, void 0, gate),
          scheduleKeepalive: deps.scheduleKeepalive,
          upsertObject: xml.interceptUpsert,
          setStateAck: xml.interceptSetStateAck,
          log,
          gate,
          probeMemory: deps.probeMemory,
        },
        deps.xmlPollIntervalMs,
      ),
    );
    return xml;
  };
  return connectTransports(
    device.id,
    [
      { transport: "ynca", build: buildYnca },
      { transport: "yxc", build: buildYxc },
      { transport: "xml", build: buildXml },
    ],
    {
      upsertObject,
      log,
      onTransports: deps.onTransports,
      reachability: deps.reachability,
      timers: deps.timers,
    },
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    attemptDevice,
    connectTransports,
  });
//# sourceMappingURL=attempt-device.js.map

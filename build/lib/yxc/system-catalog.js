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
var system_catalog_exports = {};
__export(system_catalog_exports, {
  YXC_SYSTEM_CATALOG: () => YXC_SYSTEM_CATALOG,
  presentSystemEntries: () => presentSystemEntries
});
module.exports = __toCommonJS(system_catalog_exports);
const YXC_SYSTEM_CATALOG = [
  {
    state: "advanced.autoPowerStandby",
    field: "auto_power_standby",
    common: {
      nameKey: "automaticStandby",
      descKey: "descAutomaticStandby",
      type: "boolean",
      role: "switch",
      read: true,
      write: true
    },
    fromStatus: (value) => Boolean(value),
    write: { apply: (client, value) => client.setAutoPowerStandby(Boolean(value)) }
  },
  {
    state: "advanced.displayBrightness",
    field: "dimmer",
    common: {
      nameKey: "displayBrightness",
      descKey: "descDisplayBrightness",
      type: "number",
      role: "level.dimmer",
      read: true,
      write: false
    },
    fromStatus: (value) => Number(value),
    rangeId: "dimmer"
  },
  {
    state: "hdmi.out1",
    field: "hdmi_out_1",
    common: {
      nameKey: "hdmiOUT1",
      descKey: "descHdmiOUT1",
      type: "boolean",
      role: "switch",
      read: true,
      write: true
    },
    fromStatus: (value) => Boolean(value),
    write: { apply: (client, value) => client.setHdmiOut1(Boolean(value)) }
  },
  {
    state: "hdmi.out2",
    field: "hdmi_out_2",
    common: {
      nameKey: "hdmiOUT2",
      descKey: "descHdmiOUT2",
      type: "boolean",
      role: "switch",
      read: true,
      write: true
    },
    fromStatus: (value) => Boolean(value),
    write: { apply: (client, value) => client.setHdmiOut2(Boolean(value)) }
  }
];
function presentSystemEntries(funcStatus) {
  if (typeof funcStatus !== "object" || funcStatus === null) {
    return [];
  }
  const fields = funcStatus;
  return YXC_SYSTEM_CATALOG.filter((entry) => entry.field in fields && fields[entry.field] !== null);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YXC_SYSTEM_CATALOG,
  presentSystemEntries
});
//# sourceMappingURL=system-catalog.js.map

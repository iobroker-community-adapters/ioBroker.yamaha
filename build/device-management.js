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
var device_management_exports = {};
__export(device_management_exports, {
  YamahaDeviceManagement: () => YamahaDeviceManagement,
});
module.exports = __toCommonJS(device_management_exports);
var import_dm_utils = require("@iobroker/dm-utils");
var import_i18n = require("./lib/i18n");
var import_device_type = require("./lib/device-type");
var import_discovered_store = require("./lib/discovered-store");
var import_discovered_store_deps = require("./lib/discovered-store-deps");
var import_device_management_helpers = require("./device-management-helpers");
class YamahaDeviceManagement extends import_dm_utils.DeviceManagement {
  /** The instance object id whose `native` holds the manual device table. */
  get objId() {
    return `system.adapter.${this.adapter.namespace}`;
  }
  /** The running adapter, for the one action that has to reach into it (delete a device). */
  get owner() {
    const candidate = this.adapter;
    return typeof candidate.removeDevice === "function" ? candidate : void 0;
  }
  /** Read the manual device table (`native.devices`) as raw rows, keeping the name. */
  async readManual() {
    var _a;
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.devices;
    if (!Array.isArray(devices)) {
      return [];
    }
    return devices.filter(d => !!d && typeof d.ip === "string" && d.ip.length > 0);
  }
  /**
   * Persist the manual device table; writing `native.*` restarts the adapter with the new set.
   *
   * @param rows the manual rows to store
   */
  async writeManual(rows) {
    await this.adapter.extendForeignObjectAsync(this.objId, { native: { devices: rows } });
  }
  /**
   * The running device set as cards: the manual table when filled (manual mode), otherwise
   * the auto-discovered devices (auto mode) — the same either/or the adapter itself runs.
   *
   * @returns the cards with their source
   */
  async cards() {
    const manual = await this.readManual();
    if (manual.length > 0) {
      const taken = /* @__PURE__ */ new Set(["info"]);
      const cards = [];
      for (const row of manual) {
        const id = (0, import_device_management_helpers.rowId)(row);
        if (taken.has(id)) {
          continue;
        }
        taken.add(id);
        cards.push({ id, ip: row.ip, name: row.name && row.name.length > 0 ? row.name : row.ip, source: "manual" });
      }
      return cards;
    }
    const discovered = await (0, import_discovered_store.readDiscovered)(
      (0, import_discovered_store_deps.discoveredStoreDeps)(this.adapter),
    );
    return discovered.map(d => ({ id: d.id, ip: d.ip, name: d.id, source: "discovered" }));
  }
  /**
   * Populate the manager with one card per running device.
   *
   * @param context the load context
   */
  async loadDevices(context) {
    var _a;
    for (const card of await this.cards()) {
      const [model, node] = await Promise.all([
        this.adapter.getForeignStateAsync(`${this.adapter.namespace}.${card.id}.info.model`),
        this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${card.id}`),
      ]);
      const label =
        typeof ((_a = node == null ? void 0 : node.common) == null ? void 0 : _a.name) === "string"
          ? node.common.name
          : void 0;
      context.addDevice(
        this.toDeviceInfo(
          label && label !== card.id ? { ...card, name: label } : card,
          typeof (model == null ? void 0 : model.val) === "string" ? model.val : void 0,
        ),
      );
    }
  }
  /**
   * Build one device card: the live model, the IP as the identifier line, a connection
   * status, and one indicator per connected protocol (hidden while that protocol is not
   * connected). All live values read from the device's own `info.*` states. A discovered
   * card has no edit action — it is auto-found and re-found; it can only be removed.
   *
   * @param card the running device
   * @param model the device's reported model name, for the device-class icon
   * @returns the card descriptor
   */
  toDeviceInfo(card, model) {
    const base = `${this.adapter.namespace}.${card.id}`;
    const del = {
      id: "delete",
      icon: "delete",
      description: (0, import_i18n.t)("dmDelete"),
      handler: async (id, ctx) => this.deleteDevice(id, ctx),
    };
    const edit = {
      id: "edit",
      icon: "edit",
      description: (0, import_i18n.t)("dmEdit"),
      handler: async (id, ctx) => this.editDevice(id, ctx),
    };
    return {
      id: card.id,
      name: card.name,
      icon: (0, import_device_type.iconForModel)(model),
      model: { stateId: `${base}.info.model` },
      identifier: card.ip,
      status: {
        connection: { stateId: `${base}.info.connection`, mapping: { true: "connected", false: "disconnected" } },
      },
      // No icon: the indicator icon accepts only a reserved/`fa-*`/`data:`/URL name, so a plain
      // "wifi" rendered as a "?". The transport label as text plus a green "on" colour carries it;
      // `hideIfEmpty` shows only the protocols this device is actually connected over.
      indicators: import_device_management_helpers.TRANSPORTS.map(tr => ({
        id: `transport-${tr.id}`,
        value: { stateId: `${base}.info.transports.${tr.id}` },
        text: tr.label,
        colorOn: "ok",
        hideIfEmpty: true,
      })),
      actions: card.source === "manual" ? [edit, del] : [del],
    };
  }
  /**
   * The "+ add" action above the list and the label of the identifier line (the IP).
   *
   * @returns the instance action descriptor
   */
  getInstanceInfo() {
    return {
      apiVersion: "v3",
      identifierLabel: (0, import_i18n.t)("ipLabel"),
      actions: [
        { id: "add", icon: "add", description: (0, import_i18n.t)("dmAdd"), handler: async ctx => this.addDevice(ctx) },
      ],
    };
  }
  /**
   * Manual add: show the name+IP form, then append the device to `native.devices` (which
   * restarts the adapter and switches it to manual mode).
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  async addDevice(context) {
    const manual = await this.readManual();
    const data = await context.showForm((0, import_device_management_helpers.buildDeviceForm)(manual.map(r => r.ip)), {
      title: (0, import_i18n.t)("dmAdd"),
    });
    if (data && typeof data.ip === "string" && data.ip.trim()) {
      const row = { name: typeof data.name === "string" ? data.name.trim() : "", ip: data.ip.trim() };
      const clash = (0, import_device_management_helpers.findClash)(manual, row, -1);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      manual.push(row);
      const ignoredDeps = (0, import_discovered_store_deps.ignoredStoreDeps)(this.adapter);
      const ignored = await (0, import_discovered_store.readIgnored)(ignoredDeps);
      const id = (0, import_device_management_helpers.rowId)(row);
      if (ignored.includes(id)) {
        await (0, import_discovered_store.writeIgnored)(
          ignoredDeps,
          ignored.filter(entry => entry !== id),
        );
      }
      await this.writeManual(manual);
    }
    return { refresh: true };
  }
  /**
   * Edit a manual device via the pre-filled form (edit is offered on manual cards only).
   *
   * @param cardId the card id (= the object-tree device id)
   * @param context the action context
   * @returns a directive to reload the list
   */
  async editDevice(cardId, context) {
    var _a;
    const manual = await this.readManual();
    const index = manual.findIndex(r => (0, import_device_management_helpers.rowId)(r) === cardId);
    if (index < 0) {
      return { refresh: "devices" };
    }
    const current = manual[index];
    const usedIps = manual.filter((_, i) => i !== index).map(r => r.ip);
    const data = await context.showForm((0, import_device_management_helpers.buildDeviceForm)(usedIps), {
      title: (0, import_i18n.t)("dmEditTitle"),
      data: { name: (_a = current.name) != null ? _a : "", ip: current.ip },
    });
    if (data && typeof data.ip === "string" && data.ip.trim()) {
      const row = { name: typeof data.name === "string" ? data.name.trim() : "", ip: data.ip.trim() };
      const clash = (0, import_device_management_helpers.findClash)(manual, row, index);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: "devices" };
      }
      manual[index] = row;
      await this.writeManual(manual);
    }
    return { refresh: "devices" };
  }
  /**
   * Delete a device after confirmation, from whichever source it came from: a manual card
   * from `native.devices`, a discovered card from the discovery store — the latter so the
   * standby-protection merge does not resurrect it on the next start.
   *
   * @param cardId the card id (= the object-tree device id)
   * @param context the action context
   * @returns a directive to reload the list
   */
  async deleteDevice(cardId, context) {
    var _a;
    const manual = await this.readManual();
    if (manual.length > 0) {
      const index = manual.findIndex(r => (0, import_device_management_helpers.rowId)(r) === cardId);
      if (index < 0) {
        return { refresh: "devices" };
      }
      const confirmed = await context.showConfirmation(
        (0, import_i18n.t)("dmDeleteConfirm", manual[index].name || manual[index].ip),
      );
      if (confirmed) {
        manual.splice(index, 1);
        await this.writeManual(manual);
      }
      return { refresh: "devices" };
    }
    const store = (0, import_discovered_store_deps.discoveredStoreDeps)(this.adapter);
    const discovered = await (0, import_discovered_store.readDiscovered)(store);
    const remaining = discovered.filter(d => d.id !== cardId);
    if (remaining.length !== discovered.length) {
      const confirmed = await context.showConfirmation((0, import_i18n.t)("dmDeleteConfirm", cardId));
      if (confirmed) {
        await (0, import_discovered_store.writeDiscovered)(store, remaining);
        await ((_a = this.owner) == null ? void 0 : _a.removeDevice(cardId));
        const ignoredDeps = (0, import_discovered_store_deps.ignoredStoreDeps)(this.adapter);
        await (0, import_discovered_store.writeIgnored)(ignoredDeps, [
          ...(await (0, import_discovered_store.readIgnored)(ignoredDeps)),
          cardId,
        ]);
      }
    }
    return { refresh: "devices" };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    YamahaDeviceManagement,
  });
//# sourceMappingURL=device-management.js.map

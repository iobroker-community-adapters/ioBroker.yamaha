import {
  DeviceManagement,
  type ActionContext,
  type DeviceInfo,
  type DeviceLoadContext,
  type InstanceDetails,
} from "@iobroker/dm-utils";
import { t } from "./lib/i18n";
import { iconForModel } from "./lib/device-type";
import { readDiscovered, writeDiscovered } from "./lib/discovered-store";
import { discoveredStoreDeps } from "./lib/discovered-store-deps";
import type { DeviceRecord } from "./lib/types";
import {
  TRANSPORTS,
  buildDeviceForm,
  findClash,
  rowId,
  type CardDevice,
  type ManualRow,
} from "./device-management-helpers";

/**
 * ioBroker device-manager backend: the Yamaha receivers as cards showing the live model,
 * the IP, and which protocols (YNCA/MusicCast/XML) are connected right now, with a manual
 * add-by-IP dialog. The card list follows the running set — the manual `native.devices`
 * table when it is filled, otherwise the auto-discovered devices — so it matches exactly
 * what the adapter runs. "Yamaha" is never a card line: it is the whole adapter.
 */
export class YamahaDeviceManagement extends DeviceManagement {
  /** The instance object id whose `native` holds the manual device table. */
  private get objId(): string {
    return `system.adapter.${this.adapter.namespace}`;
  }

  /** Read the manual device table (`native.devices`) as raw rows, keeping the name. */
  private async readManual(): Promise<ManualRow[]> {
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (obj?.native as { devices?: unknown } | undefined)?.devices;
    if (!Array.isArray(devices)) {
      return [];
    }
    return devices.filter(
      (d): d is ManualRow => !!d && typeof (d as ManualRow).ip === "string" && (d as ManualRow).ip.length > 0,
    );
  }

  /**
   * Persist the manual device table; writing `native.*` restarts the adapter with the new set.
   *
   * @param rows the manual rows to store
   */
  private async writeManual(rows: ManualRow[]): Promise<void> {
    await this.adapter.extendForeignObjectAsync(this.objId, { native: { devices: rows } });
  }

  /**
   * The running device set as cards: the manual table when filled (manual mode), otherwise
   * the auto-discovered devices (auto mode) — the same either/or the adapter itself runs.
   *
   * @returns the cards with their source
   */
  private async cards(): Promise<CardDevice[]> {
    const manual = await this.readManual();
    if (manual.length > 0) {
      const taken = new Set<string>(["info"]);
      const cards: CardDevice[] = [];
      for (const row of manual) {
        const id = rowId(row);
        if (taken.has(id)) {
          continue;
        }
        taken.add(id);
        cards.push({ id, ip: row.ip, name: row.name && row.name.length > 0 ? row.name : row.ip, source: "manual" });
      }
      return cards;
    }
    const discovered = await readDiscovered(discoveredStoreDeps(this.adapter));
    return discovered.map(d => ({ id: d.id, ip: d.ip, name: d.id, source: "discovered" as const }));
  }

  /**
   * Populate the manager with one card per running device.
   *
   * @param context the load context
   */
  protected async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
    for (const card of await this.cards()) {
      // Model and object are independent reads — fetch them together so a card with
      // several devices does not add up their round-trips.
      const [model, node] = await Promise.all([
        this.adapter.getForeignStateAsync(`${this.adapter.namespace}.${card.id}.info.model`),
        this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${card.id}`),
      ]);
      // The card title follows the device object's name, not the table entry. On an
      // instance upgraded from the previous adapter the table entry is the receiver's
      // ip — the object carries the readable name the adapter learned from the device.
      // The table entry itself must stay put: the object id is derived from it, and
      // changing that would move the whole tree.
      const label = typeof node?.common?.name === "string" ? node.common.name : undefined;
      context.addDevice(
        this.toDeviceInfo(
          label && label !== card.id ? { ...card, name: label } : card,
          typeof model?.val === "string" ? model.val : undefined,
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
  private toDeviceInfo(card: CardDevice, model?: string): DeviceInfo<string> {
    const base = `${this.adapter.namespace}.${card.id}`;
    const del = {
      id: "delete",
      icon: "delete",
      description: t("dmDelete"),
      handler: async (id: string, ctx: ActionContext): Promise<{ refresh: "devices" }> => this.deleteDevice(id, ctx),
    };
    const edit = {
      id: "edit",
      icon: "edit",
      description: t("dmEdit"),
      handler: async (id: string, ctx: ActionContext): Promise<{ refresh: "devices" }> => this.editDevice(id, ctx),
    };
    return {
      id: card.id,
      name: card.name,
      icon: iconForModel(model),
      model: { stateId: `${base}.info.model` },
      identifier: card.ip,
      status: {
        connection: { stateId: `${base}.info.connection`, mapping: { true: "connected", false: "disconnected" } },
      },
      // No icon: the indicator icon accepts only a reserved/`fa-*`/`data:`/URL name, so a plain
      // "wifi" rendered as a "?". The transport label as text plus a green "on" colour carries it;
      // `hideIfEmpty` shows only the protocols this device is actually connected over.
      indicators: TRANSPORTS.map(tr => ({
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
  protected getInstanceInfo(): InstanceDetails {
    return {
      apiVersion: "v3",
      identifierLabel: t("ipLabel"),
      actions: [{ id: "add", icon: "add", description: t("dmAdd"), handler: async ctx => this.addDevice(ctx) }],
    };
  }

  /**
   * Manual add: show the name+IP form, then append the device to `native.devices` (which
   * restarts the adapter and switches it to manual mode).
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  private async addDevice(context: ActionContext): Promise<{ refresh: boolean }> {
    const manual = await this.readManual();
    const data = await context.showForm(buildDeviceForm(manual.map(r => r.ip)), { title: t("dmAdd") });
    if (data && typeof data.ip === "string" && data.ip.trim()) {
      const row: ManualRow = { name: typeof data.name === "string" ? data.name.trim() : "", ip: data.ip.trim() };
      const clash = findClash(manual, row, -1);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      manual.push(row);
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
  private async editDevice(cardId: string, context: ActionContext): Promise<{ refresh: "devices" }> {
    const manual = await this.readManual();
    const index = manual.findIndex(r => rowId(r) === cardId);
    if (index < 0) {
      return { refresh: "devices" };
    }
    const current = manual[index];
    const usedIps = manual.filter((_, i) => i !== index).map(r => r.ip);
    const data = await context.showForm(buildDeviceForm(usedIps), {
      title: t("dmEditTitle"),
      data: { name: current.name ?? "", ip: current.ip },
    });
    if (data && typeof data.ip === "string" && data.ip.trim()) {
      const row: ManualRow = { name: typeof data.name === "string" ? data.name.trim() : "", ip: data.ip.trim() };
      const clash = findClash(manual, row, index);
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
  private async deleteDevice(cardId: string, context: ActionContext): Promise<{ refresh: "devices" }> {
    const manual = await this.readManual();
    if (manual.length > 0) {
      const index = manual.findIndex(r => rowId(r) === cardId);
      if (index < 0) {
        return { refresh: "devices" };
      }
      const confirmed = await context.showConfirmation(t("dmDeleteConfirm", manual[index].name || manual[index].ip));
      if (confirmed) {
        manual.splice(index, 1);
        await this.writeManual(manual);
      }
      return { refresh: "devices" };
    }
    const store = discoveredStoreDeps(this.adapter);
    const discovered = await readDiscovered(store);
    const remaining = discovered.filter((d: DeviceRecord) => d.id !== cardId);
    if (remaining.length !== discovered.length) {
      const confirmed = await context.showConfirmation(t("dmDeleteConfirm", cardId));
      if (confirmed) {
        await writeDiscovered(store, remaining);
      }
    }
    return { refresh: "devices" };
  }
}

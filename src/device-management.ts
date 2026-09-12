import {
  DeviceManagement,
  type ActionContext,
  type DeviceInfo,
  type DeviceLoadContext,
  type InstanceDetails,
} from "@iobroker/dm-utils";
import { t } from "./lib/i18n";
import { iconForModel } from "./lib/device-type";
import { readDiscovered, readIgnored, writeDiscovered, writeIgnored } from "./lib/discovered-store";
import { discoveredStoreDeps, ignoredStoreDeps } from "./lib/discovered-store-deps";
import type { DeviceRecord } from "./lib/types";
import { unionDevices } from "./lib/pure-helpers";
import {
  TRANSPORTS,
  buildDeviceForm,
  findClash,
  rowId,
  type CardDevice,
  type ManualRow,
} from "./device-management-helpers";

/** The one adapter method this backend needs beyond the plain ioBroker surface. */
interface DeviceOwner {
  /** Stop supervising a device and delete its object tree. */
  removeDevice(deviceId: string): Promise<void>;
  /** Switch one device's volume datapoints to percent (or back) and rebuild them at once. */
  setVolumePercent(deviceId: string, on: boolean): Promise<void>;
}

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

  /** The running adapter, for the one action that has to reach into it (delete a device). */
  private get owner(): DeviceOwner | undefined {
    const candidate = this.adapter as unknown as Partial<DeviceOwner>;
    return typeof candidate.removeDevice === "function" && typeof candidate.setVolumePercent === "function"
      ? (candidate as DeviceOwner)
      : undefined;
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
   * Whether one device's volume datapoints read 0–100 %, for the edit dialog to prefill.
   *
   * @param deviceId the id-safe device id
   * @returns true when this device is set to percent
   */
  private async volumeAsPercentOf(deviceId: string): Promise<boolean> {
    const node = await this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${deviceId}`);
    return (node?.native as { volumeAsPercent?: unknown } | undefined)?.volumeAsPercent === true;
  }

  /**
   * Set one device's percent switch. The value lives at the DEVICE object — one place the card,
   * the dialog and the running adapter all read, and writing it restarts nothing (an instance
   * object's native would).
   *
   * @param deviceId the id-safe device id
   * @param on whether its volume datapoints should read 0–100 %
   */
  private async applyVolumePercent(deviceId: string, on: boolean): Promise<void> {
    const id = `${this.adapter.namespace}.${deviceId}`;
    const existing = await this.adapter.getForeignObjectAsync(id);
    const owner = this.owner;
    if (existing && owner) {
      // The adapter is running this device: it writes the value AND rebuilds the volume
      // datapoints on the spot, so the change is visible without a restart.
      await owner.setVolumePercent(deviceId, on);
      return;
    }
    // A device just added through the dialog has no object yet — seed the shape
    // `ensureDeviceHeader` completes on the next start, so the answer has somewhere to live.
    await this.adapter.extendForeignObjectAsync(id, {
      type: "device",
      common: { name: deviceId },
      native: { volumeAsPercent: on },
    });
  }

  /**
   * The running device set as cards: the manual table AND the discovery store, exactly the
   * union the adapter itself runs (`unionDevices`), so the list matches what is live.
   *
   * @returns the cards, each tagged with where its address came from
   */
  private async cards(): Promise<CardDevice[]> {
    const names = new Map<string, string>();
    const manualRecords: DeviceRecord[] = [];
    for (const row of await this.readManual()) {
      const id = rowId(row);
      // "info" is the adapter's own channel — a device may never claim it.
      if (id === "info" || names.has(id)) {
        continue;
      }
      names.set(id, row.name && row.name.length > 0 ? row.name : row.ip);
      manualRecords.push({ id, ip: row.ip });
    }
    const discovered = await readDiscovered(discoveredStoreDeps(this.adapter));
    return unionDevices(manualRecords, discovered).map(device => ({
      id: device.id,
      ip: device.ip,
      name: names.get(device.id) ?? device.id,
      source: device.source ?? "discovered",
    }));
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
      // The percent answer comes from the object read above — no extra round-trip for the badge.
      const percent = (node?.native as { volumeAsPercent?: unknown } | undefined)?.volumeAsPercent === true;
      context.addDevice(
        this.toDeviceInfo(
          label && label !== card.id ? { ...card, name: label } : card,
          typeof model?.val === "string" ? model.val : undefined,
          percent,
        ),
      );
    }
  }

  /**
   * Build one device card: the live model, the IP as the identifier line, a connection
   * status, and one indicator per connected protocol (hidden while that protocol is not
   * connected). The live values read from the device's own `info.*` states. Every card can be
   * edited, a discovered one included: that is how a found receiver is given the fixed address
   * the user just assigned it (see {@link editDevice}).
   *
   * @param card the running device
   * @param model the device's reported model name, for the device-class icon
   * @param percent whether this device's volume datapoints read 0–100 %, for the badge
   * @returns the card descriptor
   */
  private toDeviceInfo(card: CardDevice, model?: string, percent = false): DeviceInfo<string> {
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
      // No icon on the transports: the indicator icon accepts only a reserved/`fa-*`/`data:`/URL
      // name, so a plain "wifi" rendered as a "?". The transport label as text plus a green "on"
      // colour carries it; `hideIfEmpty` shows only the protocols this device is connected over.
      indicators: [
        // Where the address came from. The adapter treats the two differently — only a device
        // the search found is looked for again when it drops off — so the card says which it is.
        {
          id: "device-source",
          value: true,
          icon: card.source === "manual" ? "fa-pencil" : "fa-search",
          tooltip: t(card.source === "manual" ? "sourceManual" : "sourceDiscovered"),
          color: "primary",
          order: 10,
        },
        ...TRANSPORTS.map(tr => ({
          id: `transport-${tr.id}`,
          value: { stateId: `${base}.info.transports.${tr.id}` },
          text: tr.label,
          colorOn: "ok" as const,
          hideIfEmpty: true,
        })),
        // The percent setting is SET in the edit dialog, but it has to be READABLE at a glance —
        // otherwise the only way to find out what a receiver's volume datapoints carry is to open
        // a dialog. Shown only while it is on (`hideIfEmpty`), so a card in the default state
        // stays as quiet as before; deliberately not clickable, the dialog stays the one place
        // that sets it.
        {
          id: "volume-percent",
          value: percent,
          icon: "fa-percent",
          text: "0–100 %",
          colorOn: "primary" as const,
          tooltip: t("volumeAsPercent"),
          hideIfEmpty: true,
          order: 20,
        },
      ],
      // Edit on every card: a device the search found can be given the fixed address the user
      // just assigned it, which makes it a manual device (see editDevice).
      // The percent switch is NOT a second control on the card: it lives in the edit dialog,
      // next to name and address, because it is a decision about the device and not something
      // flipped in passing. 2.9.1 had it in both places — the card control showed the wrong
      // position while the dialog showed the right one, and two ways to set one value is one
      // too many (krobi 2026-09-12: "für was hast du den das doppelt gemoppelt?").
      actions: [edit, del],
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
      // Adding a device by hand undoes an earlier delete of the same id — otherwise the
      // exclusion would silently outlive the decision that created it.
      const ignoredDeps = ignoredStoreDeps(this.adapter);
      const ignored = await readIgnored(ignoredDeps);
      const id = rowId(row);
      if (ignored.includes(id)) {
        await writeIgnored(
          ignoredDeps,
          ignored.filter(entry => entry !== id),
        );
      }
      await this.writeManual(manual);
      // Written down right away, so the device starts with the answer the user gave instead of
      // inheriting whatever the instance-wide switch of 2.8.0 was left on.
      await this.applyVolumePercent(id, data.volumeAsPercent === true);
    }
    return { refresh: true };
  }

  /**
   * Edit one device: its display name and its address. Offered on every card.
   *
   * Two rules make this safe, and both were learned from what the adapter does elsewhere:
   *
   * 1. **The object id never changes.** It is derived from the table row's name, and a changed
   *    id would leave the whole object tree behind for `cleanupStaleObjects` to delete —
   *    history and VIS bindings with it. The row therefore carries the id as its name, and what
   *    the user typed becomes the DISPLAY name at the device object, where `nextDeviceLabel`
   *    already defends a user's own name against every name the device reports.
   * 2. **A discovered device whose address changes MOVES into the table.** The user gave the
   *    receiver a fixed address and entered it; that is what a manual device is. Copying it
   *    instead would lose the edit at the next search — `mergeDiscovered` carries the found
   *    address onto a known id.
   *
   * @param cardId the card id (= the object-tree device id)
   * @param context the action context
   * @returns a directive to reload the list
   */
  private async editDevice(cardId: string, context: ActionContext): Promise<{ refresh: "devices" }> {
    const cards = await this.cards();
    const card = cards.find(entry => entry.id === cardId);
    if (!card) {
      return { refresh: "devices" };
    }
    // Prefill what the CARD shows, by the same rule loadDevices titles it: the device object's
    // name when it carries one, otherwise the table entry.
    const node = await this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${cardId}`);
    const shownName =
      typeof node?.common?.name === "string" && node.common.name !== cardId ? node.common.name : card.name;
    const percent = await this.volumeAsPercentOf(cardId);
    const data = await context.showForm(
      buildDeviceForm(cards.filter(entry => entry.id !== cardId).map(entry => entry.ip)),
      { title: t("dmEditTitle"), data: { name: shownName, ip: card.ip, volumeAsPercent: percent } },
    );
    if (!data || typeof data.ip !== "string" || !data.ip.trim()) {
      return { refresh: "devices" };
    }
    const ip = data.ip.trim();
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const manual = await this.readManual();
    const index = manual.findIndex(entry => rowId(entry) === cardId);
    const row: ManualRow = { name: cardId, ip };
    const clash = findClash(manual, row, index);
    if (clash) {
      await context.showMessage(clash);
      return { refresh: "devices" };
    }
    if (index >= 0) {
      manual[index] = row;
      await this.writeManual(manual);
    } else if (ip !== card.ip) {
      const store = discoveredStoreDeps(this.adapter);
      const discovered = await readDiscovered(store);
      await writeDiscovered(
        store,
        discovered.filter((entry: DeviceRecord) => entry.id !== cardId),
      );
      manual.push(row);
      await this.writeManual(manual);
    }
    if (name !== shownName) {
      await this.adapter.extendForeignObjectAsync(`${this.adapter.namespace}.${cardId}`, {
        common: { name: name || cardId },
      });
    }
    if ((data.volumeAsPercent === true) !== percent) {
      await this.applyVolumePercent(cardId, data.volumeAsPercent === true);
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
    // Which store this card lives in, not which store is non-empty: with a mixed set a filled
    // table no longer means every card is manual, and the old shape silently did nothing when a
    // discovered card was deleted next to a typed one.
    const index = manual.findIndex(r => rowId(r) === cardId);
    if (index >= 0) {
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
        // Writing this file restarts nothing, so the delete has to do the two things a restart
        // would otherwise do much later: stop talking to the device and take its tree away.
        await this.owner?.removeDevice(cardId);
        // And it has to STAY deleted — without this the next network search finds the receiver
        // and puts the card straight back.
        const ignoredDeps = ignoredStoreDeps(this.adapter);
        await writeIgnored(ignoredDeps, [...(await readIgnored(ignoredDeps)), cardId]);
      }
    }
    return { refresh: "devices" };
  }
}

import {
  DeviceManagement,
  type ActionContext,
  type DeviceDetails,
  type DeviceInfo,
  type DeviceLoadContext,
  type InstanceDetails,
  type JsonFormSchema,
} from "@iobroker/dm-utils";
import { t } from "./lib/i18n";
import { iconForModel, volumeIndicatorIcon } from "./lib/device-type";
import {
  readDiscovered,
  readExcluded,
  readIgnored,
  writeDiscovered,
  writeExcluded,
  writeIgnored,
  type ExcludedEntry,
} from "./lib/discovered-store";
import { discoveredStoreDeps, excludedStoreDeps, ignoredStoreDeps } from "./lib/discovered-store-deps";
import type { DeviceRecord } from "./lib/types";
import { errorMessage } from "./lib/util";
import { LABEL_RANK, sanitizeId, unionDevices } from "./lib/pure-helpers";
import { deviceIdFor } from "./lib/device-id";
import { identityFrom, mergeIdentity, sameDevice } from "./lib/device-identity";
import { identifyDevice } from "./lib/identify-device";
import { DeviceProfileStore } from "./lib/lifecycle/capability-profile";
import {
  TRANSPORTS,
  buildDeviceForm,
  buildExcludedForm,
  findClash,
  isValidIp,
  rowId,
  type CardDevice,
  type ManualRow,
} from "./device-management-helpers";

/** The adapter methods this backend needs beyond the plain ioBroker surface. */
interface DeviceOwner {
  /** Stop supervising a device and delete its object tree. */
  removeDevice(deviceId: string): Promise<void>;
  /** Switch one device's volume datapoints to percent (or back) and rebuild them at once. */
  setVolumePercent(deviceId: string, on: boolean): Promise<void>;
  /** Forget the session's deletes of these ids and search the network now. */
  rediscoverNow(lifted: readonly string[]): void;
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
    return typeof candidate.removeDevice === "function" &&
      typeof candidate.setVolumePercent === "function" &&
      typeof candidate.rediscoverNow === "function"
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
    let cards: CardDevice[];
    try {
      cards = await this.cards();
    } catch (e) {
      this.adapter.log.error(`device manager: could not list the devices (${errorMessage(e)})`);
      return;
    }
    for (const card of cards) {
      // One card whose reads fail must not cost the whole list (audit 2026-09-24, A18).
      try {
        await this.addCard(context, card);
      } catch (e) {
        this.adapter.log.error(`device manager: ${card.id} could not be shown (${errorMessage(e)})`);
      }
    }
  }

  /**
   * Run a user action from the device manager. A database call that fails inside one used to
   * reject into dm-utils, which only logs — the admin's progress bar span until it gave up, the
   * symptom 2.12.0 fixed for the delete alone (audit 2026-09-24, A18). Now the user reads what
   * failed and the dialog closes with the list reloaded.
   *
   * @param action what the user did, for the log line
   * @param deviceId the card, when the action is a card's
   * @param context the action context, for the message
   * @param run the action
   * @param fallback the answer when it failed
   * @returns what the action answered, or the fallback
   */
  private async runAction<T>(
    action: string,
    deviceId: string | undefined,
    context: ActionContext | undefined,
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (e) {
      this.adapter.log.error(
        `device manager: ${action}${deviceId ? ` of ${deviceId}` : ""} failed (${errorMessage(e)})`,
      );
      try {
        await context?.showMessage(t("dmActionFailed", errorMessage(e)));
      } catch {
        // the dialog is already gone — the log line above carries it
      }
      return fallback;
    }
  }

  /**
   * Add one card to the list.
   *
   * @param context the load context
   * @param card the running device
   */
  private async addCard(context: DeviceLoadContext<string>, card: CardDevice): Promise<void> {
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
      // The UI asks BEFORE the handler runs (dm-utils `confirmation`): no message round-trip,
      // and the text names what goes with the device. `showConfirmation` inside the handler
      // used to leave the reply hanging when the manual branch's table write restarted the
      // instance — the progress bar span until the admin gave up.
      confirmation: t("dmDeleteConfirm", card.name),
      handler: async (id: string, ctx?: ActionContext): Promise<{ delete: string } | { refresh: "devices" }> =>
        this.runAction<{ delete: string } | { refresh: "devices" }>("delete", id, ctx, () => this.deleteDevice(id), {
          refresh: "devices",
        }),
    };
    const edit = {
      id: "edit",
      icon: "edit",
      description: t("dmEdit"),
      handler: async (id: string, ctx: ActionContext): Promise<{ refresh: "devices" }> =>
        this.runAction("edit", id, ctx, () => this.editDevice(id, ctx), { refresh: "devices" }),
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
      // No icon on the transports: dm-gui-components renders exactly 17 `fa-*` names (its own
      // whitelist, `getFaIcon`) and inline `data:image/svg+xml` URLs — anything else is a "?".
      // The transport label as text plus a green "on" colour carries it; `hideIfEmpty` shows
      // only the protocols this device is connected over. Own glyphs go in as data URLs, drawn
      // with `currentColor` so they take the indicator's colour (see device-type.ts).
      indicators: [
        ...TRANSPORTS.map(tr => ({
          id: `transport-${tr.id}`,
          value: { stateId: `${base}.info.transports.${tr.id}` },
          text: tr.label,
          colorOn: "ok" as const,
          hideIfEmpty: true,
        })),
        // The percent setting is SET in the edit dialog, but it has to be READABLE at a glance —
        // otherwise the only way to find out what a receiver's volume datapoints carry is to open
        // a dialog. With percent on, the glyph is a speaker with a percent sign and the main
        // zone's live volume stands under it as "42 %"; in the device's own scale the plain
        // speaker stands alone. Always shown (`hideIfEmpty: false` — 0 % is a value), and given
        // a colour for BOTH states so the glyph does not grey out at the bottom of the scale.
        // Deliberately not clickable: the dialog stays the one place that sets it.
        {
          id: "volume",
          icon: volumeIndicatorIcon(percent),
          value: percent ? { stateId: `${base}.volume` } : true,
          ...(percent ? { showValue: true, unit: "%" } : {}),
          hideIfEmpty: false,
          color: "primary" as const,
          colorOn: "primary" as const,
          tooltip: t(percent ? "volumeAsPercent" : "volumeDeviceScale"),
          order: 20,
        },
      ],
      // "More" opens the device's id and what it told about itself — with two speakers of the same
      // model and the same name, the MAC is what tells them apart (see getDeviceDetails).
      hasDetails: true,
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
   * The card's "more" panel: the object id, and the MAC and serial the device reported — the
   * identity the id is made of. Read from the device object: the identity the transports learned
   * (`native.identity`) and the one in the capability profile.
   *
   * @param id the card id (= the object-tree device id)
   * @returns the panel
   */
  protected async getDeviceDetails(id: string): Promise<DeviceDetails<string>> {
    const node = await this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${id}`);
    const native = (node?.native ?? {}) as Record<string, unknown>;
    const stored =
      typeof native.identity === "object" && native.identity !== null ? identityFrom(native.identity) : undefined;
    const profile = new DeviceProfileStore(id, native, {
      adapterVersion: "",
      now: () => "",
      persist: () => undefined,
    }).identity();
    const identity = mergeIdentity(stored, profile);
    const line = (key: "dmDetailsId" | "dmDetailsMac" | "dmDetailsSerial", value: string | undefined): unknown => ({
      type: "staticText",
      text: t(key, value ?? "–"),
      newLine: true,
      sm: 12,
    });
    const schema = {
      type: "panel",
      items: {
        id: line("dmDetailsId", id),
        mac: line("dmDetailsMac", identity?.mac?.replace(/(..)(?!$)/g, "$1:")),
        serial: line("dmDetailsSerial", identity?.serial),
      },
    } as unknown as JsonFormSchema;
    return { id, schema };
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
      actions: [
        {
          id: "add",
          icon: "add",
          description: t("dmAdd"),
          handler: async ctx => this.runAction("add", undefined, ctx, () => this.addDevice(ctx), { refresh: true }),
        },
        // The way back for a deleted device: without it an exclusion is invisible and permanent.
        {
          id: "excluded",
          icon: "lines",
          description: t("dmExcluded"),
          handler: async ctx =>
            this.runAction("excluded devices", undefined, ctx, () => this.excludedDevices(ctx), { refresh: true }),
        },
      ],
    };
  }

  /**
   * Manual add: show the name+IP form, ask the device who it is, then append it to
   * `native.devices` (which restarts the adapter).
   *
   * The id is decided HERE and stored in the row (3.0.0): model and the last four characters of the
   * serial (`wx-030-2b3c`) when the device answers MusicCast or XML, the model alone when it tells
   * no serial, otherwise the typed name ("Küche" → `kueche`) or the address. A device that is off
   * or speaks YNCA only moves once, at the first contact that tells its model and serial
   * (`checkIdDecision`). The typed name is the device's DISPLAY name from the start, at the rank
   * only a user gives.
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  private async addDevice(context: ActionContext): Promise<{ refresh: boolean }> {
    const manual = await this.readManual();
    const data = await context.showForm(buildDeviceForm(manual.map(r => r.ip)), { title: t("dmAdd") });
    if (data && typeof data.ip === "string" && data.ip.trim()) {
      const ip = data.ip.trim();
      const typedName = typeof data.name === "string" ? data.name.trim() : "";
      if (!isValidIp(ip)) {
        await context.showMessage(t("invalidIp"));
        return { refresh: true };
      }
      // A name that IS the address says nothing the address does not — it is no display name.
      const name = typedName === ip ? "" : typedName;
      const report = await identifyDevice(ip);
      const found = await readDiscovered(discoveredStoreDeps(this.adapter));
      // The same receiver found by the search already runs — a second card would be a second tree.
      if (found.some(record => sameDevice(record.identity, report.identity))) {
        await context.showMessage(t("duplicateDevice"));
        return { refresh: true };
      }
      const taken = new Set([...manual.map(entry => rowId(entry)), ...found.map(record => record.id)]);
      const id = deviceIdFor({ model: report.model, identity: report.identity, name, ip }, taken);
      // The row carries the id as its name too: a return to 2.x derives the id from the name, and
      // then finds the tree where it is (and a typed row never reads as a migrated one).
      const row: ManualRow = { id, name: id, ip };
      const clash = findClash(manual, row, -1, new Set(found.map(record => record.id)));
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      manual.push(row);
      // Adding a device by hand undoes an earlier delete of the same device — otherwise the
      // exclusion would silently outlive the decision that created it. By its id, and by the id
      // 2.x gave the same name: a device deleted before 3.0.0 is on the list under that one.
      const lifted = new Set([id, ...(name !== "" ? [sanitizeId(name)] : [])]);
      const ignoredDeps = ignoredStoreDeps(this.adapter);
      const ignored = await readIgnored(ignoredDeps);
      if (ignored.some(entry => lifted.has(entry))) {
        await writeIgnored(
          ignoredDeps,
          ignored.filter(entry => !lifted.has(entry)),
        );
      }
      // The same for the exclusion entries — by id, by address and by identity: the entry of a
      // deleted manual device carries the address the user is typing again right now.
      const excludedDeps = excludedStoreDeps(this.adapter);
      const excluded = await readExcluded(excludedDeps);
      const remaining = excluded.filter(
        entry => !lifted.has(entry.id) && entry.ip !== row.ip && !sameDevice(entry.identity, report.identity),
      );
      if (remaining.length !== excluded.length) {
        await writeExcluded(excludedDeps, remaining);
      }
      await this.writeManual(manual);
      // Written down right away, so the device starts with the answer the user gave instead of
      // inheriting whatever the instance-wide switch of 2.8.0 was left on.
      await this.applyVolumePercent(id, data.volumeAsPercent === true);
      if (name !== "") {
        // The name the user typed is the display name from the start — the id no longer carries it.
        await this.adapter.extendForeignObjectAsync(`${this.adapter.namespace}.${id}`, {
          common: { name: typedName },
          native: { label: typedName, labelRank: LABEL_RANK.user },
        });
      }
    }
    return { refresh: true };
  }

  /**
   * The devices the network search skips because the user deleted them, as a checkbox list —
   * ticked ones are admitted again: they leave both stores (`excluded.json` and the plain id
   * list), the running adapter forgets the session's delete and searches at once.
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  private async excludedDevices(context: ActionContext): Promise<{ refresh: boolean }> {
    const excludedDeps = excludedStoreDeps(this.adapter);
    const ignoredDeps = ignoredStoreDeps(this.adapter);
    const excluded = await readExcluded(excludedDeps);
    const ignored = await readIgnored(ignoredDeps);
    // One row per id: the entry with address and identity where there is one, the bare id from
    // the plain list otherwise (an exclusion written before there were entries).
    const entries = [
      ...excluded,
      ...ignored.filter(id => !excluded.some(entry => entry.id === id)).map(id => ({ id })),
    ];
    if (entries.length === 0) {
      await context.showMessage(t("dmExcludedNone"));
      return { refresh: false };
    }
    const data = await context.showForm(buildExcludedForm(entries), {
      title: t("dmExcludedTitle"),
      buttons: ["apply", "cancel"],
    });
    if (!data) {
      return { refresh: false };
    }
    const lifted = entries.map(entry => entry.id).filter(id => data[id] === true);
    if (lifted.length === 0) {
      return { refresh: false };
    }
    await writeExcluded(
      excludedDeps,
      excluded.filter(entry => !lifted.includes(entry.id)),
    );
    await writeIgnored(
      ignoredDeps,
      ignored.filter(id => !lifted.includes(id)),
    );
    this.owner?.rediscoverNow(lifted);
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
    // The row keeps the card's id — stored, and as its name for a return to 2.x.
    const row: ManualRow = { id: cardId, name: cardId, ip };
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
      // The marker rides along with the name, at the rank only this dialog writes: it tells the
      // next start that THIS name is the established one (`ensureDeviceHeader` writes it back
      // instead of the bare id) and it outranks every name a device reports for itself, so a
      // MusicCast zone name can no longer overwrite what the user typed here.
      await this.adapter.extendForeignObjectAsync(`${this.adapter.namespace}.${cardId}`, {
        common: { name: name || cardId },
        native: { label: name || cardId, labelRank: LABEL_RANK.user },
      });
    }
    if ((data.volumeAsPercent === true) !== percent) {
      await this.applyVolumePercent(cardId, data.volumeAsPercent === true);
    }
    return { refresh: "devices" };
  }

  /**
   * Delete a device for good. The UI confirmed already (see the action descriptor). The order
   * is the fix for "I deleted it and it came back":
   *
   * 1. The exclusion is written FIRST — a search running right now must not put the device
   *    back. Both stores: `excluded.json` with address and identity, and the plain id list a
   *    rollback to 2.11.0 still reads.
   * 2. A discovered record leaves the store; the running adapter stops the device and deletes
   *    its tree (`removeDevice`) — for a manual card too, so nothing waits for the restart.
   * 3. The reply `{ delete }` leaves BEFORE the table write: writing the instance's `native`
   *    restarts the adapter, and a handler that awaits it never answers. The write is scheduled
   *    right behind the return, on the adapter's own timer.
   *
   * @param cardId the card id (= the object-tree device id)
   * @returns the id the list removes
   */
  private async deleteDevice(cardId: string): Promise<{ delete: string }> {
    const manual = await this.readManual();
    const index = manual.findIndex(r => rowId(r) === cardId);
    const store = discoveredStoreDeps(this.adapter);
    const discovered = await readDiscovered(store);
    const record = discovered.find((d: DeviceRecord) => d.id === cardId);
    if (index < 0 && !record) {
      return { delete: cardId };
    }
    const ip = index >= 0 ? manual[index].ip : record!.ip;
    // The identity the transports learned lives at the device object — with it the exclusion
    // survives a rename and a new address; without it the address has to do.
    const node = await this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${cardId}`);
    const identity = (node?.native as { identity?: ExcludedEntry["identity"] } | undefined)?.identity;
    const excludedDeps = excludedStoreDeps(this.adapter);
    await writeExcluded(excludedDeps, [
      ...(await readExcluded(excludedDeps)),
      { id: cardId, ip, ...(identity ? { identity } : {}) },
    ]);
    const ignoredDeps = ignoredStoreDeps(this.adapter);
    await writeIgnored(ignoredDeps, [...(await readIgnored(ignoredDeps)), cardId]);
    if (record) {
      await writeDiscovered(
        store,
        discovered.filter((d: DeviceRecord) => d.id !== cardId),
      );
    }
    await this.owner?.removeDevice(cardId);
    if (index >= 0) {
      manual.splice(index, 1);
      this.adapter.setTimeout(() => {
        this.writeManual(manual).catch((e: unknown) =>
          // The tree is gone and the id is excluded, but the row still stands: the next start
          // would run the device from the table again, with a fresh tree — say so, loudly.
          this.adapter.log.error(
            `could not update the device table after deleting "${cardId}" (${errorMessage(e)}) — the device is still listed in the table, delete it once more`,
          ),
        );
      }, 0);
    }
    return { delete: cardId };
  }
}

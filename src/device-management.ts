import type { AdapterInstance } from "@iobroker/adapter-core";
import {
  DeviceManagement,
  type ActionContext,
  type DeviceDetails,
  type DeviceInfo,
  type DeviceLoadContext,
  type InstanceDetails,
  type JsonFormSchema,
} from "@iobroker/dm-utils";
import { tName } from "./lib/i18n";
import { iconForModel, volumeIndicatorIcon } from "./lib/device-type";
import { type DeviceStores, deviceStoresOf, rememberedDevices } from "./lib/device-stores";
import { errText } from "./lib/err-text";
import {
  isDottedQuad,
  LABEL_RANK,
  parseDevices,
  rowDeviceId,
  sanitizeId,
  unionDevices,
  type DeviceRow,
} from "./lib/pure-helpers";
import { deviceIdFor } from "./lib/device-id";
import { sameDevice } from "./lib/device-identity";
import { identifyDevice } from "./lib/identify-device";
import { identityOfDeviceObject } from "./lib/lifecycle/capability-profile";
import {
  buildDeviceForm,
  buildExcludedForm,
  findClash,
  takenAddresses,
  type CardDevice,
} from "./device-management-helpers";
import { isIPv4 } from "./lib/network-interfaces";
import { TRANSPORT_LABELS } from "./lib/ready-line";

/** The adapter methods this backend needs beyond the plain ioBroker surface. */
export interface DeviceOwner {
  /** Stop supervising a device and delete its object tree. */
  removeDevice(deviceId: string): Promise<void>;
  /** Switch one device's volume datapoints to percent (or back) and rebuild them at once. */
  setVolumePercent(deviceId: string, on: boolean): Promise<void>;
  /** Forget the session's deletes of these ids and search the network now. */
  rediscoverNow(lifted: readonly string[]): void;
  /** Merge into a device object through the adapter's one write chain per device. */
  writeDeviceObject(deviceId: string, patch: ioBroker.PartialObject): Promise<void>;
}

/**
 * ioBroker device-manager backend: the Yamaha receivers as cards showing the live model,
 * the IP, and which protocols (YNCA/MusicCast/XML) are connected right now, with a manual
 * add-by-IP dialog. The card list follows the running set — the manual `native.devices`
 * table plus the auto-discovered devices (`unionDevices`, a manual entry wins) — so it
 * matches exactly what the adapter runs. "Yamaha" is never a card line: it is the whole adapter.
 *
 * The adapter it runs in is its owner: the delete, the percent switch, the re-admission and every device-object write
 * reach into it. That surface is a type, not a guess at runtime — the duck-typed lookup with fallback branches existed
 * for a test double only (review 2026-10-05, G).
 */
export class YamahaDeviceManagement extends DeviceManagement<AdapterInstance & DeviceOwner> {
  /** The one owner of the found/deleted lists — the adapter's own, so both write on one chain (review 2026-10-05, A31). */
  private readonly stores: DeviceStores;

  /**
   * @param adapter the running adapter
   * @param stores the adapter's store owner; a backend built on its own (a test) makes its own
   */
  public constructor(adapter: AdapterInstance & DeviceOwner, stores: DeviceStores = deviceStoresOf(adapter)) {
    super(adapter);
    this.stores = stores;
  }

  /** The instance object id whose `native` holds the manual device table. */
  private get objId(): string {
    return `system.adapter.${this.adapter.namespace}`;
  }

  /**
   * Merge into a device object, through the adapter's write chain: two `extendObject` at the same moment each write what
   * they read, and the later one takes the earlier one's fields away — a name typed here could vanish under a profile
   * write (audit 2026-09-29, A37).
   *
   * @param deviceId the id-safe device id
   * @param patch what to merge
   */
  private async writeDevice(deviceId: string, patch: ioBroker.PartialDeviceObject): Promise<void> {
    await this.adapter.writeDeviceObject(deviceId, patch);
  }

  /**
   * Write the device table as the LAST step, behind the handler's answer: writing the instance's
   * `native` restarts the adapter, and a handler that awaits it never answers; the device-object
   * writes before it finish first (audit 2026-09-29, A37 — the delete did this already).
   *
   * @param rows the table to write
   * @param what what the write is for, for the error line
   */
  private scheduleTableWrite(rows: DeviceRow[], what: string): void {
    this.adapter.setTimeout(() => {
      this.writeManual(rows).catch((e: unknown) =>
        this.adapter.log.error(`could not update the device table ${what} (${errText(e)})`),
      );
    }, 0);
  }

  /** Read the manual device table (`native.devices`) as raw rows, keeping the name. */
  private async readManual(): Promise<DeviceRow[]> {
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (obj?.native as { devices?: unknown } | undefined)?.devices;
    if (!Array.isArray(devices)) {
      return [];
    }
    return devices.filter(
      (d): d is DeviceRow => !!d && typeof (d as DeviceRow).ip === "string" && (d as DeviceRow).ip.length > 0,
    );
  }

  /**
   * Persist the manual device table; writing `native.*` restarts the adapter with the new set.
   *
   * @param rows the manual rows to store
   */
  private async writeManual(rows: DeviceRow[]): Promise<void> {
    await this.adapter.extendForeignObjectAsync(this.objId, { native: { devices: rows } });
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
    if (existing) {
      // The adapter is running this device: it writes the value AND rebuilds the volume
      // datapoints on the spot, so the change is visible without a restart.
      await this.adapter.setVolumePercent(deviceId, on);
      return;
    }
    // A device just added through the dialog has no object yet — seed the shape
    // `ensureDeviceHeader` completes on the next start, so the answer has somewhere to live.
    await this.writeDevice(deviceId, {
      type: "device",
      common: { name: deviceId },
      native: { volumeAsPercent: on },
    });
  }

  /**
   * The running device set as cards: the manual table AND the discovery store, exactly the
   * union the adapter itself runs (`unionDevices`), so the list matches what is live. The table is read by the
   * adapter's own parser (`parseDevices`: valid rows, no reserved id, the first row of an id) — a second copy of its
   * rules stood here (review 2026-10-05, E) — and a deleted device a failed write left in the store gets no card (A31).
   *
   * @returns the cards
   */
  private async cards(): Promise<CardDevice[]> {
    const rows = await this.readManual();
    const names = new Map<string, string>();
    for (const row of rows) {
      const id = rowDeviceId(row);
      if (!names.has(id)) {
        names.set(id, row.name && row.name.length > 0 ? row.name : row.ip);
      }
    }
    const discovered = rememberedDevices(await this.stores.read());
    return unionDevices(parseDevices(rows), discovered).map(device => ({
      id: device.id,
      ip: device.ip,
      name: names.get(device.id) ?? device.id,
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
      this.adapter.log.error(`device manager: could not list the devices (${errText(e)})`);
      return;
    }
    for (const card of cards) {
      // One card whose reads fail must not cost the whole list (audit 2026-09-24, A18).
      try {
        await this.addCard(context, card);
      } catch (e) {
        this.adapter.log.error(`device manager: ${card.id} could not be shown (${errText(e)})`);
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
      this.adapter.log.error(`device manager: ${action}${deviceId ? ` of ${deviceId}` : ""} failed (${errText(e)})`);
      try {
        await context?.showMessage(tName("dmActionFailed", errText(e)));
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
    // The card title follows the device object's name, not the table entry: the row carries
    // the stored id (3.0.0), a migrated row the receiver's ip — the object carries the
    // readable name the adapter learned from the device or the user typed.
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
      description: tName("dmDelete"),
      // The UI asks BEFORE the handler runs (dm-utils `confirmation`): no message round-trip,
      // and the text names what goes with the device. `showConfirmation` inside the handler
      // used to leave the reply hanging when the manual branch's table write restarted the
      // instance — the progress bar span until the admin gave up.
      confirmation: tName("dmDeleteConfirm", card.name),
      handler: async (id: string, ctx?: ActionContext): Promise<{ delete: string } | { refresh: "devices" }> =>
        this.runAction<{ delete: string } | { refresh: "devices" }>("delete", id, ctx, () => this.deleteDevice(id), {
          refresh: "devices",
        }),
    };
    const edit = {
      id: "edit",
      icon: "edit",
      description: tName("dmEdit"),
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
        ...TRANSPORT_LABELS.map(tr => ({
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
          tooltip: tName(percent ? "volumeAsPercent" : "volumeDeviceScale"),
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
      // too many (krobi 2026-09-12: "why did you put that in twice?").
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
    const line = (
      key: "dmDetailsId" | "dmDetailsMac" | "dmDetailsSerial" | "dmActionFailed",
      value?: string,
    ): unknown => ({
      type: "staticText",
      text: tName(key, value ?? "–"),
      newLine: true,
      sm: 12,
    });
    // Inside the actions' error frame: dm-utils answers nothing when this throws, and the card's
    // "more" window waited for good with a log line that named neither action nor device (A38).
    let identity: ReturnType<typeof identityOfDeviceObject>;
    let failure: string | undefined;
    try {
      const node = await this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${id}`);
      identity = identityOfDeviceObject((node?.native ?? {}) as Record<string, unknown>);
    } catch (e) {
      failure = errText(e);
      this.adapter.log.error(`device manager: details of ${id} failed (${failure})`);
    }
    const schema = {
      type: "panel",
      items: {
        id: line("dmDetailsId", id),
        mac: line("dmDetailsMac", identity?.mac?.replace(/(..)(?!$)/g, "$1:")),
        serial: line("dmDetailsSerial", identity?.serial),
        ...(failure !== undefined ? { failure: line("dmActionFailed", failure) } : {}),
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
      identifierLabel: tName("ipLabel"),
      actions: [
        {
          id: "add",
          icon: "add",
          description: tName("dmAdd"),
          handler: async ctx => this.runAction("add", undefined, ctx, () => this.addDevice(ctx), { refresh: true }),
        },
        // The way back for a deleted device: without it an exclusion is invisible and permanent.
        {
          id: "excluded",
          icon: "lines",
          description: tName("dmExcluded"),
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
    const data = await context.showForm(buildDeviceForm(takenAddresses(await this.cards())), {
      title: tName("dmAdd"),
    });
    if (data && typeof data.ip === "string" && data.ip.trim()) {
      const ip = data.ip.trim();
      const typedName = typeof data.name === "string" ? data.name.trim() : "";
      if (!isIPv4(ip)) {
        await context.showMessage(tName("invalidIp"));
        return { refresh: true };
      }
      // A name that IS the address says nothing the address does not — it is no display name.
      const name = typedName === ip ? "" : typedName;
      const report = await identifyDevice(ip);
      const found = rememberedDevices(await this.stores.read());
      // The same receiver found by the search already runs — a second card would be a second tree.
      if (found.some(record => sameDevice(record.identity, report.identity))) {
        await context.showMessage(tName("duplicateDevice"));
        return { refresh: true };
      }
      const taken = new Set([...manual.map(entry => rowDeviceId(entry)), ...found.map(record => record.id)]);
      const id = deviceIdFor({ model: report.model, identity: report.identity, name, ip }, taken);
      // The row carries the id as its name too: a return to 2.x derives the id from the name, and
      // then finds the tree where it is (and a typed row never reads as a migrated one).
      const row: DeviceRow = { id, name: id, ip };
      const clash = findClash(manual, row, -1, new Set(found.map(record => record.id)));
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      manual.push(row);
      // Adding a device by hand undoes an earlier delete of the same device — otherwise the
      // exclusion would silently outlive the decision that created it. By its id, and by the id
      // 2.x gave the same name: a device deleted before 3.0.0 is on the list under that one. The
      // same for the exclusion entries — by id, by address and by identity: the entry of a
      // deleted manual device carries the address the user is typing again right now. A list that
      // cannot be read is left as it is; the typed row runs whatever the lists say.
      const lifted = new Set([id, ...(name !== "" ? [sanitizeId(name)] : [])]);
      await this.stores.update(now => ({
        ignored: now.ignored.filter(entry => !lifted.has(entry)),
        excluded: now.excluded.filter(
          entry => !lifted.has(entry.id) && entry.ip !== row.ip && !sameDevice(entry.identity, report.identity),
        ),
      }));
      // Written down right away, so the device starts with the answer the user gave instead of
      // inheriting whatever the instance-wide switch of 2.8.0 was left on.
      await this.applyVolumePercent(id, data.volumeAsPercent === true);
      if (name !== "") {
        // The name the user typed is the display name from the start — the id no longer carries it.
        await this.writeDevice(id, {
          common: { name: typedName },
          native: { label: typedName, labelRank: LABEL_RANK.user },
        });
      }
      this.scheduleTableWrite(manual, `after adding "${id}"`);
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
    const { excluded, ignored, unreadable } = await this.stores.read();
    // A list that cannot be read would show as "nothing excluded" — and the deletes it holds could not be lifted anyway
    // (review 2026-10-05, A28). Said instead, through the action's error answer.
    const broken = (["excluded", "ignored"] as const).filter(name => unreadable.has(name));
    if (broken.length > 0) {
      throw new Error(`${broken.map(name => `${name}.json`).join(" and ")} cannot be read — see the adapter log`);
    }
    // One row per id: the entry with address and identity where there is one, the bare id from
    // the plain list otherwise (an exclusion written before there were entries).
    const entries = [
      ...excluded,
      ...ignored.filter(id => !excluded.some(entry => entry.id === id)).map(id => ({ id })),
    ];
    if (entries.length === 0) {
      await context.showMessage(tName("dmExcludedNone"));
      return { refresh: false };
    }
    const data = await context.showForm(buildExcludedForm(entries), {
      title: tName("dmExcludedTitle"),
      buttons: ["apply", "cancel"],
    });
    if (!data) {
      return { refresh: false };
    }
    const lifted = entries.map(entry => entry.id).filter(id => data[id] === true);
    if (lifted.length === 0) {
      return { refresh: false };
    }
    await this.stores.update(now => ({
      excluded: now.excluded.filter(entry => !lifted.includes(entry.id)),
      ignored: now.ignored.filter(id => !lifted.includes(id)),
    }));
    this.adapter.rediscoverNow(lifted);
    return { refresh: true };
  }

  /**
   * Edit one device: its display name and its address. Offered on every card.
   *
   * Two rules make this safe, and both were learned from what the adapter does elsewhere:
   *
   * 1. **The object id never changes.** It is stored in the row (since 3.0.0), and a changed
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
    // From the object just read — no second read for the switch.
    const percent = (node?.native as { volumeAsPercent?: unknown } | undefined)?.volumeAsPercent === true;
    const data = await context.showForm(buildDeviceForm(takenAddresses(cards, cardId)), {
      title: tName("dmEditTitle"),
      data: { name: shownName, ip: card.ip, volumeAsPercent: percent },
    });
    if (!data || typeof data.ip !== "string" || !data.ip.trim()) {
      return { refresh: "devices" };
    }
    const ip = data.ip.trim();
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const manual = await this.readManual();
    const index = manual.findIndex(entry => rowDeviceId(entry) === cardId);
    // The row keeps the card's id — stored, and as its name for a return to 2.x.
    const row: DeviceRow = { id: cardId, name: cardId, ip };
    const clash = findClash(manual, row, index);
    if (clash) {
      await context.showMessage(clash);
      return { refresh: "devices" };
    }
    let tableChanged = false;
    if (index >= 0) {
      // Only a new address changes the table. Name and percent switch live at the device object, and every write of
      // the table restarts the instance — all devices reconnected and YNCA swept again for a display name (review
      // 2026-10-05, A10). A row the 0.5.4 migration wrote keeps its address as its NAME — the mark that makes it
      // follow the receiver (`parseDevices`); written as `{ id, name: id }` it turned into a typed row, stopped
      // following, and under "Automatic" switched the network search off. Only its `ip` moves, as the adapter's own
      // address update does (`updateTableAddress`).
      if (ip !== manual[index].ip) {
        manual[index] = isDottedQuad(manual[index].name ?? "") ? { ...manual[index], ip } : row;
        tableChanged = true;
      }
    } else if (ip !== card.ip) {
      await this.stores.update(now => ({ discovered: now.discovered.filter(entry => entry.id !== cardId) }));
      manual.push(row);
      tableChanged = true;
    }
    if (name !== shownName) {
      // The marker rides along with the name, at the rank only this dialog writes: it tells the
      // next start that THIS name is the established one (`ensureDeviceHeader` writes it back
      // instead of the bare id) and it outranks every name a device reports for itself, so a
      // MusicCast zone name can no longer overwrite what the user typed here.
      await this.writeDevice(cardId, {
        common: { name: name || cardId },
        native: { label: name || cardId, labelRank: LABEL_RANK.user },
      });
    }
    if ((data.volumeAsPercent === true) !== percent) {
      await this.applyVolumePercent(cardId, data.volumeAsPercent === true);
    }
    if (tableChanged) {
      this.scheduleTableWrite(manual, `after editing "${cardId}"`);
    }
    return { refresh: "devices" };
  }

  /**
   * Delete a device for good. The UI confirmed already (see the action descriptor). The order
   * is the fix for "I deleted it and it came back":
   *
   * 1. The exclusion is written FIRST — a search running right now must not put the device
   *    back: `excluded.json`, with address and identity. The plain id list (`ignored.json`) is no
   *    longer appended to — only read, and pruned when a device is admitted again; an id this version writes there never matched on a rollback, 2.x derives its ids
   *    from the name (audit 2026-09-29, A31).
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
    const index = manual.findIndex(r => rowDeviceId(r) === cardId);
    // Who the device is: the identity the transports learned (`native.identity`), the one in its capability profile, and
    // the one the search read — with it the exclusion survives a rename and a new address; without it the address has
    // to do (review 2026-10-05, A11).
    const node = await this.adapter.getForeignObjectAsync(`${this.adapter.namespace}.${cardId}`);
    let listed = index >= 0;
    // The exclusion and the record's removal are ONE step on the stores, the exclusion written first — a search
    // running right now reads it (review 2026-10-05, A31).
    const writes = await this.stores.update(now => {
      const record = now.discovered.find(device => device.id === cardId);
      if (index < 0 && !record) {
        return undefined;
      }
      listed = true;
      const ip = index >= 0 ? manual[index].ip : record!.ip;
      const identity = identityOfDeviceObject(node?.native as Record<string, unknown> | undefined, record?.identity);
      return {
        excluded: [...now.excluded, { id: cardId, ip, ...(identity ? { identity } : {}) }],
        ...(record ? { discovered: now.discovered.filter(device => device.id !== cardId) } : {}),
      };
    });
    if (!listed) {
      return { delete: cardId };
    }
    // Y-13: a delete is for good. Without its exclusion the next search brings the device back — so nothing is deleted,
    // and the dialog says why (review 2026-10-05, A28).
    if (writes.excluded !== "written" && writes.excluded !== "unchanged") {
      const reason =
        writes.excluded === "refused"
          ? "the exclusion list excluded.json cannot be read"
          : "the exclusion list excluded.json could not be written";
      throw new Error(`${reason} — ${cardId} was not deleted, the next search would bring it back`);
    }
    await this.adapter.removeDevice(cardId);
    if (index >= 0) {
      manual.splice(index, 1);
      this.adapter.setTimeout(() => {
        this.writeManual(manual).catch((e: unknown) =>
          // The tree is gone and the id is excluded, but the row still stands: the next start
          // would run the device from the table again, with a fresh tree — say so, loudly.
          this.adapter.log.error(
            `could not update the device table after deleting "${cardId}" (${errText(e)}) — the device is still listed in the table, delete it once more`,
          ),
        );
      }, 0);
    }
    return { delete: cardId };
  }
}

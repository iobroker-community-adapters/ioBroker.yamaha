import { remoteObjectDefs } from "../browse/objects";
import { MENU_WIRE, RETURN_CURSOR_WIRE, wireFor } from "../browse/types";
import { TRANSPORT_KEYS } from "../catalog/media-state";
import { coerceBool, textWriteProblem } from "../catalog/value-coerce";
import { splitZone } from "../catalog/zones";
import { errText } from "../err-text";
import { tName } from "../i18n";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";
import { MEMORY_KEY, xmlZoneNamesKey } from "../lifecycle/memory-keys";
import type { XmlControllerContext, XmlWriteRoute } from "./controller-context";
import { decodeXmlText, escapeXmlText } from "./entities";
import { definiteXmlBody, type XmlDescriptor } from "./protocol";
import type { XmlZone } from "./zones";

/** The transport keys of `Play_Control,Playback` and their wire words (desc.xml, RX-V675 & co). */
const XML_TRANSPORT_WIRE: Record<string, string> = {
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  next: "Skip Fwd",
  prev: "Skip Rev",
};

/** The 2008 generation's zone name (`Rename,Rename_Latin_1`, RX-V3900 desc.xml P6/G3 — D15). */
const RENAME_PATH = "Rename,Rename_Latin_1";
const RENAME_GET = "<Rename><Rename_Latin_1>GetParam</Rename_Latin_1></Rename>";

/** A zone's contents display (`Cursor_Control,Contents_Display`, desc.xml G9 — D15). */
const CONTENTS_DISPLAY_GET = "<Cursor_Control><Contents_Display>GetParam</Contents_Display></Cursor_Control>";

/** The all-zones power read (`System,Power_Control,Power`; RX-V6A capture `xml-system-power.xml`). */
const SYSTEM_POWER_GET = "<Power_Control><Power>GetParam</Power></Power_Control>";

/** The zone-relative ids of the zone commands (pads, transport keys, names). */
const ZONE_COMMAND =
  /^(remote\.(?:cursor|menu)|player\.(?:play|pause|stop|next|prev)|zoneName|multiroom\.zoneB\.name)$/;

/**
 * The all-zones power from its answer.
 *
 * @param xml the response body
 * @returns true for On, false for Standby, undefined when the answer carries neither
 */
function parseSystemPower(xml: string): boolean | undefined {
  const power = /<Power_Control>\s*<Power>(On|Standby)<\/Power>/.exec(xml)?.[1];
  return power === undefined ? undefined : power === "On";
}

/**
 * The commands an XML receiver takes beyond its status catalog: the all-zones power, each zone's contents display,
 * the party volume keys, the transport keys and the zone-wide pads of each zone, and the zone names. All of them
 * exist where the device description declares them or where the device answers their read — a part of the
 * controller that stood as six sections of it (review 2026-10-05, D).
 */
export class XmlDeclaredCommands {
  /** Whether the device answered `System,Power_Control,Power` (the all-zones power; D4). */
  private hasSystemPower = false;
  /** The zones whose contents display answered (D15). */
  private readonly contentsDisplayZones = new Set<string>();
  /**
   * The zone commands desc.xml declares (zone elements): the zone-wide cursor pad and menu keys,
   * the transport keys. Read from the device description, so a receiver that declares none
   * (the 2012 entry class) offers none.
   */
  private zoneCommands: { cursor: Set<string>; menu: Set<string>; playback: Set<string> } = {
    cursor: new Set(),
    menu: new Set(),
    playback: new Set(),
  };
  /** The states this part created — the write routes serve exactly these. */
  private readonly created = new Set<string>();

  /**
   * @param ctx the controller's shared context
   * @param zones the device's zones (read when a write or a refresh comes, after the start-up decided them)
   */
  public constructor(
    private readonly ctx: XmlControllerContext,
    private readonly zones: () => readonly XmlZone[],
  ) {}

  /**
   * Take the zone commands the device description declares.
   *
   * @param descriptor the parsed device description
   */
  public declare(descriptor: XmlDescriptor): void {
    this.zoneCommands = {
      cursor: new Set(descriptor.cursorZones ?? []),
      menu: new Set(descriptor.menuZones ?? []),
      playback: new Set(descriptor.playbackZones ?? []),
    };
  }

  /**
   * The zone-wide pad the description declares for the main zone — what the browse driver sends the main zone's keys
   * through.
   *
   * @returns whether the main zone declares the cursor pad and the menu keys
   */
  public mainZonePad(): { cursor: boolean; menu: boolean } {
    return { cursor: this.zoneCommands.cursor.has("Main_Zone"), menu: this.zoneCommands.menu.has("Main_Zone") };
  }

  /**
   * The all-zones power: every desc.xml declares `System,Power_Control,Power` (10 of 10, the 2008
   * RX-V3900 included) and the predecessor switched it; the id is YNCA's `multiroom.masterPower`, so a
   * receiver without YNCA keeps the switch (audit 2026-09-29, D4). Proven by the device's answer.
   */
  public async setupSystemPower(): Promise<void> {
    const ctx = this.ctx;
    const probe = await ctx.probeXml(MEMORY_KEY.xmlSystemPower, "System", SYSTEM_POWER_GET);
    const power = parseSystemPower(probe);
    if (power === undefined) {
      return;
    }
    this.hasSystemPower = true;
    await ctx.ensureChannels("multiroom.masterPower");
    await ctx.deps.upsertObject(`${ctx.deviceId}.multiroom.masterPower`, {
      id: "multiroom.masterPower",
      type: "state",
      common: {
        name: tName("masterPowerAllZones"),
        desc: tName("descMasterPowerAllZones"),
        type: "boolean",
        role: "switch.power",
        read: true,
        write: true,
      },
    });
    this.markCreated("multiroom.masterPower");
    await this.refreshSystemPower();
  }

  /**
   * The contents display of every zone that declares it (`Cursor_Control,Contents_Display`, GET and
   * PUT On/Off, six desc.xml) — the id is YNCA's `sound.contentsDisplay` (audit 2026-09-29, D15).
   * Proven by the zone's answer.
   */
  public async setupContentsDisplay(): Promise<void> {
    const ctx = this.ctx;
    for (const zone of this.zones()) {
      if (!ctx.declares(zone.element, "Cursor_Control,Contents_Display")) {
        continue;
      }
      const on = await this.readContentsDisplay(zone);
      if (on === undefined) {
        continue;
      }
      const stateId = `${zone.prefix}sound.contentsDisplay`;
      await ctx.ensureChannels(stateId);
      await ctx.deps.upsertObject(`${ctx.deviceId}.${stateId}`, {
        id: stateId,
        type: "state",
        common: {
          name: tName("contentsDisplay"),
          desc: tName("descContentsDisplay"),
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
        },
      });
      this.markCreated(stateId);
      this.contentsDisplayZones.add(zone.key);
      ctx.emit(stateId, on);
    }
  }

  /**
   * The party-mode volume keys where the description declares them (`System,Party_Mode,Volume,Lvl`
   * Up/Down — RX-A2060, RX-S601D, RX-V775): YNCA's `multiroom.partyVolumeUp`/`Down` buttons (D15). The
   * party mute is declared as a write only — no description declares a read, so a switch could never
   * show the device's state; it stays with YNCA, which every one of these models has.
   */
  public async setupPartyVolume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.declares("System", "Party_Mode,Volume,Lvl")) {
      return;
    }
    for (const [state, nameKey, descKey] of [
      ["multiroom.partyVolumeUp", "partyVolumeUp", "descPartyVolumeUp"],
      ["multiroom.partyVolumeDown", "partyVolumeDown", "descPartyVolumeDown"],
    ] as const) {
      await ctx.ensureChannels(state);
      await ctx.deps.upsertObject(`${ctx.deviceId}.${state}`, {
        id: state,
        type: "state",
        common: {
          name: tName(nameKey),
          desc: tName(descKey),
          type: "boolean",
          role: "button",
          read: false,
          write: true,
        },
      });
      this.markCreated(state);
    }
  }

  /**
   * The transport keys desc.xml declares per zone (`Play_Control,Playback`: Play, Pause, Stop,
   * Skip Fwd, Skip Rev — 8 of the 10 captured descriptors, per zone on the 2013+ models): five
   * keys on the flat player block of the zone, the same ids YNCA and MusicCast use, so on a
   * receiver with a richer transport the owner policy hands them over.
   */
  public async setupTransportKeys(): Promise<void> {
    const ctx = this.ctx;
    for (const zone of this.zones()) {
      if (!this.zoneCommands.playback.has(zone.element)) {
        continue;
      }
      await ctx.ensureChannels(`${zone.prefix}player.play`);
      for (const [key, { nameKey, role }] of Object.entries(TRANSPORT_KEYS)) {
        const stateId = `${zone.prefix}player.${key}`;
        await ctx.deps.upsertObject(`${ctx.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: { name: tName(nameKey), type: "boolean", role, read: false, write: true },
        });
        this.markCreated(stateId);
      }
    }
  }

  /**
   * Every zone's own name from `<Config><Name><Zone>` (desc.xml `Config,Name,Zone`, 5+4+1+1
   * zones over the captured descriptors) — read on every connection (the user can rename a zone at
   * the device, D8) with `xmlZoneNames:<zone>` as the fallback; a zone that declares none gets no datapoint. Same id as
   * YNCA's ZONENAME, so an XML-only receiver finally shows the names its owner gave the zones.
   */
  public async setupZoneNames(): Promise<void> {
    const ctx = this.ctx;
    for (const zone of this.zones()) {
      const names = await this.probeZoneNames(zone);
      if (names.zone) {
        const stateId = `${zone.prefix}zoneName`;
        const write =
          !ctx.hasCommandList() ||
          ctx.declares(zone.element, "Config,Name,Zone") ||
          ctx.declares(zone.element, RENAME_PATH);
        await ctx.ensureChannels(stateId);
        await ctx.deps.upsertObject(`${ctx.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: {
            name: tName("zoneName"),
            desc: tName("descZoneName"),
            type: "string",
            role: "text",
            read: true,
            write,
          },
        });
        this.markCreated(stateId, write);
        ctx.emit(stateId, names.zone);
      }
      // The Zone B name rides in the main zone's Config (`Config,Name,Zone_B`, HTR-4069, RX-V579,
      // TSR-5810) — YNCA's ZONEBNAME under the same id (audit 2026-09-29, D15).
      if (zone.key === "main" && names.zoneB) {
        const stateId = "multiroom.zoneB.name";
        const write = !ctx.hasCommandList() || ctx.declares(zone.element, "Config,Name,Zone_B");
        await ctx.ensureChannels(stateId);
        await ctx.deps.upsertObject(`${ctx.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: {
            name: tName("zoneBName"),
            desc: tName("descZoneName"),
            type: "string",
            role: "text",
            read: true,
            write,
          },
        });
        this.markCreated(stateId, write);
        ctx.emit(stateId, names.zoneB);
      }
    }
  }

  /**
   * The zone-wide pads desc.xml declares: `remote.cursor` / `remote.menu` under every zone whose
   * `Cmd_List` defines `Cursor_Control,Cursor` / `Menu_Control` — the main zone's only when no
   * browse surface owns it already (then the surface's pad goes zone-wide through the driver).
   *
   * @param mainTaken whether a browse surface already carries the main zone's pad
   */
  public async setupZonePads(mainTaken: boolean): Promise<void> {
    const ctx = this.ctx;
    for (const zone of this.zones()) {
      if (zone.key === "main" && mainTaken) {
        continue;
      }
      const cursor = this.zoneCommands.cursor.has(zone.element);
      const menu = this.zoneCommands.menu.has(zone.element);
      if (!cursor && !menu) {
        continue;
      }
      await ctx.ensureChannels(`${zone.prefix}remote.cursor`);
      const defs = remoteObjectDefs(
        cursor ? Object.keys(RETURN_CURSOR_WIRE) : undefined,
        menu ? Object.keys(MENU_WIRE) : undefined,
        zone.prefix,
      );
      for (const def of defs.filter(object => object.type === "state")) {
        await ctx.deps.upsertObject(`${ctx.deviceId}.${def.id}`, def);
        this.markCreated(def.id);
      }
    }
  }

  /** Read the all-zones power and the contents displays again (the keepalive). */
  public async refresh(): Promise<void> {
    if (this.hasSystemPower) {
      await this.refreshSystemPower();
    }
    await this.refreshContentsDisplay();
  }

  /** @returns the write routes of these commands, in the order the controller asks them */
  public routes(): { zoneCommands: XmlWriteRoute; systemPower: XmlWriteRoute; contentsAndParty: XmlWriteRoute } {
    return {
      zoneCommands: {
        serves: stateId => this.servesZoneCommand(stateId),
        write: (stateId, value) => this.writeZoneCommand(stateId, value),
      },
      systemPower: {
        serves: stateId => stateId === "multiroom.masterPower",
        write: (stateId, value) => this.writeSystemPower(stateId, value),
      },
      contentsAndParty: {
        serves: stateId =>
          splitZone(stateId).name === "sound.contentsDisplay" ||
          stateId === "multiroom.partyVolumeUp" ||
          stateId === "multiroom.partyVolumeDown",
        write: (stateId, value) =>
          splitZone(stateId).name === "sound.contentsDisplay"
            ? this.writeContentsDisplay(stateId, value)
            : this.writePartyVolume(stateId, value),
      },
    };
  }

  /**
   * Record a state this part created, for the write routes and the controller's claim-with-proof gate.
   *
   * @param stateId the state id
   * @param write whether it is writable
   */
  private markCreated(stateId: string, write = true): void {
    this.created.add(stateId);
    this.ctx.markWritable(stateId, write);
  }

  /** Read the all-zones power and write it (poll and read-back). */
  private async refreshSystemPower(): Promise<void> {
    const ctx = this.ctx;
    try {
      const power = parseSystemPower(await ctx.deps.client.getXml("System", SYSTEM_POWER_GET));
      if (power !== undefined) {
        ctx.emit("multiroom.masterPower", power);
      }
    } catch (e) {
      ctx.deps.log.debug(`${ctx.deviceId}: system power failed: ${errText(e)}`);
    }
  }

  /**
   * A write to `multiroom.masterPower` → `System,Power_Control,Power` On/Standby.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  private writeSystemPower(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    const on = coerceBool(value);
    if (!this.hasSystemPower) {
      return this.ctx.dropWrite(stateId, value, "this device answered no all-zones power");
    }
    if (on === undefined) {
      return this.ctx.dropWrite(stateId, value, "it is no switch value");
    }
    return this.ctx.applyCommand(
      { zone: "System", inner: `<Power_Control><Power>${on ? "On" : "Standby"}</Power></Power_Control>` },
      () => this.refreshSystemPower(),
    );
  }

  /**
   * Read one zone's contents display.
   *
   * @param zone the zone
   * @returns On as true, Off as false, undefined when the zone does not answer it
   */
  private async readContentsDisplay(zone: XmlZone): Promise<boolean | undefined> {
    const ctx = this.ctx;
    try {
      const body = await ctx.deps.client.getXml(zone.element, CONTENTS_DISPLAY_GET);
      const word = /<Contents_Display>\s*(On|Off)\s*<\/Contents_Display>/.exec(body)?.[1];
      return word === undefined ? undefined : word === "On";
    } catch (e) {
      ctx.deps.log.debug(`${ctx.deviceId}: ${zone.element} contents display failed: ${errText(e)}`);
      return undefined;
    }
  }

  /** Read the contents display of every zone that has one (poll and read-back). */
  private async refreshContentsDisplay(): Promise<void> {
    for (const zone of this.zones()) {
      if (!this.contentsDisplayZones.has(zone.key)) {
        continue;
      }
      const on = await this.readContentsDisplay(zone);
      if (on !== undefined) {
        this.ctx.emit(`${zone.prefix}sound.contentsDisplay`, on);
      }
    }
  }

  /**
   * A write to a zone's `sound.contentsDisplay` → `Cursor_Control,Contents_Display` On/Off.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  private writeContentsDisplay(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    const zoneKey = splitZone(stateId).zone;
    const zone = this.zones().find(candidate => candidate.key === zoneKey);
    const on = coerceBool(value);
    if (!zone || !this.contentsDisplayZones.has(zone.key)) {
      return this.ctx.dropWrite(stateId, value, "this zone answered no contents display");
    }
    if (on === undefined) {
      return this.ctx.dropWrite(stateId, value, "it is no switch value");
    }
    return this.ctx.applyCommand(
      {
        zone: zone.element,
        inner: `<Cursor_Control><Contents_Display>${on ? "On" : "Off"}</Contents_Display></Cursor_Control>`,
      },
      () => this.refreshContentsDisplay(),
    );
  }

  /**
   * A press of a party-mode volume key → `System,Party_Mode,Volume,Lvl` Up/Down.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  private writePartyVolume(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    if (!this.created.has(stateId)) {
      return this.ctx.dropWrite(stateId, value, "this device declares no party volume keys");
    }
    const word = stateId === "multiroom.partyVolumeUp" ? "Up" : "Down";
    return this.ctx.applyCommand({
      zone: "System",
      inner: `<Party_Mode><Volume><Lvl>${word}</Lvl></Volume></Party_Mode>`,
    });
  }

  /**
   * A zone's names, remembered per device: its own from its Config (`Name,Zone`) — or, on the 2008
   * generation, from `Rename,Rename_Latin_1`, the path its description declares instead (RX-V3900, D15)
   * — and the Zone B name the main zone's Config carries next to it. Only a definite answer is
   * remembered (a name, or the model's own "no such node" as none); a transient failure asks again on
   * the next connect.
   *
   * @param zone the zone
   * @returns the names, "" where the zone declares none
   */
  private async probeZoneNames(zone: XmlZone): Promise<{ zone: string; zoneB: string }> {
    const ctx = this.ctx;
    const rename = ctx.declares(zone.element, RENAME_PATH);
    const probe = async (): Promise<{ zone: string; zoneB: string }> => {
      const body = await definiteXmlBody(
        () => ctx.deps.client.getXml(zone.element, rename ? RENAME_GET : "<Config>GetParam</Config>"),
        `${zone.element} name probe`,
      );
      const text = (pattern: RegExp): string => {
        const match = pattern.exec(body);
        return match ? decodeXmlText(match[1]).trim() : "";
      };
      return rename
        ? { zone: text(/<Rename_Latin_1>([^<]*)<\/Rename_Latin_1>/), zoneB: "" }
        : { zone: text(/<Name>[\s\S]*?<Zone>([^<]*)<\/Zone>/), zoneB: text(/<Name>[\s\S]*?<Zone_B>([^<]*)<\/Zone_B>/) };
    };
    try {
      // Fresh on every connection — the names are the user's (D8).
      return ctx.deps.probeMemory
        ? await ctx.deps.probeMemory.refresh(xmlZoneNamesKey(zone.key), probe)
        : await probe();
    } catch (e) {
      ctx.deps.log.debug(`${ctx.deviceId}: ${zone.element} name probe failed (${errText(e)})`);
      return { zone: "", zoneB: "" };
    }
  }

  /**
   * Whether a write is one of the zone commands this connect created (the declaration is the proof).
   *
   * @param stateId the state id relative to the device
   * @returns true for a pad key, a transport key or a zone name this connect created
   */
  private servesZoneCommand(stateId: string): boolean {
    return ZONE_COMMAND.test(splitZone(stateId).name) && this.created.has(stateId);
  }

  /**
   * A write to one of the zone commands desc.xml declares — a pad key, a transport key or the
   * zone name — goes out on the zone element in the declared form. An unknown word sends nothing and says so.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of the write
   */
  private writeZoneCommand(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome {
    const ctx = this.ctx;
    const { zone: zoneKey, name: command } = splitZone(stateId);
    const zone = this.zones().find(candidate => candidate.key === zoneKey);
    if (!zone) {
      return ctx.dropWrite(stateId, value, "this device has no such zone");
    }
    if (command === "remote.cursor" || command === "remote.menu") {
      const word = typeof value === "string" ? value : "";
      const wire = command === "remote.cursor" ? wireFor(RETURN_CURSOR_WIRE, word) : wireFor(MENU_WIRE, word);
      if (wire === undefined) {
        return ctx.dropWrite(stateId, value, "it is no key this receiver declares");
      }
      const inner =
        command === "remote.cursor"
          ? `<Cursor_Control><Cursor>${wire}</Cursor></Cursor_Control>`
          : `<Cursor_Control><Menu_Control>${wire}</Menu_Control></Cursor_Control>`;
      return ctx.applyCommand({ zone: zone.element, inner }, () => ctx.refreshZone(zone));
    }
    if (command === "zoneName" || command === "multiroom.zoneB.name") {
      // desc.xml declares the name as `Text 1,9,Latin-1` (7 descriptors) — the same rule as YNCA's
      // ZONENAME: a control character, a tenth character or one Latin-1 cannot carry is not sent
      // (audit 2026-09-24, D18).
      const problem =
        typeof value === "string" ? textWriteProblem(value, { maxLength: 9, charset: "latin1" }) : "it is no text";
      if (problem !== undefined) {
        return ctx.dropWrite(stateId, value, problem);
      }
      // The name is not part of the zone status: read it back from the zone's Config — the fresh
      // probe also updates the memory, which otherwise brings the OLD name back on the next start.
      // A refused name is read back the same way, so the datapoint shows the device's name again.
      const escaped = escapeXmlText(value);
      const nameInner =
        command === "multiroom.zoneB.name"
          ? `<Config><Name><Zone_B>${escaped}</Zone_B></Name></Config>`
          : ctx.declares(zone.element, RENAME_PATH)
            ? `<Rename><Rename_Latin_1>${escaped}</Rename_Latin_1></Rename>`
            : `<Config><Name><Zone>${escaped}</Zone></Name></Config>`;
      return ctx.applyCommand({ zone: zone.element, inner: nameInner }, async () => {
        const names = await this.probeZoneNames(zone);
        const name = command === "multiroom.zoneB.name" ? names.zoneB : names.zone;
        if (name) {
          ctx.emit(stateId, name);
        }
      });
    }
    const word = XML_TRANSPORT_WIRE[command.slice("player.".length)];
    // A transport key changes what the player block shows — read it back with the zone (D3).
    return ctx.applyCommand(
      { zone: zone.element, inner: `<Play_Control><Playback>${word}</Playback></Play_Control>` },
      async () => {
        await ctx.refreshZone(zone);
        await ctx.refreshPlayers();
      },
    );
  }
}

import {
  MENU_WIRE,
  RETURN_CURSOR_WIRE,
  ROW_KIND_BY_ATTRIBUTE,
  wireFor,
  type BrowseDriver,
  type BrowseRow,
} from "./types";
import type { BrowseEngine } from "./browse-engine";
import type { ControllerLog } from "../controller";
import type { CommandPriority } from "../lifecycle/command-gate";
import { errText } from "../err-text";
import { decodeXmlText, escapeXmlText } from "../xml/entities";
import { padInner } from "../xml/protocol";

/**
 * How often, and how many times, to re-read while the device reports Menu_Status Busy — 20 × 1 s, as
 * rxv waits: a catalog service can take that long to fill a level, and 10 × 0.5 s gave up while it
 * was still coming (audit 2026-09-24, D11).
 */
const BUSY_POLL_MS = 1000;
const MAX_BUSY_POLLS = 20;

/**
 * How often, and how many times, an EMPTY window after a source switch is read again — once a
 * second for up to 20 reads, the rhythm rxv re-reads in after an input switch (see `open`).
 */
const EMPTY_READ_MS = 1000;
const MAX_EMPTY_READS = 20;

/** One XML/YNC source with a menu. */
export interface XmlBrowseSource {
  /** Unique id — what the start-up probe remembers. */
  id: string;
  /** The element that carries the menu. */
  element: string;
  /** The transport-neutral source key (`player.browse.source`). */
  key: string;
  /** The dropdown label. */
  label: string;
  /** The input name that activates the source. */
  input: string;
  /** The list element: `List_Info` (from 2009) or the 2008 generation's `List_Info_2`. */
  list: "List_Info" | "List_Info_2";
}

/**
 * The XML/YNC sources with a menu, with the transport-neutral source key and the input name that
 * activates the source. The first three are the ones the predecessor adapter's users browsed (rxv
 * drives the same three). The 2008 generation declares its menus as `List_Info_2` (RX-V3900
 * desc.xml): ONE `NET_USB` menu serves the three network inputs — which one it shows follows the
 * selected input (`NET RADIO`, `PC/MCX`, `USB`, the RX-V3900's own Input_Sel_Item) — and the iPod
 * has its own. Until 2026-09-24 that generation had no menu at all (audit, D5).
 */
export const XML_BROWSE_SOURCES: readonly XmlBrowseSource[] = [
  { id: "NET_RADIO", element: "NET_RADIO", key: "netRadio", label: "Net Radio", input: "NET RADIO", list: "List_Info" },
  { id: "SERVER", element: "SERVER", key: "server", label: "Media server", input: "SERVER", list: "List_Info" },
  { id: "USB", element: "USB", key: "usb", label: "USB", input: "USB", list: "List_Info" },
  {
    id: "NET_USB/NET RADIO",
    element: "NET_USB",
    key: "netRadio",
    label: "Net Radio",
    input: "NET RADIO",
    list: "List_Info_2",
  },
  {
    id: "NET_USB/PC/MCX",
    element: "NET_USB",
    key: "server",
    label: "Media server",
    input: "PC/MCX",
    list: "List_Info_2",
  },
  { id: "NET_USB/USB", element: "NET_USB", key: "usb", label: "USB", input: "USB", list: "List_Info_2" },
  { id: "iPod", element: "iPod", key: "ipod", label: "iPod", input: "iPod", list: "List_Info_2" },
  // The sources whose desc.xml declares the same `List_Info` form (Menu_Status/Menu_Layer/Current_List
  // and `List_Control`) — iPod_USB 9 of 10, JUKE 5, Napster/Pandora/Rhapsody 2, SiriusXM 1 (audit
  // 2026-09-29, D5). The probe decides per device; keys as on YNCA and MusicCast.
  { id: "iPod_USB", element: "iPod_USB", key: "ipodUsb", label: "iPod (USB)", input: "iPod (USB)", list: "List_Info" },
  { id: "JUKE", element: "JUKE", key: "juke", label: "JUKE", input: "JUKE", list: "List_Info" },
  { id: "Napster", element: "Napster", key: "napster", label: "Napster", input: "Napster", list: "List_Info" },
  { id: "Pandora", element: "Pandora", key: "pandora", label: "Pandora", input: "Pandora", list: "List_Info" },
  { id: "Rhapsody", element: "Rhapsody", key: "rhapsody", label: "Rhapsody", input: "Rhapsody", list: "List_Info" },
  { id: "SiriusXM", element: "SiriusXM", key: "siriusXm", label: "SiriusXM", input: "SiriusXM", list: "List_Info" },
];

/**
 * What proves a source's menu in its probe answer: `Menu_Status` in a `List_Info`; the 2008
 * `List_Info_2` carries no status (desc.xml), so its `Menu_Layer`.
 *
 * @param source the source
 * @param body the probe's answer
 * @returns whether the answer proves the menu
 */
export function provesMenu(source: XmlBrowseSource, body: string): boolean {
  return body.includes(source.list === "List_Info" ? "<Menu_Status>" : "<Menu_Layer>");
}

/** The 2008 generation's row types (`Container`: True = a folder, Play = playable, False = stays). */
const ROW_KIND_BY_CONTAINER: Readonly<Record<string, BrowseRow["kind"]>> = {
  True: "folder",
  Play: "item",
  False: "unselectable",
};

/** The cursor keys the 2008 generation declares (`Up`/`Down`/`Left`/`Right`/`Sel` — no Return, no Home). */
const LEGACY_CURSOR_VALUES = ["up", "down", "left", "right", "select"];

/** The deepest menu level the 2008 generation declares (`Menu_Layer` 1…16). */
const LEGACY_MAX_LAYER = 16;

/** The client surface the driver needs (a slice of the XML client). */
export interface XmlBrowseClient {
  /** Send an inner PUT command to an element (a zone or a source). */
  send(element: string, inner: string): Promise<void>;
  /** Read an element's inner GET request and return the raw response body. */
  getXml(element: string, inner: string, priority?: CommandPriority): Promise<string>;
}

/** A parsed List_Info response. */
export interface XmlListInfo {
  /** Whether the menu is ready (false = the device is still fetching it). */
  ready: boolean;
  /** The menu title. */
  menuName: string;
  /** The menu depth (1 = root). */
  layer: number;
  /** The cursor's absolute line number. */
  currentLine: number;
  /** Total entries in the menu. */
  totalItems: number;
  /** The visible rows. */
  rows: BrowseRow[];
}

/**
 * Parse a `<List_Info>` response (menu status, layer, name, cursor, and the eight
 * `Current_List` lines with text + attribute — the shape rxv reads).
 *
 * @param xml the List_Info response body
 * @returns the parsed window
 */
export function parseXmlListInfo(xml: string): XmlListInfo {
  const rows: BrowseRow[] = [];
  const linePattern = /<Line_([1-8])>\s*<Txt>([^<]*)<\/Txt>\s*<(Attribute|Container)>([^<]*)<\/\3>/g;
  for (let match = linePattern.exec(xml); match; match = linePattern.exec(xml)) {
    if (match[2].length > 0) {
      const kinds = match[3] === "Attribute" ? ROW_KIND_BY_ATTRIBUTE : ROW_KIND_BY_CONTAINER;
      rows.push({
        line: Number(match[1]),
        text: decodeXmlText(match[2]),
        kind: kinds[match[4]] ?? "item",
      });
    }
  }
  return {
    ready: !/<Menu_Status>Busy<\/Menu_Status>/.test(xml),
    menuName: decodeXmlText(/<Menu_Name>([^<]*)<\/Menu_Name>/.exec(xml)?.[1] ?? ""),
    layer: Number(/<Menu_Layer>(\d+)<\/Menu_Layer>/.exec(xml)?.[1] ?? 0),
    currentLine: Number(/<Current_Line>(\d+)<\/Current_Line>/.exec(xml)?.[1] ?? 1),
    totalItems: Number(/<Max_Line>(\d+)<\/Max_Line>/.exec(xml)?.[1] ?? 0),
    rows,
  };
}

/** One zone-wide pad command: the path desc.xml declares it under, and the keys (shared vocabulary) it takes. */
export interface XmlPadKeys {
  /** The declared command path after the zone element (`Cursor_Control,Cursor`, `List_Control,Menu_Control`). */
  path: string;
  /** The keys in the shared vocabulary (`up`, `on_screen`) whose wire word the declaration names. */
  keys: readonly string[];
}

/**
 * The zone-wide pad desc.xml declares for the main zone — `Cursor_Control` (7 of the 10 captured descriptors) or the
 * 2012 entry class's `List_Control` (RX-V473, decision C3) — each with exactly the declared keys.
 */
export interface XmlZoneWidePad {
  /** The cursor keys, where declared. */
  cursor?: XmlPadKeys;
  /** The menu keys, where declared. */
  menu?: XmlPadKeys;
}

/**
 * The keys of the shared vocabulary a declared pad command takes: those whose wire word the declaration names — all
 * of the table where it names the path without words (RX-V675 zone 2 and its main zone alike declare none in the
 * zone's block).
 *
 * @param table the vocabulary's wire table (`RETURN_CURSOR_WIRE`, `MENU_WIRE`)
 * @param command the declared command, if any
 * @param command.path the declared path
 * @param command.words the declared wire words
 * @returns the pad keys, undefined where nothing is declared
 */
export function declaredPadKeys(
  table: Partial<Record<string, string>>,
  command: { path: string; words: readonly string[] } | undefined,
): XmlPadKeys | undefined {
  if (command === undefined) {
    return undefined;
  }
  const keys = Object.keys(table).filter(key => command.words.length === 0 || command.words.includes(table[key]!));
  return keys.length > 0 ? { path: command.path, keys } : undefined;
}

/** What the driver knows about the receiver besides its menus. */
export interface XmlBrowseOptions {
  /** Adapter log, prefixed with the device — a cursor press with no open menu has to say so. */
  log?: ControllerLog;
  /** The zone-wide pad desc.xml declares for the main zone (none = the cursor goes to the open menu's source). */
  zoneWide?: XmlZoneWidePad;
  /** The main zone as its status and its input list show it. */
  mainZone?: {
    /** The input the main zone is on, if known. */
    input(): string | undefined;
    /** Whether the zone's input list declares the input read-only (`RW` = `R`). */
    readOnly(input: string): boolean;
  };
}

/**
 * The XML/YNC list driver over `<List_Info>` + `<List_Control>` (the predecessor
 * adapter's browsing path). Pull-based: every operation re-reads the window, polling
 * while the device reports the menu as busy (levels come from the catalog service).
 * The cursor line stands in for the window start — the same approximation rxv makes.
 */
export class XmlBrowseDriver implements BrowseDriver {
  private engine: BrowseEngine | undefined;
  private active: XmlBrowseSource | undefined;
  private lastTotal = 0;
  /** Whether the device is of the 2008 generation (its menus are `List_Info_2`). */
  private readonly legacy: boolean;
  private readonly log: ControllerLog | undefined;
  private readonly zoneWide: XmlZoneWidePad;

  /**
   * @param client the XML client slice (send + getXml)
   * @param available the source ids whose menu the start-up probe proved (see {@link XML_BROWSE_SOURCES})
   * @param delay adapter-managed delay
   * @param options the log, the declared zone-wide pad and the main zone's input
   */
  public constructor(
    private readonly client: XmlBrowseClient,
    private readonly available: ReadonlySet<string>,
    private readonly delay: (ms: number) => Promise<void>,
    private readonly options: XmlBrowseOptions = {},
  ) {
    this.log = options.log;
    this.zoneWide = options.zoneWide ?? {};
    this.menuValues = this.zoneWide.menu?.keys;
    this.legacy = XML_BROWSE_SOURCES.some(source => source.list === "List_Info_2" && available.has(source.id));
    this.cursorValues = this.legacy
      ? LEGACY_CURSOR_VALUES
      : (this.zoneWide.cursor?.keys ?? Object.keys(RETURN_CURSOR_WIRE));
  }

  /** The menu keys — only where desc.xml declares the zone-wide menu, and only the keys it declares (C3). */
  public readonly menuValues: readonly string[] | undefined;

  /**
   * Press a menu key on the declared zone-wide menu (`Cursor_Control` or `List_Control`).
   *
   * @param value one of {@link menuValues}
   */
  public async menu(value: string): Promise<void> {
    const wire = wireFor(MENU_WIRE, value);
    const menu = this.zoneWide.menu;
    if (wire === undefined || !menu?.keys.includes(value)) {
      return;
    }
    await this.client.send("Main_Zone", padInner(menu.path, wire));
  }

  /**
   * Attach the engine that renders the windows (set after both are constructed).
   *
   * @param engine the browse engine
   */
  public attach(engine: BrowseEngine): void {
    this.engine = engine;
  }

  /** @returns the selectable sources this device offers (state value → label) */
  public sources(): Record<string, string> {
    const offered: Record<string, string> = {};
    for (const source of XML_BROWSE_SOURCES) {
      if (this.available.has(source.id) && !(source.key in offered)) {
        offered[source.key] = source.label;
      }
    }
    return offered;
  }

  /**
   * Open a source's menu: switch the main-zone input to it and read the window.
   *
   * A window without a single line right after the switch is not the menu yet: on the reporter's
   * receiver the lines stayed empty after a source switch until `pageUp` — on the first page a
   * `Jump_Line 1` plus a read, a list command that moves nothing (forum 85413). So the same command
   * goes out (`Page Up` on the 2008 generation, its declared page key, which `pageUp` sends too), and
   * the window is read again, once a second, as rxv re-reads after an input switch (`net_radio`),
   * until lines come — or {@link MAX_EMPTY_READS} reads later the empty window stands (an empty USB
   * stick has no lines).
   *
   * @param source the source key (from {@link sources})
   */
  public async open(source: string): Promise<void> {
    const entry = XML_BROWSE_SOURCES.find(s => s.key === source && this.available.has(s.id));
    if (!entry) {
      return;
    }
    this.active = entry;
    // The input is switched only where that is a switch: not when the zone is on it already, and not to an input the
    // zone's list declares read-only — the RX-V3900 reports its iPod, but refuses `Input_Sel` iPod, and the refusal
    // cost the menu (review 2026-10-05, A51).
    const mainZone = this.options.mainZone;
    if (mainZone?.input() === entry.input) {
      // already there
    } else if (mainZone?.readOnly(entry.input)) {
      this.log?.debug(`menu of ${entry.key}: input ${entry.input} takes no switch over XML — its menu opens as it is`);
    } else {
      await this.client.send("Main_Zone", `<Input><Input_Sel>${escapeXmlText(entry.input)}</Input_Sel></Input>`);
    }
    const first = await this.readWindow();
    if (!first || first.rows.length > 0) {
      this.render(first);
      return;
    }
    // A nudge of our own, not the user's command: a refusal of it must not cost the menu — the window is read again
    // either way (A51).
    try {
      await this.send(entry.list === "List_Info_2" ? "<Page>Up</Page>" : "<Jump_Line>1</Jump_Line>");
    } catch (e) {
      this.log?.debug(`menu of ${entry.key}: the empty window's nudge failed (${errText(e)}) — reading it again`);
    }
    let window = first;
    for (let read = 0; read < MAX_EMPTY_READS && window.rows.length === 0; read++) {
      if (read > 0) {
        await this.delay(EMPTY_READ_MS);
      }
      const next = await this.readWindow();
      if (!next) {
        break;
      }
      window = next;
    }
    this.render(window);
  }

  /**
   * Select a visible line via Direct_Sel — a folder opens, a playable item starts.
   *
   * @param line the line number (1–8)
   */
  public async select(line: number): Promise<void> {
    await this.control(`<Direct_Sel>Line_${line}</Direct_Sel>`);
  }

  /** Show the previous 8 lines (jump the cursor back a page; the 2008 generation's `Page`). */
  public async pageUp(): Promise<void> {
    if (this.active?.list === "List_Info_2") {
      await this.control("<Page>Up</Page>");
      return;
    }
    await this.jumpBy(-8);
  }

  /** Show the next 8 lines (jump the cursor forward a page; the 2008 generation's `Page`). */
  public async pageDown(): Promise<void> {
    if (this.active?.list === "List_Info_2") {
      await this.control("<Page>Down</Page>");
      return;
    }
    await this.jumpBy(8);
  }

  /**
   * Go one menu level back.
   *
   * Always `Return`, never a learned substitute (krobi 2026-09-03): a refusal on ONE model is
   * no reason to change the word for every other model, and a transport error is not a refusal
   * at all. Where a receiver of the 2012 generation rejects it (#613), the user reaches the same
   * step through `remote.cursor` = `left`, which that generation accepts.
   */
  public async back(): Promise<void> {
    // The 2008 generation declares no Return; its step back is `Left` (RX-V3900 desc.xml).
    await this.control(this.active?.list === "List_Info_2" ? "<Cursor>Left</Cursor>" : "<Cursor>Return</Cursor>");
  }

  /**
   * Return to the menu root. The 2008 generation declares no `Return to Home`: its declared step back
   * (`Left`) is repeated until the menu reports its first level — nothing invented, and a path walk
   * can start there.
   */
  public async home(): Promise<void> {
    if (this.active?.list !== "List_Info_2") {
      await this.control("<Cursor>Return to Home</Cursor>");
      return;
    }
    for (let step = 0; step < LEGACY_MAX_LAYER; step++) {
      const window = await this.readWindow();
      if (!window || window.layer <= 1) {
        break;
      }
      await this.send("<Cursor>Left</Cursor>");
    }
    await this.fetch();
  }

  /**
   * The cursor keys this protocol declares — the full pad, `<List_Control><Cursor>`; the 2008
   * generation's five (no Return, no Home).
   */
  public readonly cursorValues: readonly string[];

  /**
   * Press a cursor key: on the main zone's own pad where desc.xml declares one (menu open or not — that is the
   * remote's own cross): `Cursor_Control,Cursor` on 7 of the 10 captured descriptors, `List_Control,Cursor` on the
   * 2012 entry class (RX-V473 — read as "menu-bound" until review 2026-10-05, C3). Without a declaration the key goes
   * inside `List_Control` to the source whose menu is open (`PUT <NET_RADIO><List_Control>…`), so a press with no
   * menu open goes nowhere — which is said out loud rather than swallowed.
   *
   * @param value one of {@link cursorValues}
   */
  public async cursor(value: string): Promise<void> {
    const wire = wireFor(RETURN_CURSOR_WIRE, value);
    if (wire === undefined || !this.cursorValues.includes(value)) {
      return;
    }
    if (this.zoneWide.cursor) {
      await this.client.send("Main_Zone", padInner(this.zoneWide.cursor.path, wire));
      return;
    }
    if (!this.active) {
      // The pad is offered on this generation because `List_Control` declares the full cross —
      // but the command is addressed to the source whose menu is open, so with no menu open
      // there is nowhere to send it. It used to return in silence: the user pressed a key on a
      // complete-looking pad and got nothing, not even a log line (audit 2026-09-06).
      this.log?.warn(
        `cursor ${value} ignored — this receiver only accepts the cursor inside an open menu; ` +
          `pick a source in player.browse.source first`,
      );
      return;
    }
    await this.control(`<Cursor>${wire}</Cursor>`);
  }

  /**
   * Send a List_Control command to the active source — WITHOUT reading the window back,
   * for a caller that reads the window itself (see {@link home}).
   *
   * @param inner the List_Control payload (Direct_Sel, Cursor, Jump_Line)
   */
  private async send(inner: string): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.client.send(this.active.element, `<List_Control>${inner}</List_Control>`);
  }

  /**
   * Send a List_Control command to the active source and read the window back.
   *
   * @param inner the List_Control payload (Direct_Sel, Cursor, Jump_Line)
   */
  private async control(inner: string): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.send(inner);
    await this.fetch();
  }

  /**
   * Jump the cursor by a page, clamped to the menu bounds.
   *
   * @param delta the line offset (±8)
   */
  private async jumpBy(delta: number): Promise<void> {
    if (!this.active) {
      return;
    }
    const current = await this.readWindow();
    if (!current) {
      return;
    }
    const target = Math.min(Math.max(1, current.currentLine + delta), Math.max(1, this.lastTotal));
    await this.control(`<Jump_Line>${target}</Jump_Line>`);
  }

  /** Read the window (polling while busy) and render it to the engine. */
  private async fetch(): Promise<void> {
    this.render(await this.readWindow());
  }

  /**
   * Render a window to the engine (nothing when there is none — a read that stayed busy).
   *
   * @param window the parsed window
   */
  private render(window: XmlListInfo | undefined): void {
    if (window) {
      this.lastTotal = window.totalItems;
      this.engine?.onWindow({
        menuName: window.menuName,
        layer: window.layer,
        totalItems: window.totalItems,
        currentLine: window.currentLine,
        rows: window.rows,
      });
    }
  }

  /**
   * Read the active source's List_Info, polling while the device reports Busy.
   *
   * @returns the parsed window, or undefined without an active source / when busy persists
   */
  private async readWindow(): Promise<XmlListInfo | undefined> {
    if (!this.active) {
      return undefined;
    }
    for (let attempt = 0; attempt < MAX_BUSY_POLLS; attempt++) {
      const list = this.active.list;
      const info = parseXmlListInfo(
        await this.client.getXml(this.active.element, `<${list}>GetParam</${list}>`, "user"),
      );
      if (info.ready) {
        return info;
      }
      await this.delay(BUSY_POLL_MS);
    }
    // A user action that ends without a window says so (it used to end in silence).
    this.log?.warn(
      `menu of ${this.active.key} still busy after ${(MAX_BUSY_POLLS * BUSY_POLL_MS) / 1000} s — window not refreshed`,
    );
    return undefined;
  }
}

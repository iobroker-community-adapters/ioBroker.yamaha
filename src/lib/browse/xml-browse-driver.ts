import {
  ROW_KIND_BY_ATTRIBUTE,
  wireFor,
  type BrowseDriver,
  type BrowseRow,
  type CursorValue,
  type MenuValue,
  type WireTable,
} from "./types";
import type { BrowseEngine } from "./browse-engine";
import type { ControllerLog } from "../controller";
import { decodeXmlText } from "../xml/entities";

/** How often to re-read while the device reports Menu_Status Busy. */
const BUSY_POLL_MS = 500;
/** How many busy polls before giving up on one read. */
const MAX_BUSY_POLLS = 10;

/**
 * The XML/YNC sources with a List_Info menu (the ones the predecessor adapter's
 * users browsed; rxv drives the same three), with the transport-neutral source key
 * and the input name that activates the source.
 */
export const XML_BROWSE_SOURCES: ReadonlyArray<{ element: string; key: string; label: string; input: string }> = [
  { element: "NET_RADIO", key: "netRadio", label: "Net Radio", input: "NET RADIO" },
  { element: "SERVER", key: "server", label: "Media server", input: "SERVER" },
  { element: "USB", key: "usb", label: "USB", input: "USB" },
];

/** The client surface the driver needs (a slice of the XML client). */
export interface XmlBrowseClient {
  /** Send an inner PUT command to an element (a zone or a source). */
  send(element: string, inner: string): Promise<void>;
  /** Read an element's inner GET request and return the raw response body. */
  getXml(element: string, inner: string): Promise<string>;
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
  const linePattern = /<Line_([1-8])>\s*<Txt>([^<]*)<\/Txt>\s*<Attribute>([^<]*)<\/Attribute>/g;
  for (let match = linePattern.exec(xml); match; match = linePattern.exec(xml)) {
    if (match[2].length > 0) {
      rows.push({
        line: Number(match[1]),
        text: decodeXmlText(match[2]),
        kind: ROW_KIND_BY_ATTRIBUTE[match[3]] ?? "item",
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

/**
 * The pad in XML wire words. Same seven keys as YNCA's main zone, two of them spelled
 * differently (`Return`, `Return to Home`). Used inside `List_Control` (the menu-bound pad of
 * the 2012 entry class) and, where desc.xml declares `Cursor_Control,Cursor` for the zone
 * (RX-V479/V579/V675/V775, TSR-5810, RX-A2060, RX-S601D, HTR-4069 — 7 of the 10 captured
 * descriptors), inside the zone-wide `Cursor_Control`.
 */
export const XML_CURSOR_WIRE: WireTable<CursorValue> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  select: "Sel",
  return: "Return",
  home: "Return to Home",
};

/**
 * The menu keys of the zone-wide `Cursor_Control,Menu_Control` (desc.xml, same 7 descriptors):
 * `On Screen`, `Top Menu`, `Menu`, `Option`, `Display` — no `home` here, that is a cursor key.
 */
export const XML_MENU_WIRE: WireTable<MenuValue> = {
  on_screen: "On Screen",
  top_menu: "Top Menu",
  menu: "Menu",
  option: "Option",
  display: "Display",
};

/** Which zone-wide pad commands the receiver's desc.xml declares for the main zone. */
export interface XmlZoneWidePad {
  /** `Main_Zone,Cursor_Control,Cursor` declared. */
  cursor: boolean;
  /** `Main_Zone,Cursor_Control,Menu_Control` declared. */
  menu: boolean;
}

/**
 * The XML/YNC list driver over `<List_Info>` + `<List_Control>` (the predecessor
 * adapter's browsing path). Pull-based: every operation re-reads the window, polling
 * while the device reports the menu as busy (levels come from the catalog service).
 * The cursor line stands in for the window start — the same approximation rxv makes.
 */
export class XmlBrowseDriver implements BrowseDriver {
  private engine: BrowseEngine | undefined;
  private active: { element: string; key: string; input: string } | undefined;
  private lastTotal = 0;
  /**
   * @param client the XML client slice (send + getXml)
   * @param available the source keys whose List_Info the start-up probe answered
   * @param delay adapter-managed delay
   * @param log adapter log — a cursor press with no open menu has to say so
   * @param zoneWide the zone-wide pad commands desc.xml declares for the main zone (none = the
   *   menu-bound List_Control pad of the 2012 entry class)
   */
  public constructor(
    private readonly client: XmlBrowseClient,
    private readonly available: ReadonlySet<string>,
    private readonly delay: (ms: number) => Promise<void>,
    private readonly log?: ControllerLog,
    private readonly zoneWide: XmlZoneWidePad = { cursor: false, menu: false },
  ) {
    this.menuValues = zoneWide.menu ? Object.keys(XML_MENU_WIRE) : undefined;
  }

  /** The menu keys — only where desc.xml declares the zone-wide `Menu_Control`. */
  public readonly menuValues: readonly string[] | undefined;

  /**
   * Press a menu key on the zone-wide `Cursor_Control` (declared models only).
   *
   * @param value one of {@link menuValues}
   */
  public async menu(value: string): Promise<void> {
    const wire = wireFor(XML_MENU_WIRE, value);
    if (wire === undefined || !this.zoneWide.menu) {
      return;
    }
    await this.client.send("Main_Zone", `<Cursor_Control><Menu_Control>${wire}</Menu_Control></Cursor_Control>`);
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
    const entries = XML_BROWSE_SOURCES.filter(source => this.available.has(source.key));
    return Object.fromEntries(entries.map(source => [source.key, source.label]));
  }

  /**
   * Open a source's menu: switch the main-zone input to it and read the window.
   *
   * @param source the source key (from {@link sources})
   */
  public async open(source: string): Promise<void> {
    const entry = XML_BROWSE_SOURCES.find(s => s.key === source && this.available.has(s.key));
    if (!entry) {
      return;
    }
    this.active = entry;
    await this.client.send("Main_Zone", `<Input><Input_Sel>${entry.input}</Input_Sel></Input>`);
    await this.fetch();
  }

  /**
   * Select a visible line via Direct_Sel — a folder opens, a playable item starts.
   *
   * @param line the line number (1–8)
   */
  public async select(line: number): Promise<void> {
    await this.control(`<Direct_Sel>Line_${line}</Direct_Sel>`);
  }

  /** Show the previous 8 lines (jump the cursor back a page). */
  public async pageUp(): Promise<void> {
    await this.jumpBy(-8);
  }

  /** Show the next 8 lines (jump the cursor forward a page). */
  public async pageDown(): Promise<void> {
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
    await this.control("<Cursor>Return</Cursor>");
  }

  /** Return to the menu root. */
  public async home(): Promise<void> {
    await this.control("<Cursor>Return to Home</Cursor>");
  }

  /** The cursor keys this protocol declares — the full pad, `<List_Control><Cursor>`. */
  public readonly cursorValues = Object.keys(XML_CURSOR_WIRE);

  /**
   * Press a cursor key: on the zone-wide `Cursor_Control` where desc.xml declares it (menu open
   * or not — that is the remote's own cross), else inside `List_Control`, addressed to the
   * source whose menu is open (`PUT <NET_RADIO><List_Control>…`). The 2012 entry class (RX-V473,
   * #613) has only the latter, so there a press with no menu open goes nowhere — which is said
   * out loud rather than swallowed. Until 2026-09-09 this comment claimed the whole generation
   * had no zone-wide endpoint; desc.xml declares one on 7 of the 10 captured descriptors.
   *
   * @param value one of {@link cursorValues}
   */
  public async cursor(value: string): Promise<void> {
    const wire = wireFor(XML_CURSOR_WIRE, value);
    if (wire === undefined) {
      return;
    }
    if (this.zoneWide.cursor) {
      await this.client.send("Main_Zone", `<Cursor_Control><Cursor>${wire}</Cursor></Cursor_Control>`);
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
   * so a caller can tell a device refusal from a failed follow-up read (see {@link back}).
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
    const window = await this.readWindow();
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
      const info = parseXmlListInfo(await this.client.getXml(this.active.element, "<List_Info>GetParam</List_Info>"));
      if (info.ready) {
        return info;
      }
      await this.delay(BUSY_POLL_MS);
    }
    return undefined;
  }
}

/**
 * Shared contracts for the media-menu browsing surface (`player.browse.*`, issue #613).
 * One transport-neutral engine drives the states; each transport contributes a thin
 * {@link BrowseDriver} over its own list protocol (YNCA LISTINFO/LISTSEL, YXC
 * netusb getListInfo/setListControl, XML List_Info/List_Control). The surface mirrors
 * the device's own menu: an 8-line window, select-by-line, page/back/home, plus a
 * path auto-walk for scripts — the predecessor adapter's proven VIS workflow.
 */

/** The kind of a menu row, as the device reports it. */
export type BrowseRowKind = "folder" | "item" | "unplayable" | "unselectable";

/** One visible menu row. */
export interface BrowseRow {
  /** The row's line number within the window (1–8). */
  line: number;
  /** The row's raw text (no symbol prefix). */
  text: string;
  /** Whether the row is a folder, a playable item, or not selectable. */
  kind: BrowseRowKind;
  /** Cover/thumbnail URL, where the protocol carries one (YXC only). */
  thumbnail?: string;
}

/** A snapshot of the device's current menu window. */
export interface BrowseWindow {
  /** The menu title (the current folder's name). */
  menuName: string;
  /** The menu depth (1 = root). */
  layer: number;
  /** Total entries in the current menu. */
  totalItems: number;
  /**
   * The device's cursor position within the whole list (1-based) — that is what the
   * official YNCA command list defines CURRLINE as ("absolute position number of current
   * cursor position"), and the XML `Current_Line` matches it. It is NOT necessarily the
   * window's first line: after stepping back out of a submenu the cursor sits on the row
   * that was entered. The YXC driver has a real window index and reports that.
   */
  currentLine: number;
  /** The visible rows (up to 8). */
  rows: BrowseRow[];
}

/**
 * The per-transport list operations behind the engine. Every method may be async;
 * the driver reports fresh windows through the engine's `onWindow` (pull transports
 * fetch after each operation, YNCA also receives unsolicited auto-feedback).
 */
export interface BrowseDriver {
  /** The selectable sources as state-value → display-label entries. */
  sources(): Record<string, string>;
  /** Open a source's menu (the device keeps the session position). */
  open(source: string): Promise<void> | void;
  /** Select a visible line (1–8) — a folder opens, a playable item starts. */
  select(line: number): Promise<void> | void;
  /** Show the previous 8 lines. */
  pageUp(): Promise<void> | void;
  /** Show the next 8 lines. */
  pageDown(): Promise<void> | void;
  /** Go one menu level back. */
  back(): Promise<void> | void;
  /** Return to the menu root. */
  home(): Promise<void> | void;
  /**
   * The cursor-pad values this transport supports, from {@link CURSOR_VALUES} — absent
   * where the protocol has no cursor pad. The device tree offers exactly this subset, so a
   * word that appears in the dropdown always works on that device.
   */
  cursorValues?: readonly string[];
  /**
   * Press a cursor key.
   *
   * @param value one of {@link cursorValues}
   */
  cursor?(value: string): Promise<void> | void;
  /** The menu keys this transport supports, from {@link MENU_VALUES} — absent where it has none. */
  menuValues?: readonly string[];
  /**
   * Press a menu key.
   *
   * @param value one of {@link menuValues}
   */
  menu?(value: string): Promise<void> | void;
}

/**
 * The on-screen remote, in ONE vocabulary for all three protocols.
 *
 * The words are MusicCast's, because that is the set `remote.cursor`/`remote.menu` have carried
 * since v1.x — a script that presses `select` today must keep working. YNCA and XML spell the
 * same keys differently on the wire (`Sel`, `Back to Home`, `Return to Home`); each driver
 * translates, so the datapoint means the same thing on a 2009 receiver and on a 2024 one.
 *
 * A transport publishes only the words it really has: the YNCA source subunits know no
 * Left/Right, and no XML menu key is documented at all. A missing word is left out of that
 * device's dropdown rather than mapped onto something that merely looks similar.
 */
export const CURSOR_VALUES = ["up", "down", "left", "right", "select", "return", "home"] as const;

/** The menu keys, same vocabulary rule as {@link CURSOR_VALUES}. */
export const MENU_VALUES = ["on_screen", "top_menu", "menu", "option", "display", "home"] as const;

/**
 * How the two text protocols name a row's kind. YNCA (`LINE1ATRIB`) and XML
 * (`Current_List` attribute) use the SAME four words — one table for both, so a new
 * attribute value is added once instead of in two drivers that then drift apart.
 */
export const ROW_KIND_BY_ATTRIBUTE: Readonly<Record<string, BrowseRowKind>> = {
  Container: "folder",
  Item: "item",
  "Unplayable Item": "unplayable",
  Unselectable: "unselectable",
};

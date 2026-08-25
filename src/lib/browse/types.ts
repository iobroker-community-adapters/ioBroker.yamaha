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
  /** The absolute number of the window's first line (1-based). */
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
  /** Re-read the current window. */
  refresh(): Promise<void> | void;
}

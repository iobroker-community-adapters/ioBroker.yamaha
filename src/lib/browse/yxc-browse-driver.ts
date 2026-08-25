import type { BrowseDriver, BrowseRow } from "./types";
import type { BrowseEngine } from "./browse-engine";

/** The engine's page size — YXC serves any window, we keep the device's 8-line form. */
const PAGE_SIZE = 8;
/** Upper bound for the return-to-root loop (menus are never this deep). */
const MAX_HOME_STEPS = 16;

/**
 * The netusb inputs the YXC list API can browse (aiomusiccast BROWSABLE_INPUTS),
 * with the transport-neutral source key and display label. The driver offers the
 * intersection with the device's own input list.
 */
export const YXC_BROWSE_SOURCES: ReadonlyArray<{ input: string; key: string; label: string }> = [
  { input: "net_radio", key: "netRadio", label: "Net Radio" },
  { input: "server", key: "server", label: "Media server" },
  { input: "usb", key: "usb", label: "USB" },
  { input: "napster", key: "napster", label: "Napster" },
  { input: "pandora", key: "pandora", label: "Pandora" },
  { input: "rhapsody", key: "rhapsody", label: "Rhapsody" },
  { input: "siriusxm", key: "sirius", label: "SiriusXM" },
  { input: "juke", key: "juke", label: "JUKE" },
  { input: "radiko", key: "radiko", label: "radiko" },
  { input: "qobuz", key: "qobuz", label: "Qobuz" },
  { input: "deezer", key: "deezer", label: "Deezer" },
  { input: "amazon_music", key: "amazonMusic", label: "Amazon Music" },
];

/** The client surface the driver needs (a slice of the YXC client). */
export interface YxcBrowseClient {
  /** Read one window of a netusb source's list. */
  getListInfo(input: string, index: number, size?: number): Promise<unknown>;
  /** Drive the netusb list: select/play an absolute index, or go one level back. */
  setListControl(type: "select" | "play" | "return", index?: number, zone?: string): Promise<unknown>;
}

/** One raw entry of a getListInfo response. */
interface RawListEntry {
  /** The entry's text. */
  text?: unknown;
  /** The capability bitmask (b1 selectable, b2 playable). */
  attribute?: unknown;
  /** The entry's thumbnail URL. */
  thumbnail?: unknown;
}

/**
 * The YXC (MusicCast) list driver over `netusb/getListInfo` + `netusb/setListControl`.
 * Pull-based: every operation fetches the resulting window and hands it to the engine.
 * The absolute entry index is tracked here (the API pages by index, not by cursor);
 * playing an item hands the playback to the netusb input automatically.
 */
export class YxcBrowseDriver implements BrowseDriver {
  private engine: BrowseEngine | undefined;
  private active: { input: string; key: string } | undefined;
  /** The absolute (0-based) index of the window's first entry. */
  private index = 0;
  /** The last window's rows, for the select semantics (folder vs playable). */
  private rows: BrowseRow[] = [];
  private totalItems = 0;

  /**
   * @param client the YXC client slice (getListInfo + setListControl)
   * @param inputList the device's netusb input list (getFeatures `input_list`)
   */
  public constructor(
    private readonly client: YxcBrowseClient,
    private readonly inputList: readonly string[],
  ) {}

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
    const entries = YXC_BROWSE_SOURCES.filter(source => this.inputList.includes(source.input));
    return Object.fromEntries(entries.map(source => [source.key, source.label]));
  }

  /**
   * Open a source's list at the device's current position in it.
   *
   * @param source the source key (from {@link sources})
   */
  public async open(source: string): Promise<void> {
    const entry = YXC_BROWSE_SOURCES.find(s => s.key === source && this.inputList.includes(s.input));
    if (!entry) {
      return;
    }
    this.active = entry;
    this.index = 0;
    await this.fetch();
  }

  /**
   * Select a visible line: a playable item starts (the device switches to netusb),
   * a folder opens.
   *
   * @param line the line number (1–8)
   */
  public async select(line: number): Promise<void> {
    const row = this.rows.find(r => r.line === line);
    if (!this.active || !row || row.kind === "unselectable" || row.kind === "unplayable") {
      return;
    }
    const absolute = this.index + line - 1;
    if (row.kind === "item") {
      await this.client.setListControl("play", absolute, "main");
      await this.fetch();
      return;
    }
    await this.client.setListControl("select", absolute);
    this.index = 0;
    await this.fetch();
  }

  /** Show the previous 8 lines. */
  public async pageUp(): Promise<void> {
    this.index = Math.max(0, this.index - PAGE_SIZE);
    await this.fetch();
  }

  /** Show the next 8 lines. */
  public async pageDown(): Promise<void> {
    if (this.index + PAGE_SIZE < this.totalItems) {
      this.index += PAGE_SIZE;
    }
    await this.fetch();
  }

  /** Go one menu level back. */
  public async back(): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.client.setListControl("return");
    this.index = 0;
    await this.fetch();
  }

  /** Return to the menu root: step back until the device reports layer 1. */
  public async home(): Promise<void> {
    if (!this.active) {
      return;
    }
    for (let step = 0; step < MAX_HOME_STEPS; step++) {
      const layer = await this.fetch();
      if (layer === undefined || layer <= 1) {
        return;
      }
      await this.client.setListControl("return");
      this.index = 0;
    }
  }

  /** Re-read the current window. */
  public async refresh(): Promise<void> {
    await this.fetch();
  }

  /**
   * Fetch the current window, render it to the engine, and report the menu layer.
   *
   * @returns the menu layer, or undefined when the source answered with an error
   */
  private async fetch(): Promise<number | undefined> {
    if (!this.active) {
      return undefined;
    }
    const response = (await this.client.getListInfo(this.active.input, this.index)) as Record<string, unknown> | null;
    if (!response || (typeof response.response_code === "number" && response.response_code !== 0)) {
      return undefined;
    }
    const entries = Array.isArray(response.list_info) ? (response.list_info as RawListEntry[]) : [];
    this.rows = entries.slice(0, PAGE_SIZE).map((entry, i) => {
      // b1 = capable of Select (a container to enter), b2 = capable of Play.
      const attribute = typeof entry.attribute === "number" ? entry.attribute : 0;
      const playable = (attribute & 0b100) !== 0;
      const selectable = (attribute & 0b10) !== 0;
      const row: BrowseRow = {
        line: i + 1,
        text: typeof entry.text === "string" ? entry.text : "",
        kind: playable ? "item" : selectable ? "folder" : "unselectable",
      };
      if (typeof entry.thumbnail === "string" && entry.thumbnail.length > 0) {
        row.thumbnail = entry.thumbnail;
      }
      return row;
    });
    this.totalItems = typeof response.max_line === "number" ? response.max_line : this.rows.length;
    const layer = typeof response.menu_layer === "number" ? response.menu_layer : 0;
    this.engine?.onWindow({
      menuName: typeof response.menu_name === "string" ? response.menu_name : "",
      layer,
      totalItems: this.totalItems,
      currentLine: this.index + 1,
      rows: this.rows,
    });
    return layer;
  }
}

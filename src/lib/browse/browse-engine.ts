import { BROWSE_LINES, type BrowseDriver, type BrowseRow, type BrowseWindow } from "./types";
import type { ControllerLog } from "../controller";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";
import { errText } from "../err-text";
import { slotNumber } from "../catalog/value-coerce";

/** Poll interval while waiting for the device to deliver a fresh window. */
const WAIT_POLL_MS = 250;
/** How long one navigation step (select/page/back/home) may take before the walk aborts. */
const STEP_TIMEOUT_MS = 15000;
/** Hard page cap while searching one path segment, beyond the totalItems-derived bound. */
const MAX_SEARCH_PAGES = 32;

/** The adapter-bound callbacks the engine drives. */
export interface BrowseEngineDeps {
  /** Write a browse state (id relative to the device, e.g. `player.browse.line1`) with ack. */
  emit(id: string, value: boolean | number | string | null): void;
  /** Adapter log — its lines already name the device (see `createBrowseSurface`). */
  log: ControllerLog;
  /** Adapter-managed delay (so no native timer outlives onUnload). */
  delay(ms: number): Promise<void>;
}

/**
 * Prefix a row's text with its kind symbol, so a plain VIS button caption already
 * shows whether the line is a folder or a playable title.
 *
 * @param row the row to label
 * @returns the display text
 */
export function rowLabel(row: BrowseRow): string {
  if (row.kind === "folder") {
    return `\u{1F4C1} ${row.text}`;
  }
  if (row.kind === "item") {
    return `♪ ${row.text}`;
  }
  return row.text;
}

/**
 * The page a window shows, counted from 1. `currentLine` is the CURSOR on YNCA and XML and the first row on
 * MusicCast (see {@link BrowseWindow.currentLine}); either lies on the page shown, and the pages are aligned to the
 * window size — so it names the page, never the window's first row (review 2026-10-05, A22).
 *
 * @param window the window
 * @returns the page number, 1 for the first
 */
function pageOf(window: BrowseWindow): number {
  return Math.max(1, Math.ceil(window.currentLine / BROWSE_LINES));
}

/**
 * The entries a `>`-separated menu path names, trimmed, empty ones left out.
 *
 * @param path the path, e.g. `Bookmarks>Radio Paradise`
 * @returns the entries, outermost first
 */
function pathSegments(path: string): string[] {
  return path
    .split(">")
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

/**
 * A written value as a log line shows it.
 *
 * @param value the written value
 * @returns the value, a text in quotes
 */
function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/** What the search for one path segment came to: the window version before its select, or why it ended without one. */
type SegmentSearch = { before: number } | { failed: string };

/**
 * The transport-neutral browsing engine: it owns the `player.browse.*` states, turns
 * user writes into driver operations, and renders every window the driver reports.
 * Exactly one engine is active per device — the one inside the owning transport's
 * controller (writes only ever reach the owner, and a non-owner's state writes are
 * filtered by the transport adapter).
 */
export class BrowseEngine {
  private window: BrowseWindow | undefined;
  /** Bumped on every window report — the path walk waits on it. */
  private windowVersion = 0;
  /** Serializes operations: a write while an operation runs is dropped with a log line. */
  private running = false;
  private closed = false;

  /**
   * @param driver the transport's list operations
   * @param deps the adapter-bound callbacks
   */
  public constructor(
    private readonly driver: BrowseDriver,
    private readonly deps: BrowseEngineDeps,
  ) {}

  /**
   * The adapter log, for a driver that has to report a failure of its own. A driver is
   * constructed before the adapter's callbacks exist (see {@link YncaBrowseDriver.attach}), so
   * the engine it attaches to is its only way to a logger — and {@link run} already reports
   * driver failures through the same one.
   *
   * @returns the adapter log
   */
  public get log(): ControllerLog {
    return this.deps.log;
  }

  /**
   * Seed the surface into its resting form on every connect: no menu is open yet, so every
   * window state has to say so.
   *
   * Only `busy` and `path` used to be seeded, and the window states are written nowhere but in
   * {@link onWindow} — so the eight lines, the menu name and the rows kept whatever the last
   * browsing session had painted, across restarts and for as long as nobody browsed again
   * (measured on a live receiver: rows from six days earlier next to a connection minutes old).
   * A visualisation or script reading them saw a menu that is not open. Same rule as the player
   * block's resting seeds in v2.0.1 — the browse block was simply missed then.
   */
  public seed(): void {
    this.deps.emit("player.browse.busy", false);
    // No menu is open, so no source is either — the last session's source stood there (D15).
    this.deps.emit("player.browse.source", null);
    this.deps.emit("player.browse.path", "");
    this.deps.emit("player.browse.menuName", "");
    this.deps.emit("player.browse.layer", 0);
    this.deps.emit("player.browse.totalItems", 0);
    this.deps.emit("player.browse.currentLine", 0);
    for (let line = 1; line <= BROWSE_LINES; line++) {
      this.deps.emit(`player.browse.line${line}`, "");
    }
    this.deps.emit("player.browse.rows", "[]");
  }

  /** Stop accepting operations (the controller is closing). */
  public close(): void {
    this.closed = true;
  }

  /**
   * Render a fresh window the driver reports (a fetch result or, on YNCA, an
   * unsolicited auto-feedback push).
   *
   * @param window the window snapshot
   */
  public onWindow(window: BrowseWindow): void {
    // A fetch that was already in flight when the connection closed must not paint stale
    // rows into a tree that is being torn down (the XML driver polls a busy menu for up
    // to twenty seconds).
    if (this.closed) {
      return;
    }
    this.window = window;
    this.windowVersion++;
    this.deps.emit("player.browse.menuName", window.menuName);
    this.deps.emit("player.browse.layer", window.layer);
    this.deps.emit("player.browse.totalItems", window.totalItems);
    this.deps.emit("player.browse.currentLine", window.currentLine);
    for (let line = 1; line <= BROWSE_LINES; line++) {
      const row = window.rows.find(r => r.line === line);
      this.deps.emit(`player.browse.line${line}`, row ? rowLabel(row) : "");
    }
    this.deps.emit("player.browse.rows", JSON.stringify(window.rows));
  }

  /**
   * Handle a user write to the on-screen remote (`remote.cursor`, `remote.menu`).
   *
   * Deliberately NOT through {@link start}: a remote key is a single press, not a menu
   * operation. `start` serialises and DROPS a second write while one is in flight, which on a
   * pad — where the user holds a direction — would swallow presses; and it would raise `busy`
   * on a surface nobody is browsing. Ordering and pacing on the wire are the command gate's
   * job, and it does that for every transport already.
   *
   * A word this device has no key for goes nowhere — and says so: a dead button leaves a trace (#615; review
   * 2026-10-05, A56).
   *
   * @param stateId the state id relative to the device (`remote.…`)
   * @param value the written value
   * @returns `sent` when the press is on its way, `unavailable` when this device has no such key
   */
  public handleRemoteWrite(stateId: string, value: unknown): WriteOutcome {
    if (this.closed) {
      return this.dropped(stateId, "the connection is closing");
    }
    const pad =
      stateId === "remote.cursor"
        ? { keys: this.driver.cursorValues, press: (key: string) => this.driver.cursor?.(key) }
        : stateId === "remote.menu"
          ? { keys: this.driver.menuValues, press: (key: string) => this.driver.menu?.(key) }
          : undefined;
    if (pad === undefined) {
      return this.dropped(stateId, "it is no key of the on-screen remote");
    }
    if (typeof value !== "string" || !pad.keys?.includes(value)) {
      return this.dropped(stateId, `${shown(value)} is not a key this device has (${pad.keys?.join(", ") || "none"})`);
    }
    void (async (): Promise<void> => {
      try {
        await pad.press(value);
      } catch (e) {
        this.deps.log.warn(`browse: ${stateId.slice("remote.".length)} ${value} failed: ${errText(e)}`);
      }
    })();
    return "sent";
  }

  /**
   * Handle a user write to one of the browse states. A value the menu cannot take is dropped with a line naming
   * the datapoint and the reason (review 2026-10-05, A56).
   *
   * @param stateId the state id relative to the device (`player.browse.…`)
   * @param value the written value
   * @returns `sent` when the operation started, `unavailable` for a value the menu cannot take, `unclear` while
   *   another menu operation runs (see {@link start})
   */
  public handleWrite(stateId: string, value: unknown): WriteOutcome {
    if (this.closed) {
      return this.dropped(stateId, "the connection is closing");
    }
    switch (stateId.slice("player.browse.".length)) {
      case "source": {
        const sources = this.driver.sources();
        if (typeof value !== "string" || !Object.hasOwn(sources, value)) {
          return this.dropped(
            stateId,
            `${shown(value)} is not a source this device browses (${Object.keys(sources).join(", ")})`,
          );
        }
        return this.start(`open ${value}`, async () => {
          await this.driver.open(value);
          this.deps.emit("player.browse.source", value);
        });
      }
      case "selectLine": {
        // The one slot gate of every protocol: a switch widget's `true` is no line 1 (audit 2026-09-29, D14), and
        // 2.5 is no line at all (review 2026-10-05, A26).
        const line = slotNumber(value, BROWSE_LINES);
        if (line === undefined) {
          return this.dropped(stateId, `${shown(value)} is no line of the window (1–${BROWSE_LINES})`);
        }
        return this.start(`select line ${line}`, () => this.driver.select(line));
      }
      case "playLine": {
        const play = this.driver.playContainer?.bind(this.driver);
        if (play === undefined) {
          return this.dropped(stateId, "this device cannot play a folder as a whole");
        }
        const line = slotNumber(value, BROWSE_LINES);
        if (line === undefined) {
          return this.dropped(stateId, `${shown(value)} is no line of the window (1–${BROWSE_LINES})`);
        }
        return this.start(`play line ${line}`, () => play(line));
      }
      case "pageUp":
        return this.start("page up", () => this.driver.pageUp());
      case "pageDown":
        return this.start("page down", () => this.driver.pageDown());
      case "back":
        return this.start("back", () => this.driver.back());
      case "home":
        return this.start("home", () => this.driver.home());
      case "path":
        if (typeof value !== "string" || pathSegments(value).length === 0) {
          return this.dropped(stateId, `${shown(value)} names no menu entry`);
        }
        return this.start(`path ${value}`, () => this.walkPath(value));
      default:
        return this.dropped(stateId, "it is no control of the menu");
    }
  }

  /**
   * Leave the trace of a write the menu does not carry out, and tell the handle this transport sent nothing.
   *
   * @param stateId the written datapoint
   * @param reason why it is not carried out
   * @returns `unavailable`
   */
  private dropped(stateId: string, reason: string): WriteOutcome {
    this.deps.log.debug(`${stateId} not written — ${reason}`);
    return "unavailable";
  }

  /**
   * Start one menu operation, serialized: while one runs, a further write is dropped (the busy state shows why) — and
   * reported `unclear`, so the handle does not hand it to another protocol: that protocol's menu is not the one on
   * screen, and the press would act there unseen.
   *
   * @param what the operation, for the log lines
   * @param op the operation
   * @returns `sent` when it started, `unclear` when another one still runs
   */
  private start(what: string, op: () => Promise<void> | void): WriteOutcome {
    if (this.running) {
      this.deps.log.debug(`browse: "${what}" dropped — another browse operation is still running`);
      return "unclear";
    }
    this.running = true;
    this.deps.emit("player.browse.busy", true);
    void this.run(what, op);
    return "sent";
  }

  /**
   * Run a started operation to its end. Failures land in the log as warnings — a user action failing must be visible.
   *
   * @param what the operation, for the log line
   * @param op the operation to run
   */
  private async run(what: string, op: () => Promise<void> | void): Promise<void> {
    try {
      await op();
    } catch (e) {
      this.deps.log.warn(`browse: ${what} failed: ${errText(e)}`);
    } finally {
      this.running = false;
      if (!this.closed) {
        this.deps.emit("player.browse.busy", false);
      }
    }
  }

  /**
   * Wait until the driver reports a window fresher than `sinceVersion` (or the step
   * timeout passes — menu levels are served by the device/catalog service and can be
   * slow, so this polls rather than racing).
   *
   * @param sinceVersion the window version before the operation
   * @returns true if a fresh window arrived, false on timeout
   */
  private async waitForWindow(sinceVersion: number): Promise<boolean> {
    const deadline = STEP_TIMEOUT_MS / WAIT_POLL_MS;
    for (let i = 0; i < deadline; i++) {
      if (this.closed) {
        return false;
      }
      if (this.windowVersion > sinceVersion) {
        return true;
      }
      await this.deps.delay(WAIT_POLL_MS);
    }
    return this.windowVersion > sinceVersion;
  }

  /**
   * Walk a `>`-separated path from the menu root, selecting each segment by its text
   * (searching the level page by page) — the one-write navigation for scripts and scenes.
   * The final segment behaves like any selection: a folder opens, a playable item starts.
   *
   * @param path the path, e.g. `Bookmarks>Radio Paradise`
   */
  private async walkPath(path: string): Promise<void> {
    const segments = pathSegments(path);
    const version = this.windowVersion;
    await this.driver.home();
    if (!(await this.waitForWindow(version))) {
      this.deps.log.warn(`browse: path "${path}" aborted — the menu root did not load`);
      return;
    }
    for (const [index, segment] of segments.entries()) {
      const found = await this.findAndSelect(segment);
      if ("failed" in found) {
        this.deps.log.warn(`browse: path "${path}" aborted — ${found.failed}`);
        return;
      }
      // Wait for the next level against the version from BEFORE the select: a pull driver (XML,
      // MusicCast) renders the new window inside select() itself, so a version read afterwards
      // waited 15 s for a window that had already come — per segment. After the last segment nothing
      // follows, and a playable one may not change the window at all (audit 2026-09-24, D3).
      // A level that does not load ends the walk: the next segment searched in the window still standing picked its
      // line in the PARENT menu — another entry than the one named (review 2026-10-05, A22).
      if (index < segments.length - 1 && !(await this.waitForWindow(found.before))) {
        this.deps.log.warn(`browse: path "${path}" aborted — "${segment}" did not open`);
        return;
      }
    }
  }

  /**
   * Find a row by its text in the current menu and select it — from the menu's FIRST page, paging forward to its
   * last.
   *
   * The pages are counted here. The search used to read `currentLine` as the window's first row, but on YNCA and XML
   * it is the cursor: a cursor on row 3 of a ten-entry menu ended the search on the first page ("not found" without a
   * single page turned), and a cursor on a later page hid every row above it, since the search only pages forward
   * (review 2026-10-05, A22).
   *
   * @param text the row text to find (without the symbol prefix)
   * @returns the window version from before the select, or why the search ended without one
   */
  private async findAndSelect(text: string): Promise<SegmentSearch> {
    const silent = { failed: `the menu stopped answering while "${text}" was searched` };
    if (!(await this.toFirstPage())) {
      return silent;
    }
    let page = this.window ? pageOf(this.window) : 1;
    for (let turned = 0; turned < MAX_SEARCH_PAGES; turned++) {
      const window = this.window;
      if (!window) {
        return silent;
      }
      const row = window.rows.find(r => r.text === text && r.kind !== "unselectable");
      if (row) {
        const before = this.windowVersion;
        await this.driver.select(row.line);
        return { before };
      }
      // The menu's last page: by the count of its entries — or a window shorter than a page, which is the tail even
      // where the device reports a total too high.
      if (page >= Math.ceil(window.totalItems / BROWSE_LINES) || window.rows.length < BROWSE_LINES) {
        break;
      }
      const version = this.windowVersion;
      await this.driver.pageDown();
      if (!(await this.waitForWindow(version))) {
        return silent;
      }
      page++;
    }
    return { failed: `"${text}" not found in this menu` };
  }

  /**
   * Turn back to the menu's first page before a search: after Home, and on YNCA and XML after a step back, the device
   * shows the page its cursor stands on — the row entered last (see {@link BrowseWindow.currentLine}).
   *
   * @returns false when there is no window or the menu stopped answering
   */
  private async toFirstPage(): Promise<boolean> {
    for (let turned = 0; turned < MAX_SEARCH_PAGES; turned++) {
      const window = this.window;
      if (!window) {
        return false;
      }
      if (pageOf(window) <= 1) {
        return true;
      }
      const version = this.windowVersion;
      await this.driver.pageUp();
      if (!(await this.waitForWindow(version))) {
        return false;
      }
      if (this.window && pageOf(this.window) >= pageOf(window)) {
        // The device did not turn back: search from here rather than ask again.
        return true;
      }
    }
    return true;
  }
}

import type { BrowseDriver, BrowseRow, BrowseWindow } from "./types";
import type { ControllerLog } from "../controller";
import { errorMessage } from "../util";

/** Poll interval while waiting for the device to deliver a fresh window. */
const WAIT_POLL_MS = 250;
/** How long one navigation step (select/page/back/home) may take before the walk aborts. */
const STEP_TIMEOUT_MS = 15000;
/** Hard page cap while searching one path segment, beyond the totalItems-derived bound. */
const MAX_SEARCH_PAGES = 32;

/** The adapter-bound callbacks the engine drives. */
export interface BrowseEngineDeps {
  /** Write a browse state (id relative to the device, e.g. `player.browse.line1`) with ack. */
  emit(id: string, value: boolean | number | string): void;
  /** Adapter log. */
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

  /** Seed the surface: the source dropdown exists via the objects; states start empty. */
  public seed(): void {
    this.deps.emit("player.browse.busy", false);
    this.deps.emit("player.browse.path", "");
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
    // to five seconds).
    if (this.closed) {
      return;
    }
    this.window = window;
    this.windowVersion++;
    this.deps.emit("player.browse.menuName", window.menuName);
    this.deps.emit("player.browse.layer", window.layer);
    this.deps.emit("player.browse.totalItems", window.totalItems);
    this.deps.emit("player.browse.currentLine", window.currentLine);
    for (let line = 1; line <= 8; line++) {
      const row = window.rows.find(r => r.line === line);
      this.deps.emit(`player.browse.line${line}`, row ? rowLabel(row) : "");
    }
    this.deps.emit("player.browse.rows", JSON.stringify(window.rows));
  }

  /**
   * Handle a user write to one of the browse states.
   *
   * @param stateId the state id relative to the device (`player.browse.…`)
   * @param value the written value
   */
  public handleWrite(stateId: string, value: unknown): void {
    const sub = stateId.slice("player.browse.".length);
    switch (sub) {
      case "source":
        if (typeof value === "string" && value in this.driver.sources()) {
          void this.run(`open ${value}`, async () => {
            await this.driver.open(value);
            this.deps.emit("player.browse.source", value);
          });
        }
        return;
      case "selectLine": {
        const line = Number(value);
        if (Number.isInteger(line) && line >= 1 && line <= 8) {
          void this.run(`select line ${line}`, () => this.driver.select(line));
        }
        return;
      }
      case "pageUp":
        void this.run("page up", () => this.driver.pageUp());
        return;
      case "pageDown":
        void this.run("page down", () => this.driver.pageDown());
        return;
      case "back":
        void this.run("back", () => this.driver.back());
        return;
      case "home":
        void this.run("home", () => this.driver.home());
        return;
      case "path":
        if (typeof value === "string" && value.trim().length > 0) {
          void this.run(`path ${value}`, () => this.walkPath(value));
        }
        return;
      default:
        return;
    }
  }

  /**
   * Run one operation, serialized: while one runs, further writes are dropped (the
   * busy state shows why). Failures land in the log as warnings — a user action
   * failing must be visible.
   *
   * @param what the operation, for the log line
   * @param op the operation to run
   */
  private async run(what: string, op: () => Promise<void> | void): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.running) {
      this.deps.log.debug(`browse: "${what}" dropped — another browse operation is still running`);
      return;
    }
    this.running = true;
    this.deps.emit("player.browse.busy", true);
    try {
      await op();
    } catch (e) {
      this.deps.log.warn(`browse: ${what} failed: ${errorMessage(e)}`);
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
   * (paging forward when it is not in the visible window) — the one-write navigation
   * for scripts and scenes. The final segment behaves like any selection: a folder
   * opens, a playable item starts.
   *
   * @param path the path, e.g. `Bookmarks>Radio Paradise`
   */
  private async walkPath(path: string): Promise<void> {
    const segments = path
      .split(">")
      .map(segment => segment.trim())
      .filter(segment => segment.length > 0);
    if (segments.length === 0) {
      return;
    }
    let version = this.windowVersion;
    await this.driver.home();
    if (!(await this.waitForWindow(version))) {
      this.deps.log.warn(`browse: path "${path}" aborted — the menu root did not load`);
      return;
    }
    for (const segment of segments) {
      if (!(await this.findAndSelect(segment))) {
        this.deps.log.warn(`browse: path "${path}" aborted — "${segment}" not found in this menu`);
        return;
      }
      version = this.windowVersion;
      // Give the device a chance to deliver the next level; a playable final segment
      // may not change the window at all, so a timeout here is not an error.
      await this.waitForWindow(version);
    }
  }

  /**
   * Find a row by its text in the current menu, paging forward as needed, and select it.
   *
   * @param text the row text to find (without the symbol prefix)
   * @returns true when the row was found and selected
   */
  private async findAndSelect(text: string): Promise<boolean> {
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const window = this.window;
      if (!window) {
        return false;
      }
      const row = window.rows.find(r => r.text === text && r.kind !== "unselectable");
      if (row) {
        await this.driver.select(row.line);
        return true;
      }
      // Stop at the last page: the window already shows the menu's tail.
      if (window.currentLine - 1 + window.rows.length >= window.totalItems) {
        return false;
      }
      const version = this.windowVersion;
      await this.driver.pageDown();
      if (!(await this.waitForWindow(version))) {
        return false;
      }
    }
    return false;
  }
}

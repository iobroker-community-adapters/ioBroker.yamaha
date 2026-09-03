"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var browse_engine_exports = {};
__export(browse_engine_exports, {
  BrowseEngine: () => BrowseEngine,
  rowLabel: () => rowLabel
});
module.exports = __toCommonJS(browse_engine_exports);
var import_util = require("../util");
const WAIT_POLL_MS = 250;
const STEP_TIMEOUT_MS = 15e3;
const MAX_SEARCH_PAGES = 32;
function rowLabel(row) {
  if (row.kind === "folder") {
    return `\u{1F4C1} ${row.text}`;
  }
  if (row.kind === "item") {
    return `\u266A ${row.text}`;
  }
  return row.text;
}
class BrowseEngine {
  /**
   * @param driver the transport's list operations
   * @param deps the adapter-bound callbacks
   */
  constructor(driver, deps) {
    this.driver = driver;
    this.deps = deps;
  }
  window;
  /** Bumped on every window report — the path walk waits on it. */
  windowVersion = 0;
  /** Serializes operations: a write while an operation runs is dropped with a log line. */
  running = false;
  closed = false;
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
  seed() {
    this.deps.emit("player.browse.busy", false);
    this.deps.emit("player.browse.path", "");
    this.deps.emit("player.browse.menuName", "");
    this.deps.emit("player.browse.layer", 0);
    this.deps.emit("player.browse.totalItems", 0);
    this.deps.emit("player.browse.currentLine", 0);
    for (let line = 1; line <= 8; line++) {
      this.deps.emit(`player.browse.line${line}`, "");
    }
    this.deps.emit("player.browse.rows", "[]");
  }
  /** Stop accepting operations (the controller is closing). */
  close() {
    this.closed = true;
  }
  /**
   * Render a fresh window the driver reports (a fetch result or, on YNCA, an
   * unsolicited auto-feedback push).
   *
   * @param window the window snapshot
   */
  onWindow(window) {
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
      const row = window.rows.find((r) => r.line === line);
      this.deps.emit(`player.browse.line${line}`, row ? rowLabel(row) : "");
    }
    this.deps.emit("player.browse.rows", JSON.stringify(window.rows));
  }
  /**
   * Handle a user write to the on-screen remote (`remote.cursor`, `remote.menu`).
   *
   * Deliberately NOT through {@link run}: a remote key is a single press, not a menu
   * operation. `run` serialises and DROPS a second write while one is in flight, which on a
   * pad — where the user holds a direction — would swallow presses; and it would raise `busy`
   * on a surface nobody is browsing. Ordering and pacing on the wire are the command gate's
   * job, and it does that for every transport already.
   *
   * @param stateId the state id relative to the device (`remote.…`)
   * @param value the written value
   */
  handleRemoteWrite(stateId, value) {
    var _a;
    if (this.closed || typeof value !== "string") {
      return;
    }
    const press = stateId === "remote.cursor" ? { what: `cursor ${value}`, key: this.driver.cursorValues, run: () => {
      var _a2, _b;
      return (_b = (_a2 = this.driver).cursor) == null ? void 0 : _b.call(_a2, value);
    } } : stateId === "remote.menu" ? { what: `menu ${value}`, key: this.driver.menuValues, run: () => {
      var _a2, _b;
      return (_b = (_a2 = this.driver).menu) == null ? void 0 : _b.call(_a2, value);
    } } : void 0;
    if (!((_a = press == null ? void 0 : press.key) == null ? void 0 : _a.includes(value))) {
      return;
    }
    void (async () => {
      try {
        await press.run();
      } catch (e) {
        this.deps.log.warn(`browse: ${press.what} failed: ${(0, import_util.errorMessage)(e)}`);
      }
    })();
  }
  /**
   * Handle a user write to one of the browse states.
   *
   * @param stateId the state id relative to the device (`player.browse.…`)
   * @param value the written value
   */
  handleWrite(stateId, value) {
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
  async run(what, op) {
    if (this.closed) {
      return;
    }
    if (this.running) {
      this.deps.log.debug(`browse: "${what}" dropped \u2014 another browse operation is still running`);
      return;
    }
    this.running = true;
    this.deps.emit("player.browse.busy", true);
    try {
      await op();
    } catch (e) {
      this.deps.log.warn(`browse: ${what} failed: ${(0, import_util.errorMessage)(e)}`);
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
  async waitForWindow(sinceVersion) {
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
  async walkPath(path) {
    const segments = path.split(">").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return;
    }
    let version = this.windowVersion;
    await this.driver.home();
    if (!await this.waitForWindow(version)) {
      this.deps.log.warn(`browse: path "${path}" aborted \u2014 the menu root did not load`);
      return;
    }
    for (const segment of segments) {
      if (!await this.findAndSelect(segment)) {
        this.deps.log.warn(`browse: path "${path}" aborted \u2014 "${segment}" not found in this menu`);
        return;
      }
      version = this.windowVersion;
      await this.waitForWindow(version);
    }
  }
  /**
   * Find a row by its text in the current menu, paging forward as needed, and select it.
   *
   * @param text the row text to find (without the symbol prefix)
   * @returns true when the row was found and selected
   */
  async findAndSelect(text) {
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const window = this.window;
      if (!window) {
        return false;
      }
      const row = window.rows.find((r) => r.text === text && r.kind !== "unselectable");
      if (row) {
        await this.driver.select(row.line);
        return true;
      }
      if (window.currentLine - 1 + window.rows.length >= window.totalItems) {
        return false;
      }
      const version = this.windowVersion;
      await this.driver.pageDown();
      if (!await this.waitForWindow(version)) {
        return false;
      }
    }
    return false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BrowseEngine,
  rowLabel
});
//# sourceMappingURL=browse-engine.js.map

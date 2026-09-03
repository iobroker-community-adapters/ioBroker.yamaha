"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ynca_browse_driver_exports = {};
__export(ynca_browse_driver_exports, {
  YNCA_BROWSE_SOURCES: () => YNCA_BROWSE_SOURCES,
  YncaBrowseDriver: () => YncaBrowseDriver,
});
module.exports = __toCommonJS(ynca_browse_driver_exports);
var import_types = require("./types");
const BURST_SETTLE_MS = 200;
const YNCA_BROWSE_SOURCES = [
  { subunit: "NETRADIO", key: "netRadio", label: "Net Radio", input: "NET RADIO" },
  { subunit: "SERVER", key: "server", label: "Media server", input: "SERVER" },
  { subunit: "PC", key: "pc", label: "PC", input: "PC" },
  { subunit: "USB", key: "usb", label: "USB", input: "USB" },
  { subunit: "IPOD", key: "ipod", label: "iPod", input: "iPod" },
  { subunit: "IPODUSB", key: "ipodUsb", label: "iPod (USB)", input: "iPod (USB)" },
  { subunit: "NAPSTER", key: "napster", label: "Napster", input: "Napster" },
  { subunit: "PANDORA", key: "pandora", label: "Pandora", input: "Pandora" },
  { subunit: "RHAP", key: "rhapsody", label: "Rhapsody", input: "Rhapsody" },
  { subunit: "SIRIUS", key: "sirius", label: "SiriusXM", input: "SIRIUS" },
];
class YncaBrowseDriver {
  /**
   * @param client the YNCA client slice (send + get)
   * @param present the browsable subunits this device reported in the AVAIL probe
   * @param delay adapter-managed delay
   */
  constructor(client, present, delay) {
    this.client = client;
    this.present = present;
    this.delay = delay;
  }
  active;
  engine;
  /** The window assembly the bursts fill. */
  menuName = "";
  layer = 0;
  totalItems = 0;
  currentLine = 1;
  texts = /* @__PURE__ */ new Map();
  kinds = /* @__PURE__ */ new Map();
  /** True while a settle delay is pending, so one burst renders once. */
  renderPending = false;
  /** True between asking for a window and the first field of the answer — see {@link refresh}. */
  awaitingWindow = false;
  closed = false;
  /**
   * Attach the engine that renders the windows (set after both are constructed).
   *
   * @param engine the browse engine
   */
  attach(engine) {
    this.engine = engine;
  }
  /** Stop rendering (the controller is closing). */
  close() {
    this.closed = true;
  }
  /** @returns the selectable sources this device offers (state value → label) */
  sources() {
    const entries = YNCA_BROWSE_SOURCES.filter(source => this.present.has(source.subunit));
    return Object.fromEntries(entries.map(source => [source.key, source.label]));
  }
  /**
   * Open a source's menu: switch the main-zone input to it (browsing follows the
   * active input, like the remote) and read the current window.
   *
   * @param source the source key (from {@link sources})
   */
  open(source) {
    const entry = YNCA_BROWSE_SOURCES.find(s => s.key === source && this.present.has(s.subunit));
    if (!entry) {
      return;
    }
    this.active = entry;
    this.resetAssembly();
    this.client.send("MAIN", "INP", entry.input);
    this.refresh();
  }
  /**
   * Select a visible line — `@<SUB>:LISTSEL=Line_n` acts like OK on that line.
   *
   * @param line the line number (1–8)
   */
  select(line) {
    this.command("LISTSEL", `Line_${line}`);
  }
  /** Show the previous 8 lines. */
  pageUp() {
    this.command("LISTPAGE", "Up");
  }
  /** Show the next 8 lines. */
  pageDown() {
    this.command("LISTPAGE", "Down");
  }
  /** Go one menu level back. */
  back() {
    this.command("LISTCURSOR", "Back");
  }
  /** Return to the menu root. */
  home() {
    this.command("LISTCURSOR", "Back to Home");
  }
  /** Re-read the current window (`LISTINFO=?` answers with the full field burst). */
  refresh() {
    if (this.active) {
      this.awaitingWindow = true;
      this.client.get(this.active.subunit, "LISTINFO");
    }
  }
  /**
   * Feed one received YNCA line. Lines of the active subunit's list functions update
   * the window assembly; anything else is ignored. Called by the controller for every
   * message, so unsolicited auto-feedback keeps the window live.
   *
   * @param message the decoded YNCA message
   * @param message.subunit the message's subunit
   * @param message.func the message's function name
   * @param message.value the message's raw wire value
   */
  handleMessage(message) {
    var _a;
    if (!this.active || message.subunit !== this.active.subunit) {
      return;
    }
    const isWindowField =
      /^LINE[1-8](TXT|ATRIB)$/.test(message.func) ||
      ["LISTLAYERNAME", "LISTLAYER", "MAXLINE", "CURRLINE"].includes(message.func);
    if (isWindowField && this.awaitingWindow) {
      this.awaitingWindow = false;
      this.resetAssembly();
    }
    const line = /^LINE([1-8])(TXT|ATRIB)$/.exec(message.func);
    if (line) {
      const n = Number(line[1]);
      if (line[2] === "TXT") {
        this.texts.set(n, message.value);
      } else {
        this.kinds.set(n, (_a = import_types.ROW_KIND_BY_ATTRIBUTE[message.value]) != null ? _a : "item");
      }
    } else if (message.func === "LISTLAYERNAME") {
      this.menuName = message.value;
    } else if (message.func === "LISTLAYER") {
      this.layer = Number(message.value) || 0;
    } else if (message.func === "MAXLINE") {
      this.totalItems = Number(message.value) || 0;
    } else if (message.func === "CURRLINE") {
      this.currentLine = Number(message.value) || 1;
    } else {
      return;
    }
    this.scheduleRender();
  }
  /**
   * Send a navigation command to the active subunit and read the window back.
   *
   * @param func the list function (LISTSEL, LISTPAGE, LISTCURSOR)
   * @param value the wire value
   */
  command(func, value) {
    if (!this.active) {
      return;
    }
    this.client.send(this.active.subunit, func, value);
    this.refresh();
  }
  /** Clear the window assembly — on a source switch, and when a freshly asked window starts arriving. */
  resetAssembly() {
    this.awaitingWindow = false;
    this.menuName = "";
    this.layer = 0;
    this.totalItems = 0;
    this.currentLine = 1;
    this.texts.clear();
    this.kinds.clear();
  }
  /** Render once the current burst has settled (avoids 8+ renders per LISTINFO answer). */
  scheduleRender() {
    if (this.renderPending) {
      return;
    }
    this.renderPending = true;
    void this.delay(BURST_SETTLE_MS).then(() => {
      this.renderPending = false;
      if (!this.closed) {
        this.render();
      }
    });
  }
  /** Assemble the window from the collected fields and hand it to the engine. */
  render() {
    var _a, _b, _c;
    const rows = [];
    for (let line = 1; line <= 8; line++) {
      const text = (_a = this.texts.get(line)) != null ? _a : "";
      if (text.length > 0) {
        rows.push({ line, text, kind: (_b = this.kinds.get(line)) != null ? _b : "item" });
      }
    }
    (_c = this.engine) == null
      ? void 0
      : _c.onWindow({
          menuName: this.menuName,
          layer: this.layer,
          totalItems: this.totalItems,
          currentLine: this.currentLine,
          rows,
        });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    YNCA_BROWSE_SOURCES,
    YncaBrowseDriver,
  });
//# sourceMappingURL=ynca-browse-driver.js.map

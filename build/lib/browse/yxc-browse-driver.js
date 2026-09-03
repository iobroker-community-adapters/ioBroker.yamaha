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
var yxc_browse_driver_exports = {};
__export(yxc_browse_driver_exports, {
  YXC_BROWSE_SOURCES: () => YXC_BROWSE_SOURCES,
  YxcBrowseDriver: () => YxcBrowseDriver
});
module.exports = __toCommonJS(yxc_browse_driver_exports);
const PAGE_SIZE = 8;
const MAX_HOME_STEPS = 16;
const YXC_BROWSE_SOURCES = [
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
  { input: "amazon_music", key: "amazonMusic", label: "Amazon Music" }
];
class YxcBrowseDriver {
  /**
   * @param client the YXC client slice (getListInfo + setListControl)
   * @param inputList the device's netusb input list (getFeatures `input_list`)
   */
  constructor(client, inputList) {
    this.client = client;
    this.inputList = inputList;
  }
  engine;
  active;
  /** The absolute (0-based) index of the window's first entry. */
  index = 0;
  /** The last window's rows, for the select semantics (folder vs playable). */
  rows = [];
  totalItems = 0;
  /**
   * Attach the engine that renders the windows (set after both are constructed).
   *
   * @param engine the browse engine
   */
  attach(engine) {
    this.engine = engine;
  }
  /** @returns the selectable sources this device offers (state value → label) */
  sources() {
    const entries = YXC_BROWSE_SOURCES.filter((source) => this.inputList.includes(source.input));
    return Object.fromEntries(entries.map((source) => [source.key, source.label]));
  }
  /**
   * Open a source's list at the device's current position in it.
   *
   * @param source the source key (from {@link sources})
   */
  async open(source) {
    const entry = YXC_BROWSE_SOURCES.find((s) => s.key === source && this.inputList.includes(s.input));
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
  async select(line) {
    const row = this.rows.find((r) => r.line === line);
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
  async pageUp() {
    this.index = Math.max(0, this.index - PAGE_SIZE);
    await this.fetch();
  }
  /** Show the next 8 lines. */
  async pageDown() {
    if (this.index + PAGE_SIZE < this.totalItems) {
      this.index += PAGE_SIZE;
    }
    await this.fetch();
  }
  /** Go one menu level back. */
  async back() {
    if (!this.active) {
      return;
    }
    await this.client.setListControl("return");
    this.index = 0;
    await this.fetch();
  }
  /** Return to the menu root: step back until the device reports layer 1. */
  async home() {
    if (!this.active) {
      return;
    }
    for (let step = 0; step < MAX_HOME_STEPS; step++) {
      const layer = await this.fetch();
      if (layer === void 0 || layer <= 1) {
        return;
      }
      await this.client.setListControl("return");
      this.index = 0;
    }
  }
  /**
   * Fetch the current window, render it to the engine, and report the menu layer.
   *
   * @returns the menu layer, or undefined when the source answered with an error
   */
  async fetch() {
    var _a;
    if (!this.active) {
      return void 0;
    }
    const response = await this.client.getListInfo(this.active.input, this.index);
    if (!response) {
      return void 0;
    }
    const entries = Array.isArray(response.list_info) ? response.list_info : [];
    this.rows = entries.slice(0, PAGE_SIZE).map((entry, i) => {
      const attribute = typeof entry.attribute === "number" ? entry.attribute : 0;
      const playable = (attribute & 4) !== 0;
      const selectable = (attribute & 2) !== 0;
      const row = {
        line: i + 1,
        text: typeof entry.text === "string" ? entry.text : "",
        kind: playable ? "item" : selectable ? "folder" : "unselectable"
      };
      if (typeof entry.thumbnail === "string" && entry.thumbnail.length > 0) {
        row.thumbnail = entry.thumbnail;
      }
      return row;
    });
    this.totalItems = typeof response.max_line === "number" ? response.max_line : this.rows.length;
    const layer = typeof response.menu_layer === "number" ? response.menu_layer : 0;
    (_a = this.engine) == null ? void 0 : _a.onWindow({
      menuName: typeof response.menu_name === "string" ? response.menu_name : "",
      layer,
      totalItems: this.totalItems,
      currentLine: this.index + 1,
      rows: this.rows
    });
    return layer;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YXC_BROWSE_SOURCES,
  YxcBrowseDriver
});
//# sourceMappingURL=yxc-browse-driver.js.map

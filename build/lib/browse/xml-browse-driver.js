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
var xml_browse_driver_exports = {};
__export(xml_browse_driver_exports, {
  XML_BROWSE_SOURCES: () => XML_BROWSE_SOURCES,
  XmlBrowseDriver: () => XmlBrowseDriver,
  parseXmlListInfo: () => parseXmlListInfo
});
module.exports = __toCommonJS(xml_browse_driver_exports);
var import_types = require("./types");
var import_entities = require("../xml/entities");
const BUSY_POLL_MS = 500;
const MAX_BUSY_POLLS = 10;
const XML_BROWSE_SOURCES = [
  { element: "NET_RADIO", key: "netRadio", label: "Net Radio", input: "NET RADIO" },
  { element: "SERVER", key: "server", label: "Media server", input: "SERVER" },
  { element: "USB", key: "usb", label: "USB", input: "USB" }
];
function parseXmlListInfo(xml) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i;
  const rows = [];
  const linePattern = /<Line_([1-8])>\s*<Txt>([^<]*)<\/Txt>\s*<Attribute>([^<]*)<\/Attribute>/g;
  for (let match = linePattern.exec(xml); match; match = linePattern.exec(xml)) {
    if (match[2].length > 0) {
      rows.push({
        line: Number(match[1]),
        text: (0, import_entities.decodeXmlText)(match[2]),
        kind: (_a = import_types.ROW_KIND_BY_ATTRIBUTE[match[3]]) != null ? _a : "item"
      });
    }
  }
  return {
    ready: !/<Menu_Status>Busy<\/Menu_Status>/.test(xml),
    menuName: (0, import_entities.decodeXmlText)((_c = (_b = /<Menu_Name>([^<]*)<\/Menu_Name>/.exec(xml)) == null ? void 0 : _b[1]) != null ? _c : ""),
    layer: Number((_e = (_d = /<Menu_Layer>(\d+)<\/Menu_Layer>/.exec(xml)) == null ? void 0 : _d[1]) != null ? _e : 0),
    currentLine: Number((_g = (_f = /<Current_Line>(\d+)<\/Current_Line>/.exec(xml)) == null ? void 0 : _f[1]) != null ? _g : 1),
    totalItems: Number((_i = (_h = /<Max_Line>(\d+)<\/Max_Line>/.exec(xml)) == null ? void 0 : _h[1]) != null ? _i : 0),
    rows
  };
}
class XmlBrowseDriver {
  /**
   * @param client the XML client slice (send + getXml)
   * @param available the source keys whose List_Info the start-up probe answered
   * @param delay adapter-managed delay
   */
  constructor(client, available, delay) {
    this.client = client;
    this.available = available;
    this.delay = delay;
  }
  engine;
  active;
  lastTotal = 0;
  /**
   * The cursor value this device accepts for "one level back". The spec vocabulary is
   * `Return`, but the 2012 generation (RX-V473 class) refuses it and accepts `Left`
   * instead (user-measured on the predecessor adapter, #613). First refusal switches
   * permanently for this device.
   */
  backCursor = "Return";
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
    const entries = XML_BROWSE_SOURCES.filter((source) => this.available.has(source.key));
    return Object.fromEntries(entries.map((source) => [source.key, source.label]));
  }
  /**
   * Open a source's menu: switch the main-zone input to it and read the window.
   *
   * @param source the source key (from {@link sources})
   */
  async open(source) {
    const entry = XML_BROWSE_SOURCES.find((s) => s.key === source && this.available.has(s.key));
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
  async select(line) {
    await this.control(`<Direct_Sel>Line_${line}</Direct_Sel>`);
  }
  /** Show the previous 8 lines (jump the cursor back a page). */
  async pageUp() {
    await this.jumpBy(-8);
  }
  /** Show the next 8 lines (jump the cursor forward a page). */
  async pageDown() {
    await this.jumpBy(8);
  }
  /** Go one menu level back — falling back to `Left` when the device refuses `Return`. */
  async back() {
    try {
      await this.send(`<Cursor>${this.backCursor}</Cursor>`);
    } catch (e) {
      if (this.backCursor !== "Return") {
        throw e;
      }
      this.backCursor = "Left";
      await this.send("<Cursor>Left</Cursor>");
    }
    await this.fetch();
  }
  /** Return to the menu root. */
  async home() {
    await this.control("<Cursor>Return to Home</Cursor>");
  }
  /**
   * Send a List_Control command to the active source — WITHOUT reading the window back,
   * so a caller can tell a device refusal from a failed follow-up read (see {@link back}).
   *
   * @param inner the List_Control payload (Direct_Sel, Cursor, Jump_Line)
   */
  async send(inner) {
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
  async control(inner) {
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
  async jumpBy(delta) {
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
  async fetch() {
    var _a;
    const window = await this.readWindow();
    if (window) {
      this.lastTotal = window.totalItems;
      (_a = this.engine) == null ? void 0 : _a.onWindow({
        menuName: window.menuName,
        layer: window.layer,
        totalItems: window.totalItems,
        currentLine: window.currentLine,
        rows: window.rows
      });
    }
  }
  /**
   * Read the active source's List_Info, polling while the device reports Busy.
   *
   * @returns the parsed window, or undefined without an active source / when busy persists
   */
  async readWindow() {
    if (!this.active) {
      return void 0;
    }
    for (let attempt = 0; attempt < MAX_BUSY_POLLS; attempt++) {
      const info = parseXmlListInfo(await this.client.getXml(this.active.element, "<List_Info>GetParam</List_Info>"));
      if (info.ready) {
        return info;
      }
      await this.delay(BUSY_POLL_MS);
    }
    return void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  XML_BROWSE_SOURCES,
  XmlBrowseDriver,
  parseXmlListInfo
});
//# sourceMappingURL=xml-browse-driver.js.map

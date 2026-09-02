import { BrowseEngine, rowLabel } from "./browse-engine";
import type { BrowseDriver, BrowseWindow } from "./types";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };
const instantDelay = (): Promise<void> => Promise.resolve();

/** A scriptable driver: every operation records itself and may push a window. */
class FakeDriver implements BrowseDriver {
  public calls: string[] = [];
  public engine: BrowseEngine | undefined;
  /** Windows to push on the next operations, keyed by the operation name. */
  public onOp: Record<string, BrowseWindow | undefined> = {};

  public sources(): Record<string, string> {
    return { netRadio: "Net Radio", usb: "USB" };
  }
  public open(source: string): void {
    this.record(`open:${source}`);
  }
  public select(line: number): void {
    this.record(`select:${line}`);
  }
  public pageUp(): void {
    this.record("pageUp");
  }
  public pageDown(): void {
    this.record("pageDown");
  }
  public back(): void {
    this.record("back");
  }
  public home(): void {
    this.record("home");
  }
  public refresh(): void {
    this.record("refresh");
  }
  private record(op: string): void {
    this.calls.push(op);
    const window = this.onOp[op.split(":")[0]];
    if (window) {
      this.engine?.onWindow(window);
    }
  }
}

function window(partial: Partial<BrowseWindow>): BrowseWindow {
  return { menuName: "", layer: 1, totalItems: 0, currentLine: 1, rows: [], ...partial };
}

function setup(): { engine: BrowseEngine; driver: FakeDriver; emitted: Array<{ id: string; value: unknown }> } {
  const driver = new FakeDriver();
  const emitted: Array<{ id: string; value: unknown }> = [];
  const engine = new BrowseEngine(driver, {
    emit: (id, value) => emitted.push({ id, value }),
    log: silentLog,
    delay: instantDelay,
  });
  driver.engine = engine;
  return { engine, driver, emitted };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe("rowLabel", () => {
  it("prefixes folders and items with their symbol, leaves the rest plain", () => {
    expect(rowLabel({ line: 1, text: "Bookmarks", kind: "folder" })).toBe("📁 Bookmarks");
    expect(rowLabel({ line: 2, text: "Radio Paradise", kind: "item" })).toBe("♪ Radio Paradise");
    expect(rowLabel({ line: 3, text: "— header —", kind: "unselectable" })).toBe("— header —");
    expect(rowLabel({ line: 4, text: "DRM track", kind: "unplayable" })).toBe("DRM track");
  });
});

describe("BrowseEngine", () => {
  it("seeds the whole surface into its resting form, not just busy and path", () => {
    // The window states are written nowhere but in onWindow. Seeded only partially, the last
    // session's menu stayed in the tree across restarts — a visualisation showed a menu that
    // was not open (measured live: rows six days older than the connection).
    const { engine, emitted } = setup();
    engine.seed();
    const byId = Object.fromEntries(emitted.map(e => [e.id, e.value]));
    expect(byId["player.browse.busy"]).toBe(false);
    expect(byId["player.browse.path"]).toBe("");
    expect(byId["player.browse.menuName"]).toBe("");
    expect(byId["player.browse.layer"]).toBe(0);
    expect(byId["player.browse.totalItems"]).toBe(0);
    expect(byId["player.browse.currentLine"]).toBe(0);
    expect(byId["player.browse.rows"]).toBe("[]");
    for (let line = 1; line <= 8; line++) {
      expect(byId[`player.browse.line${line}`]).toBe("");
    }
  });

  it("a seed after a rendered window clears the stale lines", () => {
    const { engine, emitted } = setup();
    engine.onWindow(
      window({ menuName: "Radio", totalItems: 10, rows: [{ line: 1, text: "Favorites", kind: "folder" }] }),
    );
    emitted.length = 0;
    engine.seed();
    const byId = Object.fromEntries(emitted.map(e => [e.id, e.value]));
    expect(byId["player.browse.line1"]).toBe("");
    expect(byId["player.browse.menuName"]).toBe("");
    expect(byId["player.browse.totalItems"]).toBe(0);
  });

  it("renders a window to the browse states, blanking unused lines", () => {
    const { engine, emitted } = setup();
    engine.onWindow(
      window({
        menuName: "NET RADIO",
        layer: 2,
        totalItems: 10,
        currentLine: 1,
        rows: [
          { line: 1, text: "Bookmarks", kind: "folder" },
          { line: 2, text: "Radio Paradise", kind: "item" },
        ],
      }),
    );
    const byId = Object.fromEntries(emitted.map(e => [e.id, e.value]));
    expect(byId["player.browse.menuName"]).toBe("NET RADIO");
    expect(byId["player.browse.layer"]).toBe(2);
    expect(byId["player.browse.totalItems"]).toBe(10);
    expect(byId["player.browse.currentLine"]).toBe(1);
    expect(byId["player.browse.line1"]).toBe("📁 Bookmarks");
    expect(byId["player.browse.line2"]).toBe("♪ Radio Paradise");
    expect(byId["player.browse.line3"]).toBe("");
    expect(byId["player.browse.line8"]).toBe("");
    expect(JSON.parse(byId["player.browse.rows"] as string)).toHaveLength(2);
  });

  it("routes the writes to the driver and validates the inputs", async () => {
    const { engine, driver } = setup();
    engine.handleWrite("player.browse.source", "netRadio");
    engine.handleWrite("player.browse.source", "spotify"); // not offered → ignored
    await flush();
    engine.handleWrite("player.browse.selectLine", 3);
    await flush();
    engine.handleWrite("player.browse.selectLine", 9); // out of window → ignored
    engine.handleWrite("player.browse.pageDown", true);
    await flush();
    engine.handleWrite("player.browse.back", true);
    await flush();
    engine.handleWrite("player.browse.home", true);
    await flush();
    expect(driver.calls).toEqual(["open:netRadio", "select:3", "pageDown", "back", "home"]);
  });

  it("acknowledges the source state after a successful open", async () => {
    const { engine, emitted } = setup();
    engine.handleWrite("player.browse.source", "usb");
    await flush();
    expect(emitted).toContainEqual({ id: "player.browse.source", value: "usb" });
  });

  it("walks a path segment by segment, selecting each by its text", async () => {
    const { engine, driver } = setup();
    driver.onOp.home = window({
      layer: 1,
      totalItems: 2,
      rows: [
        { line: 1, text: "Bookmarks", kind: "folder" },
        { line: 2, text: "Countries", kind: "folder" },
      ],
    });
    driver.onOp.select = window({
      layer: 2,
      totalItems: 1,
      rows: [{ line: 1, text: "Radio Paradise", kind: "item" }],
    });
    engine.handleWrite("player.browse.path", "Bookmarks>Radio Paradise");
    await flush();
    // After selecting "Bookmarks" the select-window becomes the level-2 menu, whose
    // line 1 is the final segment.
    expect(driver.calls).toEqual(["home", "select:1", "select:1"]);
  });

  it("pages forward while searching a segment and stops at the menu's tail", async () => {
    const { engine, driver } = setup();
    driver.onOp.home = window({
      layer: 1,
      totalItems: 10,
      currentLine: 1,
      rows: [{ line: 1, text: "A", kind: "folder" }],
    });
    driver.onOp.pageDown = window({
      layer: 1,
      totalItems: 10,
      currentLine: 9,
      rows: [{ line: 1, text: "Target", kind: "item" }],
    });
    engine.handleWrite("player.browse.path", "Target");
    await flush();
    expect(driver.calls).toEqual(["home", "pageDown", "select:1"]);
  });

  it("aborts a path whose segment is missing and warns", async () => {
    const warned: string[] = [];
    const driver = new FakeDriver();
    const engine = new BrowseEngine(driver, {
      emit: () => {},
      log: { ...silentLog, warn: message => warned.push(message) },
      delay: instantDelay,
    });
    driver.engine = engine;
    driver.onOp.home = window({ layer: 1, totalItems: 1, rows: [{ line: 1, text: "Other", kind: "folder" }] });
    engine.handleWrite("player.browse.path", "Missing");
    await flush();
    expect(driver.calls).toEqual(["home"]);
    expect(warned.some(message => message.includes('"Missing" not found'))).toBe(true);
  });

  it("drops a write while another operation runs", async () => {
    const { engine, driver } = setup();
    let release: () => void = () => {};
    driver.open = () =>
      new Promise<void>(resolve => {
        release = resolve;
      });
    engine.handleWrite("player.browse.source", "netRadio");
    engine.handleWrite("player.browse.back", true);
    release();
    await flush();
    expect(driver.calls).toEqual([]);
  });

  it("flags busy around an operation", async () => {
    const { engine, emitted } = setup();
    engine.handleWrite("player.browse.back", true);
    await flush();
    const busyValues = emitted.filter(e => e.id === "player.browse.busy").map(e => e.value);
    expect(busyValues).toEqual([true, false]);
  });
});

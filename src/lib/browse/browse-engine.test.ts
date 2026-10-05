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
  public readonly cursorValues = ["up", "left"];
  public cursor(value: string): void {
    this.record(`cursor:${value}`);
  }
  public readonly menuValues = ["menu"];
  public menu(value: string): void {
    this.record(`menu:${value}`);
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

function setup(): {
  engine: BrowseEngine;
  driver: FakeDriver;
  emitted: Array<{ id: string; value: unknown }>;
  debugged: string[];
  warned: string[];
} {
  const driver = new FakeDriver();
  const emitted: Array<{ id: string; value: unknown }> = [];
  const debugged: string[] = [];
  const warned: string[] = [];
  const engine = new BrowseEngine(driver, {
    emit: (id, value) => emitted.push({ id, value }),
    log: { ...silentLog, debug: message => debugged.push(message), warn: message => warned.push(message) },
    delay: instantDelay,
  });
  driver.engine = engine;
  return { engine, driver, emitted, debugged, warned };
}

/**
 * The rows of one menu page.
 *
 * @param texts the row texts, line 1 first
 * @returns the rows, folders
 */
function rowsOf(...texts: string[]): BrowseWindow["rows"] {
  return texts.map((text, i) => ({ line: i + 1, text, kind: "folder" as const }));
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
    // No source, not "" — a value outside the source list (audit 2026-09-24, D15; readable values 2026-09-30).
    expect(byId["player.browse.source"]).toBeNull();
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
    // A switch widget's `true` and a hex string are no line numbers (the one number gate; audit 2026-09-29, D14).
    engine.handleWrite("player.browse.selectLine", true);
    engine.handleWrite("player.browse.selectLine", "0x1");
    engine.handleWrite("player.browse.pageDown", true);
    await flush();
    engine.handleWrite("player.browse.back", true);
    await flush();
    engine.handleWrite("player.browse.home", true);
    await flush();
    expect(driver.calls).toEqual(["open:netRadio", "select:3", "pageDown", "back", "home"]);
  });

  it("a playLine write plays the folder on that line — only where the driver can", async () => {
    const { engine, driver } = setup();
    engine.handleWrite("player.browse.playLine", 2); // this driver cannot → nothing
    await flush();
    expect(driver.calls).toEqual([]);
    const played: number[] = [];
    Object.assign(driver, { playContainer: (line: number): void => void played.push(line) });
    engine.handleWrite("player.browse.playLine", 2);
    await flush();
    engine.handleWrite("player.browse.playLine", 9); // out of window → ignored
    await flush();
    expect(played).toEqual([2]);
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

  // A pull driver (XML, MusicCast) renders the next window inside select() — the walk read the version
  // afterwards and waited the full 15 s for a window that had already come, per segment (D3).
  it("a window rendered inside select costs no wait, and the last segment waits for nothing", async () => {
    const driver = new FakeDriver();
    const waited: number[] = [];
    const engine = new BrowseEngine(driver, {
      emit: () => {},
      log: silentLog,
      delay: ms => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    driver.engine = engine;
    driver.onOp.home = window({ layer: 1, totalItems: 1, rows: [{ line: 1, text: "Bookmarks", kind: "folder" }] });
    driver.onOp.select = window({ layer: 2, totalItems: 1, rows: [{ line: 1, text: "Radio Paradise", kind: "item" }] });
    engine.handleWrite("player.browse.path", "Bookmarks>Radio Paradise");
    await flush();
    expect(driver.calls).toEqual(["home", "select:1", "select:1"]);
    expect(waited.reduce((sum, ms) => sum + ms, 0)).toBe(0);
  });

  it("a window that arrives after select (a push driver, YNCA) is waited for — only that long", async () => {
    const driver = new FakeDriver();
    const waited: number[] = [];
    const level2 = window({ layer: 2, totalItems: 1, rows: [{ line: 1, text: "Radio Paradise", kind: "item" }] });
    let pending: BrowseWindow | undefined;
    const engine = new BrowseEngine(driver, {
      emit: () => {},
      log: silentLog,
      delay: ms => {
        waited.push(ms);
        if (pending) {
          engine.onWindow(pending);
          pending = undefined;
        }
        return Promise.resolve();
      },
    });
    driver.engine = engine;
    driver.onOp.home = window({ layer: 1, totalItems: 1, rows: [{ line: 1, text: "Bookmarks", kind: "folder" }] });
    driver.select = (line: number): void => {
      driver.calls.push(`select:${line}`);
      if (driver.calls.length === 2) {
        pending = level2;
      }
    };
    engine.handleWrite("player.browse.path", "Bookmarks>Radio Paradise");
    await flush();
    expect(driver.calls).toEqual(["home", "select:1", "select:1"]);
    expect(waited).toEqual([250]);
  });

  it("pages forward while searching a segment until the row appears", async () => {
    const { engine, driver } = setup();
    driver.onOp.home = window({
      layer: 1,
      totalItems: 10,
      currentLine: 1,
      // A page before the last is a full page — a shorter window is the menu's tail (A22).
      rows: rowsOf("A", "B", "C", "D", "E", "F", "G", "H"),
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

  it("drops a write while another operation runs — and keeps it from going to another protocol", async () => {
    const { engine, driver, debugged } = setup();
    let release: () => void = () => {};
    driver.open = () =>
      new Promise<void>(resolve => {
        release = resolve;
      });
    expect(engine.handleWrite("player.browse.source", "netRadio")).toBe("sent");
    // `unclear`, not `unavailable`: the handle would hand it to the next protocol, whose menu is not on screen.
    expect(engine.handleWrite("player.browse.back", true)).toBe("unclear");
    expect(debugged.some(line => line.includes('"back" dropped'))).toBe(true);
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

// Review 2026-10-05, A22: `currentLine` is the CURSOR on YNCA and XML, not the window's first row — the search
// stopped on the first page, searched only forward, and went on in the parent menu when a level did not load.
describe("BrowseEngine path search — counted pages from the first", () => {
  it("pages on although the cursor stands on row 3 of the first page", async () => {
    const { engine, driver, warned } = setup();
    // Ten entries, the window shows lines 1–8 with the cursor on row 3 (the row entered last).
    driver.onOp.home = window({ totalItems: 10, currentLine: 3, rows: rowsOf("A", "B", "C", "D", "E", "F", "G", "H") });
    driver.onOp.pageDown = window({
      totalItems: 10,
      currentLine: 9,
      rows: [
        { line: 1, text: "I", kind: "folder" },
        { line: 2, text: "Target", kind: "item" },
      ],
    });
    engine.handleWrite("player.browse.path", "Target");
    await flush();
    expect(driver.calls).toEqual(["home", "pageDown", "select:2"]);
    expect(warned).toEqual([]);
  });

  it("turns back to the first page when the cursor stands on a later one", async () => {
    const { engine, driver, warned } = setup();
    // After Home the device shows the page its cursor is on — page 2 of twenty entries.
    driver.onOp.home = window({
      totalItems: 20,
      currentLine: 11,
      rows: rowsOf("I", "J", "K", "L", "M", "N", "O", "P"),
    });
    driver.onOp.pageUp = window({
      totalItems: 20,
      currentLine: 1,
      rows: rowsOf("A", "B", "C", "D", "E", "F", "G", "H"),
    });
    engine.handleWrite("player.browse.path", "B");
    await flush();
    expect(driver.calls).toEqual(["home", "pageUp", "select:2"]);
    expect(warned).toEqual([]);
  });

  it("ends at the last page by the count of entries, also when that page is full", async () => {
    const { engine, driver, warned } = setup();
    driver.onOp.home = window({ totalItems: 16, currentLine: 1, rows: rowsOf("A", "B", "C", "D", "E", "F", "G", "H") });
    driver.onOp.pageDown = window({
      totalItems: 16,
      currentLine: 9,
      rows: rowsOf("I", "J", "K", "L", "M", "N", "O", "P"),
    });
    engine.handleWrite("player.browse.path", "Missing");
    await flush();
    expect(driver.calls).toEqual(["home", "pageDown"]);
    expect(warned.some(message => message.includes('"Missing" not found'))).toBe(true);
  });

  it("ends at a window shorter than a page, whatever total the device reports", async () => {
    const { engine, driver } = setup();
    driver.onOp.home = window({ totalItems: 40, currentLine: 1, rows: rowsOf("A", "B", "C", "D", "E", "F", "G", "H") });
    driver.onOp.pageDown = window({ totalItems: 40, currentLine: 9, rows: rowsOf("I", "J") });
    engine.handleWrite("player.browse.path", "Missing");
    await flush();
    expect(driver.calls).toEqual(["home", "pageDown"]);
  });

  it("aborts when a level does not load instead of searching the parent menu", async () => {
    const { engine, driver, warned } = setup();
    driver.onOp.home = window({
      totalItems: 2,
      rows: [
        { line: 1, text: "Bookmarks", kind: "folder" },
        { line: 2, text: "Radio Paradise", kind: "item" },
      ],
    });
    // select produces NO window (a slow catalog service) — the wait for the next level times out.
    engine.handleWrite("player.browse.path", "Bookmarks>Radio Paradise");
    for (let i = 0; i < 200; i++) {
      await flush();
    }
    // Line 2 of the ROOT is not the "Radio Paradise" of the Bookmarks level.
    expect(driver.calls).toEqual(["home", "select:1"]);
    expect(warned).toEqual(['browse: path "Bookmarks>Radio Paradise" aborted — "Bookmarks" did not open']);
  });

  it("aborts when a page does not load while searching", async () => {
    const { engine, driver, warned } = setup();
    driver.onOp.home = window({ totalItems: 20, currentLine: 1, rows: rowsOf("A", "B", "C", "D", "E", "F", "G", "H") });
    engine.handleWrite("player.browse.path", "Z");
    for (let i = 0; i < 200; i++) {
      await flush();
    }
    expect(driver.calls).toEqual(["home", "pageDown"]);
    expect(warned).toEqual(['browse: path "Z" aborted — the menu stopped answering while "Z" was searched']);
  });
});

// Review 2026-10-05, A56: a write the menu does not carry out leaves a trace naming the datapoint and the value, and
// every write returns a deliberate outcome — never a forgotten undefined.
describe("BrowseEngine — every write has an outcome, a dropped one a trace", () => {
  it("names the datapoint and the word a remote key this device lacks", async () => {
    const { engine, driver, debugged } = setup();
    expect(engine.handleRemoteWrite("remote.cursor", "right")).toBe("unavailable");
    expect(engine.handleRemoteWrite("remote.menu", 4)).toBe("unavailable");
    expect(engine.handleRemoteWrite("remote.something", "up")).toBe("unavailable");
    expect(engine.handleRemoteWrite("remote.cursor", "up")).toBe("sent");
    await flush();
    expect(driver.calls).toEqual(["cursor:up"]);
    expect(debugged).toEqual([
      'remote.cursor not written — "right" is not a key this device has (up, left)',
      "remote.menu not written — 4 is not a key this device has (menu)",
      "remote.something not written — it is no key of the on-screen remote",
    ]);
  });

  it("names the datapoint and the value of a browse write the menu cannot take", () => {
    const { engine, debugged } = setup();
    expect(engine.handleWrite("player.browse.source", "spotify")).toBe("unavailable");
    expect(engine.handleWrite("player.browse.selectLine", 9)).toBe("unavailable");
    expect(engine.handleWrite("player.browse.playLine", 2)).toBe("unavailable");
    expect(engine.handleWrite("player.browse.path", " > ")).toBe("unavailable");
    expect(engine.handleWrite("player.browse.nothing", true)).toBe("unavailable");
    expect(debugged).toEqual([
      'player.browse.source not written — "spotify" is not a source this device browses (netRadio, usb)',
      "player.browse.selectLine not written — 9 is no line of the window (1–8)",
      "player.browse.playLine not written — this device cannot play a folder as a whole",
      'player.browse.path not written — " > " names no menu entry',
      "player.browse.nothing not written — it is no control of the menu",
    ]);
  });

  it("takes an inherited property name for no source (A35)", async () => {
    const { engine, driver, emitted } = setup();
    expect(engine.handleWrite("player.browse.source", "constructor")).toBe("unavailable");
    expect(engine.handleWrite("player.browse.source", "toString")).toBe("unavailable");
    await flush();
    expect(driver.calls).toEqual([]);
    expect(emitted.some(entry => entry.id === "player.browse.source")).toBe(false);
  });

  it("takes a line through the one slot gate: 2.5, 0 and a switch's true are no line (A26)", () => {
    const { engine, driver } = setup();
    expect(engine.handleWrite("player.browse.selectLine", 2.5)).toBe("unavailable");
    expect(engine.handleWrite("player.browse.selectLine", 0)).toBe("unavailable");
    expect(engine.handleWrite("player.browse.selectLine", true)).toBe("unavailable");
    expect(engine.handleWrite("player.browse.selectLine", " 3 ")).toBe("sent");
    expect(driver.calls).toEqual(["select:3"]);
  });

  it("reports nothing sent once the connection closes", () => {
    const { engine, driver, debugged } = setup();
    engine.close();
    expect(engine.handleWrite("player.browse.back", true)).toBe("unavailable");
    expect(engine.handleRemoteWrite("remote.cursor", "up")).toBe("unavailable");
    expect(driver.calls).toEqual([]);
    expect(debugged).toEqual([
      "player.browse.back not written — the connection is closing",
      "remote.cursor not written — the connection is closing",
    ]);
  });
});

describe("BrowseEngine remote pad", () => {
  it("passes a key press to the driver", async () => {
    const { engine, driver } = setup();
    engine.handleRemoteWrite("remote.cursor", "left");
    engine.handleRemoteWrite("remote.menu", "menu");
    await flush();
    expect(driver.calls).toEqual(["cursor:left", "menu:menu"]);
  });

  it("drops a word this device does not have, and anything that is not a key", async () => {
    const { engine, driver } = setup();
    engine.handleRemoteWrite("remote.cursor", "right");
    engine.handleRemoteWrite("remote.menu", "option");
    engine.handleRemoteWrite("remote.cursor", 4);
    engine.handleRemoteWrite("remote.something", "up");
    await flush();
    expect(driver.calls).toEqual([]);
  });

  it("does not take the browse lock: a held direction key keeps going through", async () => {
    // `start()` serialises menu operations and DROPS the second one while the first is in
    // flight — on a pad that would swallow presses, and it would raise `busy` on a surface
    // nobody is browsing. Pacing on the wire is the command gate's job.
    const { engine, driver, emitted } = setup();
    engine.handleRemoteWrite("remote.cursor", "up");
    engine.handleRemoteWrite("remote.cursor", "up");
    engine.handleRemoteWrite("remote.cursor", "up");
    await flush();
    expect(driver.calls).toEqual(["cursor:up", "cursor:up", "cursor:up"]);
    expect(emitted.filter(e => e.id === "player.browse.busy")).toEqual([]);
  });

  it("sends nothing after close", async () => {
    const { engine, driver } = setup();
    engine.close();
    engine.handleRemoteWrite("remote.cursor", "up");
    await flush();
    expect(driver.calls).toEqual([]);
  });
});

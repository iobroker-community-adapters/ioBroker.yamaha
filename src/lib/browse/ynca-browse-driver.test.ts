import { YncaBrowseDriver } from "./ynca-browse-driver";
import type { BrowseEngine } from "./browse-engine";
import type { BrowseWindow } from "./types";

const instantDelay = (): Promise<void> => Promise.resolve();
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function setup(present: string[]): {
  driver: YncaBrowseDriver;
  sent: Array<{ subunit: string; func: string; value: string }>;
  gets: Array<{ subunit: string; func: string }>;
  windows: BrowseWindow[];
} {
  const sent: Array<{ subunit: string; func: string; value: string }> = [];
  const gets: Array<{ subunit: string; func: string }> = [];
  const driver = new YncaBrowseDriver(
    {
      send: (subunit, func, value) => sent.push({ subunit, func, value }),
      get: (subunit, func) => gets.push({ subunit, func }),
    },
    new Set(present),
    instantDelay,
  );
  // The driver only calls onWindow — a capture stub stands in for the engine.
  const windows: BrowseWindow[] = [];
  driver.attach({ onWindow: (window: BrowseWindow) => windows.push(window) } as unknown as BrowseEngine);
  return { driver, sent, gets, windows };
}

describe("YncaBrowseDriver", () => {
  it("offers only the browsable subunits the device reported", () => {
    const { driver } = setup(["NETRADIO", "USB", "SYS", "MAIN", "SPOTIFY"]);
    expect(driver.sources()).toEqual({ netRadio: "Net Radio", usb: "USB" });
  });

  it("opens a source by switching the input and reading LISTINFO", () => {
    const { driver, sent, gets } = setup(["NETRADIO"]);
    driver.open("netRadio");
    expect(sent).toEqual([{ subunit: "MAIN", func: "INP", value: "NET RADIO" }]);
    expect(gets).toEqual([{ subunit: "NETRADIO", func: "LISTINFO" }]);
  });

  it("puts the navigation commands on the wire and re-reads the window", () => {
    const { driver, sent, gets } = setup(["NETRADIO"]);
    driver.open("netRadio");
    sent.length = 0;
    gets.length = 0;
    driver.select(3);
    driver.pageDown();
    driver.pageUp();
    driver.back();
    driver.home();
    expect(sent).toEqual([
      { subunit: "NETRADIO", func: "LISTSEL", value: "Line_3" },
      { subunit: "NETRADIO", func: "LISTPAGE", value: "Down" },
      { subunit: "NETRADIO", func: "LISTPAGE", value: "Up" },
      { subunit: "NETRADIO", func: "LISTCURSOR", value: "Back" },
      { subunit: "NETRADIO", func: "LISTCURSOR", value: "Back to Home" },
    ]);
    expect(gets).toHaveLength(5);
  });

  it("assembles a LISTINFO burst into one window (RX-A810 shape)", async () => {
    const { driver, windows } = setup(["NETRADIO"]);
    driver.open("netRadio");
    for (const [func, value] of [
      ["LISTLAYER", "1"],
      ["LISTLAYERNAME", "NET RADIO"],
      ["CURRLINE", "1"],
      ["MAXLINE", "2"],
      ["LINE1TXT", "Radiobrowser"],
      ["LINE1ATRIB", "Container"],
      ["LINE2TXT", "Radio Paradise"],
      ["LINE2ATRIB", "Item"],
    ]) {
      driver.handleMessage({ subunit: "NETRADIO", func, value });
    }
    await flush();
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      menuName: "NET RADIO",
      layer: 1,
      totalItems: 2,
      currentLine: 1,
      rows: [
        { line: 1, text: "Radiobrowser", kind: "folder" },
        { line: 2, text: "Radio Paradise", kind: "item" },
      ],
    });
  });

  it("ignores lines of other subunits and non-list functions", async () => {
    const { driver, windows } = setup(["NETRADIO", "USB"]);
    driver.open("netRadio");
    driver.handleMessage({ subunit: "USB", func: "LINE1TXT", value: "elsewhere" });
    driver.handleMessage({ subunit: "NETRADIO", func: "PLAYBACKINFO", value: "Play" });
    await flush();
    expect(windows).toHaveLength(0);
  });
});

describe("YncaBrowseDriver window replacement", () => {
  it("a shorter next window does not keep the rows of the previous one", async () => {
    // Every reference device answers with all eight lines, empty ones included — so today
    // the assembly is overwritten wholesale. A firmware that sends only the filled lines
    // would otherwise leave the tail of the last window standing under a shorter menu.
    const windows: Array<{ rows: Array<{ line: number; text: string }> }> = [];
    const sent: Array<{ func: string; value: string }> = [];
    const driver = new YncaBrowseDriver(
      {
        send: (_s, func, value) => sent.push({ func, value }),
        get: () => {},
      },
      new Set(["NETRADIO"]),
      () => Promise.resolve(),
    );
    driver.attach({ onWindow: (w: { rows: Array<{ line: number; text: string }> }) => windows.push(w) } as never);
    driver.open("netRadio");
    for (const [n, text] of [
      [1, "One"],
      [2, "Two"],
      [3, "Three"],
    ] as Array<[number, string]>) {
      driver.handleMessage({ subunit: "NETRADIO", func: `LINE${n}TXT`, value: text });
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(windows.at(-1)?.rows.map(r => r.text)).toEqual(["One", "Two", "Three"]);

    // Enter a folder that holds a single entry — and the device reports only that one line.
    driver.select(1);
    driver.handleMessage({ subunit: "NETRADIO", func: "LINE1TXT", value: "Only" });
    await new Promise(resolve => setImmediate(resolve));
    expect(windows.at(-1)?.rows.map(r => r.text)).toEqual(["Only"]);
  });
});

describe("YncaBrowseDriver remote pad (#613)", () => {
  it("sends every cursor key to MAIN, in the wire words of the official command list", () => {
    const { driver, sent } = setup(["NETRADIO"]);
    driver.open("netRadio");
    sent.length = 0;
    for (const value of driver.cursorValues) {
      driver.cursor(value);
    }
    expect(driver.cursorValues).toEqual(["up", "down", "left", "right", "select", "return", "home"]);
    expect(sent).toEqual([
      { subunit: "MAIN", func: "LISTCURSOR", value: "Up" },
      { subunit: "MAIN", func: "LISTCURSOR", value: "Down" },
      { subunit: "MAIN", func: "LISTCURSOR", value: "Left" },
      { subunit: "MAIN", func: "LISTCURSOR", value: "Right" },
      { subunit: "MAIN", func: "LISTCURSOR", value: "Sel" },
      { subunit: "MAIN", func: "LISTCURSOR", value: "Back" },
      { subunit: "MAIN", func: "LISTCURSOR", value: "Back to Home" },
    ]);
  });

  it("addresses MAIN and not the open source — that is where Left and Right exist", () => {
    // `@MAIN:LISTCURSOR` declares all seven keys; the source subunits declare only
    // Up/Down/Sel/Back/Back to Home. A pad on the source would have no Left — which is
    // exactly the key the reporter's receiver needs (#613).
    const { driver, sent } = setup(["NETRADIO"]);
    driver.open("netRadio");
    sent.length = 0;
    driver.cursor("left");
    expect(sent).toEqual([{ subunit: "MAIN", func: "LISTCURSOR", value: "Left" }]);
  });

  it("works with no menu open — the pad drives the on-screen menu, not a list", () => {
    const { driver, sent } = setup(["NETRADIO"]);
    driver.cursor("up");
    driver.menu("on_screen");
    expect(sent).toEqual([
      { subunit: "MAIN", func: "LISTCURSOR", value: "Up" },
      { subunit: "MAIN", func: "LISTMENU", value: "On Screen" },
    ]);
  });

  it("offers only the menu keys this protocol has, and sends nothing for the others", () => {
    const { driver, sent } = setup(["NETRADIO"]);
    expect(driver.menuValues).toEqual(["on_screen", "top_menu", "menu", "option"]);
    driver.menu("display");
    driver.menu("home");
    driver.cursor("nonsense");
    expect(sent).toEqual([]);
  });

  it("sends nothing once the connection is closed", () => {
    const { driver, sent } = setup(["NETRADIO"]);
    driver.close();
    driver.cursor("up");
    expect(sent).toEqual([]);
  });
});

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

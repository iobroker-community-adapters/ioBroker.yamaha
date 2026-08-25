import { XmlBrowseDriver, parseXmlListInfo } from "./xml-browse-driver";
import type { BrowseEngine } from "./browse-engine";
import type { BrowseWindow } from "./types";

const instantDelay = (): Promise<void> => Promise.resolve();

/** A List_Info response body in the shape rxv reads (Menu_Status/Layer/Name + Current_List). */
function listBody(options: { busy?: boolean; layer?: number; name?: string; lines?: Array<[string, string]> }): string {
  const lines = (options.lines ?? [])
    .map(([text, attribute], i) => `<Line_${i + 1}><Txt>${text}</Txt><Attribute>${attribute}</Attribute></Line_${i + 1}>`)
    .join("");
  return (
    `<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><List_Info>` +
    `<Menu_Status>${options.busy ? "Busy" : "Ready"}</Menu_Status>` +
    `<Menu_Layer>${options.layer ?? 1}</Menu_Layer>` +
    `<Menu_Name>${options.name ?? "NET RADIO"}</Menu_Name>` +
    `<Current_List>${lines}</Current_List>` +
    `<Cursor_Position><Current_Line>1</Current_Line><Max_Line>${options.lines?.length ?? 0}</Max_Line></Cursor_Position>` +
    `</List_Info></NET_RADIO></YAMAHA_AV>`
  );
}

describe("parseXmlListInfo", () => {
  it("parses status, layer, name, cursor and the typed lines", () => {
    const info = parseXmlListInfo(
      listBody({
        layer: 2,
        name: "Bookmarks",
        lines: [
          ["Radio Paradise", "Item"],
          ["Countries", "Container"],
          ["— header —", "Unselectable"],
        ],
      }),
    );
    expect(info.ready).toBe(true);
    expect(info.layer).toBe(2);
    expect(info.menuName).toBe("Bookmarks");
    expect(info.totalItems).toBe(3);
    expect(info.rows).toEqual([
      { line: 1, text: "Radio Paradise", kind: "item" },
      { line: 2, text: "Countries", kind: "folder" },
      { line: 3, text: "— header —", kind: "unselectable" },
    ]);
  });

  it("reports a busy menu as not ready", () => {
    expect(parseXmlListInfo(listBody({ busy: true })).ready).toBe(false);
  });
});

function setup(bodies: string[]): {
  driver: XmlBrowseDriver;
  calls: Array<{ method: string; element: string; inner: string }>;
  windows: BrowseWindow[];
} {
  const calls: Array<{ method: string; element: string; inner: string }> = [];
  const driver = new XmlBrowseDriver(
    {
      send: (element, inner) => {
        calls.push({ method: "send", element, inner });
        return Promise.resolve();
      },
      getXml: (element, inner) => {
        calls.push({ method: "getXml", element, inner });
        return Promise.resolve(bodies.length > 1 ? (bodies.shift() as string) : bodies[0]);
      },
    },
    new Set(["netRadio", "server"]),
    instantDelay,
  );
  const windows: BrowseWindow[] = [];
  driver.attach({ onWindow: (window: BrowseWindow) => windows.push(window) } as unknown as BrowseEngine);
  return { driver, calls, windows };
}

describe("XmlBrowseDriver", () => {
  it("offers only the probed sources", () => {
    const { driver } = setup([listBody({})]);
    expect(driver.sources()).toEqual({ netRadio: "Net Radio", server: "Media server" });
  });

  it("opens a source by switching the input and reading its List_Info", async () => {
    const { driver, calls, windows } = setup([listBody({ lines: [["Bookmarks", "Container"]] })]);
    await driver.open("netRadio");
    expect(calls[0]).toEqual({
      method: "send",
      element: "Main_Zone",
      inner: "<Input><Input_Sel>NET RADIO</Input_Sel></Input>",
    });
    expect(calls[1]).toEqual({ method: "getXml", element: "NET_RADIO", inner: "<List_Info>GetParam</List_Info>" });
    expect(windows).toHaveLength(1);
    expect(windows[0].rows[0]).toEqual({ line: 1, text: "Bookmarks", kind: "folder" });
  });

  it("polls while the menu is busy and renders once it is ready", async () => {
    const { driver, windows } = setup([listBody({ busy: true }), listBody({ lines: [["Ready now", "Item"]] })]);
    await driver.open("netRadio");
    expect(windows).toHaveLength(1);
    expect(windows[0].rows[0].text).toBe("Ready now");
  });

  it("selects a line via Direct_Sel and navigates via Cursor", async () => {
    const { driver, calls } = setup([listBody({ lines: [["x", "Item"]] })]);
    await driver.open("netRadio");
    calls.length = 0;
    await driver.select(1);
    await driver.back();
    await driver.home();
    const sends = calls.filter(call => call.method === "send").map(call => call.inner);
    expect(sends).toEqual([
      "<List_Control><Direct_Sel>Line_1</Direct_Sel></List_Control>",
      "<List_Control><Cursor>Return</Cursor></List_Control>",
      "<List_Control><Cursor>Return to Home</Cursor></List_Control>",
    ]);
  });
});

import { YxcBrowseDriver } from "./yxc-browse-driver";
import type { BrowseEngine } from "./browse-engine";
import type { BrowseWindow } from "./types";

/**
 * A list_info response shaping helper.
 *
 * @param partial Fields that override the empty root list
 */
function listResponse(partial: Record<string, unknown>): Record<string, unknown> {
  return { response_code: 0, menu_layer: 1, menu_name: "Root", max_line: 0, list_info: [], ...partial };
}

function setup(inputs: string[]): {
  driver: YxcBrowseDriver;
  calls: Array<{ method: string; args: unknown[] }>;
  windows: BrowseWindow[];
  respond: (response: Record<string, unknown>) => void;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let response: Record<string, unknown> = listResponse({});
  const driver = new YxcBrowseDriver(
    {
      getListInfo: (input, index, size) => {
        calls.push({ method: "getListInfo", args: [input, index, size] });
        return Promise.resolve(response);
      },
      setListControl: (type, index, zone) => {
        calls.push({ method: "setListControl", args: [type, index, zone] });
        return Promise.resolve({ response_code: 0 });
      },
    },
    inputs,
  );
  const windows: BrowseWindow[] = [];
  driver.attach({ onWindow: (window: BrowseWindow) => windows.push(window) } as unknown as BrowseEngine);
  return { driver, calls, windows, respond: r => (response = r) };
}

describe("YxcBrowseDriver", () => {
  it("offers the browsable inputs the device actually has", () => {
    const { driver } = setup(["net_radio", "server", "tuner", "hdmi1", "qobuz"]);
    expect(driver.sources()).toEqual({ netRadio: "Net Radio", server: "Media server", qobuz: "Qobuz" });
  });

  it("renders a fetched window with the attribute bitmask decoded", async () => {
    const { driver, windows, respond } = setup(["net_radio"]);
    respond(
      listResponse({
        menu_name: "NET RADIO",
        menu_layer: 2,
        max_line: 3,
        list_info: [
          { text: "Bookmarks", attribute: 0b10 },
          { text: "Radio Paradise", attribute: 0b110, thumbnail: "http://x/y.jpg" },
          { text: "— header —", attribute: 0 },
        ],
      }),
    );
    await driver.open("netRadio");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      menuName: "NET RADIO",
      layer: 2,
      totalItems: 3,
      currentLine: 1,
      rows: [
        { line: 1, text: "Bookmarks", kind: "folder" },
        { line: 2, text: "Radio Paradise", kind: "item", thumbnail: "http://x/y.jpg" },
        { line: 3, text: "— header —", kind: "unselectable" },
      ],
    });
  });

  it("selects a folder with type=select and an item with type=play on the absolute index", async () => {
    const { driver, calls, respond } = setup(["net_radio"]);
    respond(
      listResponse({
        max_line: 20,
        list_info: [
          { text: "Folder", attribute: 0b10 },
          { text: "Song", attribute: 0b100 },
        ],
      }),
    );
    await driver.open("netRadio");
    await driver.pageDown(); // index 8 — selections below are absolute to it
    calls.length = 0;
    await driver.select(2);
    expect(calls[0]).toEqual({ method: "setListControl", args: ["play", 9, "main"] });
    calls.length = 0;
    await driver.select(1);
    expect(calls[0]).toEqual({ method: "setListControl", args: ["select", 8, undefined] });
  });

  it("pages by 8 within the menu bounds", async () => {
    const { driver, calls, respond } = setup(["net_radio"]);
    respond(listResponse({ max_line: 10 }));
    await driver.open("netRadio");
    calls.length = 0;
    await driver.pageDown();
    expect(calls[0].args).toEqual(["net_radio", 8, undefined]);
    calls.length = 0;
    await driver.pageDown(); // 16 ≥ 10 → stays
    expect(calls[0].args).toEqual(["net_radio", 8, undefined]);
    calls.length = 0;
    await driver.pageUp();
    expect(calls[0].args).toEqual(["net_radio", 0, undefined]);
  });

  it("returns to the root by stepping back until layer 1", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    // Each return moves one layer up: the fetches answer 3, then 2, then 1.
    let layer = 3;
    const driver = new YxcBrowseDriver(
      {
        getListInfo: (input, index) => {
          calls.push({ method: "getListInfo", args: [input, index] });
          return Promise.resolve(listResponse({ menu_layer: layer }));
        },
        setListControl: type => {
          calls.push({ method: "setListControl", args: [type] });
          layer -= 1;
          return Promise.resolve({ response_code: 0 });
        },
      },
      ["net_radio"],
    );
    driver.attach({ onWindow: (): void => {} } as unknown as BrowseEngine);
    await driver.open("netRadio");
    calls.length = 0;
    await driver.home();
    expect(calls.filter(call => call.method === "setListControl").map(call => call.args)).toEqual([
      ["return"],
      ["return"],
    ]);
  });
});

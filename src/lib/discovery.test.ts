import { parseYamahaDescription, discoverYamaha } from "./discovery";

const silentLog = { debug: (): void => {}, warn: (): void => {} };

describe("parseYamahaDescription", () => {
  test("returns the friendly name for a Yamaha device description", () => {
    const xml =
      "<root><device><manufacturer>Yamaha Corporation</manufacturer><friendlyName>RX-V685</friendlyName></device></root>";
    expect(parseYamahaDescription(xml)).toEqual({ name: "RX-V685" });
  });

  test("returns undefined for a non-Yamaha device", () => {
    expect(parseYamahaDescription("<manufacturer>Sonos, Inc.</manufacturer>")).toBeUndefined();
  });

  test("returns an empty name for a Yamaha device without a friendlyName", () => {
    expect(parseYamahaDescription("<manufacturer>YAMAHA</manufacturer>")).toEqual({ name: "" });
  });
});

describe("discoverYamaha", () => {
  test("returns Yamaha devices, skipping non-Yamaha and duplicate addresses", async () => {
    const devices = await discoverYamaha({
      search: () =>
        Promise.resolve([
          { location: "http://1.1.1.1:49154/desc.xml", address: "1.1.1.1" },
          { location: "http://2.2.2.2:49154/desc.xml", address: "2.2.2.2" },
          { location: "http://1.1.1.1:49154/desc.xml", address: "1.1.1.1" },
        ]),
      fetch: url =>
        Promise.resolve(
          url.includes("1.1.1.1")
            ? "<manufacturer>Yamaha Corporation</manufacturer><friendlyName>RX-V685</friendlyName>"
            : "<manufacturer>Sonos</manufacturer>",
        ),
      log: silentLog,
    });
    expect(devices).toEqual([{ ip: "1.1.1.1", name: "RX-V685" }]);
  });

  test("swallows a fetch error for one device without failing the scan", async () => {
    const devices = await discoverYamaha({
      search: () =>
        Promise.resolve([
          { location: "http://1.1.1.1/d.xml", address: "1.1.1.1" },
          { location: "http://2.2.2.2/d.xml", address: "2.2.2.2" },
        ]),
      fetch: url => {
        if (url.includes("1.1.1.1")) {
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve("<manufacturer>Yamaha</manufacturer><friendlyName>WX-10</friendlyName>");
      },
      log: silentLog,
    });
    expect(devices).toEqual([{ ip: "2.2.2.2", name: "WX-10" }]);
  });
});

import { parseYamahaDescription, discoverYamaha, probeDescription } from "./discovery";

const silentLog = { debug: (): void => {}, warn: (): void => {} };

/** The short fixtures advertise no Yamaha control service at all. */
const NO_SERVICES = { services: { yxc: false, xml: false } };

/** The RX-V6A's real description (2026-09-01 capture), reduced to the fields the parser reads. */
const V6A =
  '<root xmlns:yamaha="urn:schemas-yamaha-com:device-1-0"><device><friendlyName>Yamaha RX-V6a</friendlyName>' +
  "<manufacturer>Yamaha Corporation</manufacturer><modelName>RX-V6A</modelName><serialNumber>057CCF73</serialNumber>" +
  "<UDN>uuid:9ab0c000-f668-11de-9976-ccd42ecf0223</UDN></device><yamaha:X_device><yamaha:X_serviceList>" +
  "<yamaha:X_service><yamaha:X_specType>urn:schemas-yamaha-com:service:X_YamahaRemoteControl:1</yamaha:X_specType></yamaha:X_service>" +
  "<yamaha:X_service><yamaha:X_specType>urn:schemas-yamaha-com:service:X_YamahaExtendedControl:1</yamaha:X_specType></yamaha:X_service>" +
  "</yamaha:X_serviceList></yamaha:X_device></root>";

describe("parseYamahaDescription", () => {
  test("returns the friendly name for a Yamaha device description", () => {
    const xml =
      "<root><device><manufacturer>Yamaha Corporation</manufacturer><friendlyName>RX-V685</friendlyName></device></root>";
    expect(parseYamahaDescription(xml)).toEqual({ name: "RX-V685", ...NO_SERVICES });
  });

  test("returns undefined for a non-Yamaha device", () => {
    expect(parseYamahaDescription("<manufacturer>Sonos, Inc.</manufacturer>")).toBeUndefined();
  });

  test("returns an empty name for a Yamaha device without a friendlyName", () => {
    expect(parseYamahaDescription("<manufacturer>YAMAHA</manufacturer>")).toEqual({ name: "", ...NO_SERVICES });
  });

  test("keeps model, identity and the advertised services", () => {
    // Serial and MAC are what the device carries for life; the service list says which of the
    // two HTTP protocols it speaks (YNCA is never listed — it is always tried).
    expect(parseYamahaDescription(V6A)).toEqual({
      name: "Yamaha RX-V6a",
      model: "RX-V6A",
      identity: { serial: "057CCF73", mac: "CCD42ECF0223" },
      services: { yxc: true, xml: true },
    });
  });

  test("a scrubbed serial and a placeholder UDN yield no identity", () => {
    const xml =
      "<root><device><manufacturer>Yamaha Corporation</manufacturer><friendlyName>X</friendlyName>" +
      "<serialNumber>00000000</serialNumber><UDN>uuid:RXV6A0000</UDN></device></root>";
    expect(parseYamahaDescription(xml)?.identity).toBeUndefined();
  });
});

describe("probeDescription", () => {
  test("fetches one responder and keeps it when it is a Yamaha device", async () => {
    const found = await probeDescription(
      { fetch: () => Promise.resolve(V6A), log: silentLog },
      "http://1.1.1.1/d.xml",
      "1.1.1.1",
    );
    expect(found).toMatchObject({ ip: "1.1.1.1", name: "Yamaha RX-V6a", identity: { serial: "057CCF73" } });
  });

  // A stranger is FINAL (null — the full NOTIFY throttle), an unreadable description is worth asking
  // again (undefined — a receiver announces itself before its HTTP server answers). Both used to be
  // undefined, so every television was re-probed every five seconds (audit 2026-09-24, A7).
  test("is null for a stranger and undefined for a failed fetch", async () => {
    await expect(
      probeDescription(
        { fetch: () => Promise.resolve("<manufacturer>Sonos</manufacturer>"), log: silentLog },
        "http://1.1.1.1/d.xml",
        "1.1.1.1",
      ),
    ).resolves.toBeNull();
    await expect(
      probeDescription(
        { fetch: () => Promise.reject(new Error("offline")), log: silentLog },
        "http://1.1.1.1/d.xml",
        "1.1.1.1",
      ),
    ).resolves.toBeUndefined();
  });

  // The description has to come from the sender: a LOCATION on another host would hand a known
  // device's name and identity to this address (audit 2026-09-24, A13).
  test("does not take a description whose LOCATION host is not the sender", async () => {
    let fetched = false;
    const fetch = (): Promise<string> => {
      fetched = true;
      return Promise.resolve(V6A);
    };
    await expect(probeDescription({ fetch, log: silentLog }, "http://10.0.0.5/d.xml", "1.1.1.1")).resolves.toBeNull();
    await expect(probeDescription({ fetch, log: silentLog }, "not a url", "1.1.1.1")).resolves.toBeNull();
    expect(fetched).toBe(false);
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
    expect(devices).toEqual([{ ip: "1.1.1.1", name: "RX-V685", ...NO_SERVICES }]);
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
    expect(devices).toEqual([{ ip: "2.2.2.2", name: "WX-10", ...NO_SERVICES }]);
  });
});

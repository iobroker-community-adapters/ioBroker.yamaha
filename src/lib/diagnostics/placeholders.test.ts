import { describe, expect, it } from "vitest";
import { Placeholders, leaked } from "./placeholders";

describe("Placeholders", () => {
  it("gives the same value the same placeholder, in any case, and counts per kind", () => {
    const p = new Placeholders();
    expect(p.mark("address", "10.0.0.5")).toBe("address-1");
    expect(p.mark("address", "10.0.0.6")).toBe("address-2");
    expect(p.mark("address", "10.0.0.5")).toBe("address-1");
    expect(p.mark("serial", "10.0.0.5")).toBe("serial-1");
    expect(p.mark("mac", "AA:BB:CC:00:11:22")).toBe(p.mark("mac", "aa:bb:cc:00:11:22"));
  });

  it("finds addresses, hardware ids and mail addresses by their form", () => {
    const p = new Placeholders();
    expect(p.text("from 192.168.1.20 to 192.168.1.20 and fe80:0:0:0:1:2:3:4")).toBe(
      "from address-2 to address-2 and address-1",
    );
    expect(p.text("mac 00:1A:2b:3C:4d:5E or 00-1A-2B-3C-4D-5F, same as 00:1a:2b:3c:4d:5f")).toBe(
      "mac mac-1 or mac-2, same as mac-2",
    );
    expect(p.text("mail jane.doe+x@example.co.uk")).toBe("mail mail-1");
  });

  it("finds a shortened IPv6 address, an address at the end of a sentence and an eight-byte id", () => {
    const p = new Placeholders();
    expect(p.text("link fe80::1a2b:3c4d, mapped ::ffff:192.168.1.7 and 2001:db8::1.")).toBe(
      "link address-1, mapped address-2 and address-3.",
    );
    expect(p.text("It answered from 192.168.1.20.")).toBe("It answered from address-4.");
    expect(p.text("host:fe80::9 and [2001:db8::2]:8080")).toBe("host:address-5 and [address-6]:8080");
    expect(p.text("device 12:34:56:78:9A:BC:DE:F0 and 12-34-56-78-9a-bc-de-f0")).toBe("device mac-1 and mac-1");
    expect(p.text("mac AC44F2A1B2C3 and ac44f2a1b2c3")).toBe("mac mac-2 and mac-2");
  });

  it("leaves numbers, times and code alone that only look like an address", () => {
    const p = new Placeholders();
    const same = [
      "version 3.3.0.1.2 and 256.1.1.1 and 1.2.3",
      "at 2026-10-06T15:33:41.123Z, 15:33:41 and 12:30",
      "Class::method, Foo::Bar and ::",
      "hash deadbeefcafe0123456789, number 123456789012 and word facadefacade",
    ];
    for (const text of same) {
      expect(p.text(text)).toBe(text);
    }
  });

  it("reads a long text in linear time", () => {
    const p = new Placeholders();
    const started = Date.now();
    p.text(`${"a".repeat(200_000)} ${":".repeat(200_000)}a ${"1.".repeat(100_000)}x ${"1:".repeat(100_000)}x`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("replaces a registered name as written or in its lower-case id form, longest first", () => {
    const p = new Placeholders();
    expect(p.name("Living Room")).toBe("name-1");
    expect(p.name("Living")).toBe("name-2");
    expect(p.name("Home WiFi", "network")).toBe("network-1");
    expect(p.text("Living Room lamp, Living area, LivingRoom, Home WiFi")).toBe(
      "name-1 lamp, name-2 area, LivingRoom, network-1",
    );
    expect(p.text("demo.0.living_room.power, living-room, living room, LIVING ROOM, home_wifi_5g")).toBe(
      "demo.0.name-1.power, name-1, name-1, LIVING ROOM, network-1_5g",
    );
  });

  it("leaves a protocol token alone that only contains a name the user took from a protocol word", () => {
    // yamaha 2026-10-07: an input named "Radio" turned `net_radio` and `NET RADIO` into `net_name-1` / `NET name-1`
    const p = new Placeholders();
    p.name("Radio");
    expect(p.deep({ net_radio: { input: "net_radio" }, "MAIN:INP": "NET RADIO" })).toEqual({
      net_radio: { input: "net_radio" },
      "MAIN:INP": "NET RADIO",
    });
    expect(p.text("input Radio, net-radio, radio_station, radio-tuner, RADIO, demo.0.radio.power")).toBe(
      "input name-1, net-radio, radio_station, radio-tuner, RADIO, demo.0.name-1.power",
    );
  });

  it("replaces a value of any other kind wherever it stands, in any case", () => {
    // yamaha 2026-10-07 (security review of 27b0ac6): a serial or a network name inside a longer token stayed readable
    const p = new Placeholders();
    expect(p.name("ABC123", "serial")).toBe("serial-1");
    expect(p.name("Home WiFi", "network")).toBe("network-1");
    expect(p.text("host rx-v6a-ABC123, id rx-v6a-abc123x, WLAN home_wifi_5G, HOME WIFI")).toBe(
      "host rx-v6a-serial-1, id rx-v6a-serial-1x, WLAN network-1_5G, network-1",
    );
  });

  it("ignores a blank name", () => {
    const p = new Placeholders();
    expect(p.name("  ")).toBe("  ");
    expect(p.text("  ")).toBe("  ");
  });

  it("replaces in every string of a value and in every key", () => {
    const p = new Placeholders();
    p.name("Kitchen");
    expect(p.deep({ "10.0.0.1": ["Kitchen", 3, null, { ip: "10.0.0.1" }], kitchen: true, on: true })).toEqual({
      "address-1": ["name-1", 3, null, { ip: "address-1" }],
      "name-1": true,
      on: true,
    });
  });
});

describe("Placeholders.deep with keys that meet", () => {
  it("keeps both values when two keys become the same placeholder", () => {
    const p = new Placeholders();
    p.name("Living Room");
    expect(p.deep({ "Living Room": 1, living_room: 2, "living-room": 3, LIVINGROOM: 4 })).toEqual({
      "name-1": 1,
      "name-1#2": 2,
      "name-1#3": 3,
      LIVINGROOM: 4,
    });
  });
});

describe("leaked", () => {
  it("names every real value that still stands in the report, in the spellings the replacement covers", () => {
    expect(leaked('{"ip":"address-1","name":"demo.0.kitchen"}', ["10.0.0.1", "Kitchen", " "], "name")).toEqual([
      "Kitchen",
    ]);
    expect(leaked('{"input":"NET RADIO","id":"net_radio"}', ["Radio"], "name")).toEqual([]);
    expect(leaked('{"ip":"10.0.0.10"}', ["10.0.0.1"], "name")).toEqual([]);
    expect(leaked('{"host":"rx-v6a-abc123"}', ["ABC123"], "serial")).toEqual(["ABC123"]);
    expect(leaked('{"host":"rx-v6a-abc123"}', ["ABC123"], "name")).toEqual([]);
  });
});

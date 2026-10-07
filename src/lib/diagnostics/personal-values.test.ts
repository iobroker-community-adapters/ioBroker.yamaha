import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blankSecrets, PersonalValues } from "./personal-values";
import { leaked, Placeholders } from "./placeholders";

/**
 * A report through the master's order: blank the secrets, register what is personal, replace.
 *
 * @param report the report
 * @param teach values registered before the collector runs
 * @returns the report text with placeholders
 */
function scrub(report: unknown, teach?: (p: PersonalValues) => void): string {
  const blanked = blankSecrets(report);
  const places = new Placeholders();
  const personal = new PersonalValues(places);
  teach?.(personal);
  personal.learn(blanked);
  return JSON.stringify(places.deep(blanked));
}

describe("PersonalValues", () => {
  // The fleet standard (Placeholders, round 97): every address gets a stable placeholder by its form.
  it("replaces addresses with stable placeholders", () => {
    const out = scrub({ a: "192.168.178.26", b: "at 192.168.178.26 and 8.8.8.8" });
    expect(out).not.toContain("192.168.178.26");
    expect(out).toContain('"a":"address-1"');
    expect(out).toContain("at address-1 and address-2");
  });

  it("removes the MusicCast network names, serials and MACs (a real getNetworkStatus/getDeviceInfo)", () => {
    const report = {
      "system/getNetworkStatus": {
        network_name: "Badezimmer",
        wireless_lan: { ssid: "shootingrange 4", key: "secret" },
        mac_address: { wired_lan: "00A0DED4F504", wireless_lan: "987BF3C4C670" },
      },
      "system/getDeviceInfo": { device_id: "00A0DED4F504", system_id: "0E897553" },
      "system/getNameText": { zone_list: [{ id: "main", text: "Badezimmer" }] },
      "system/getLocationInfo": { id: "22ae17939af24b0b9fd95b14ea726ba5", name: "Home of Max" },
      state: "zone Badezimmer is on",
    };
    const out = scrub(report);
    for (const secret of [
      "Badezimmer",
      "shootingrange",
      "secret",
      "00A0DED4F504",
      "987BF3C4C670",
      "0E897553",
      "22ae1793",
      "Max",
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toMatch(/serial-\d/);
    expect(out).toContain('"key":"***"');
  });

  it("finds the serial, MACs and zone names inside raw XML bodies and YNCA lines", () => {
    const report = {
      xml: "<System_ID>0A1B2C3D</System_ID><MAC_Address><Wired_LAN>001122334455</Wired_LAN></MAC_Address>",
      zone: "<Config><Name><Zone>Kinderzimmer</Zone></Name></Config>",
      ynca: { "ZONE2:ZONENAME": "Kueche" },
      lines: ["@ZONE2:ZONENAME=Kueche", "@MAIN:ZONENAME=Main Zone"],
    };
    const out = scrub(report);
    for (const secret of ["0A1B2C3D", "001122334455", "Kinderzimmer", "Kueche"]) {
      expect(out, secret).not.toContain(secret);
    }
    // The factory zone name is not personal and stays readable.
    expect(out).toContain("Main Zone");
  });

  // krobi 2026-10-06 ("Ja, ersetzen"): the names the user gave the inputs are replaced like the zone names; a factory
  // name stays readable — it only says which input it is. The names are the RX-V6A's own, read on the server.
  it("replaces the input names the user gave, on every protocol, and keeps the factory names", () => {
    const report = {
      ynca: { "SYS:INPNAMEHDMI1": "Apple TV", "SYS:INPNAMEUSB": "USB", "SYS:INPNAMEMCLINK": "MusicCast Link" },
      lines: ["@SYS:INPNAMEHDMI2=Xbox Series X", "@SYS:INPNAMEAUDIO1=AUDIO1"],
      profile: {
        subunits: { SYS: { INPNAMEHDMI3: "Playstation 5" } },
        inputNames: { HDMI_6: "Dreamcast", TUNER: "TUNER" },
      },
      "system/getNameText": {
        input_list: [
          { id: "hdmi7", text: "Retro PC" },
          { id: "net_radio", text: "NET RADIO" },
          { id: "mc_link", text: "MusicCast Link" },
        ],
      },
      xml:
        "<Input_Sel_Item><Item_1><Param>HDMI4</Param><RW>RW</RW><Title>Playstation 3</Title></Item_1>" +
        "<Item_2><Param>AUDIO2</Param><RW>R</RW><Title>AUDIO2</Title></Item_2>" +
        "<Item_3><Param>Main Zone Sync</Param><RW>RW</RW><Title>Main Zone Sync</Title></Item_3></Input_Sel_Item>",
      scenes: "<Scene_Sel_Item><Item_1><Param>Scene 1</Param><Title>Movie Viewing</Title></Item_1></Scene_Sel_Item>",
      objectTree: [{ id: "multiroom.zone2.input", states: { HDMI5: "Xbox 360", PHONO: "PHONO" } }],
    };
    const out = scrub(report);
    for (const name of [
      "Apple TV",
      "Xbox Series X",
      "Playstation 5",
      "Playstation 3",
      "Dreamcast",
      "Retro PC",
      "Xbox 360",
    ]) {
      expect(out, name).not.toContain(name);
    }
    for (const factory of [
      "USB",
      "AUDIO1",
      "AUDIO2",
      "TUNER",
      "NET RADIO",
      "MusicCast Link",
      "Main Zone Sync",
      "PHONO",
    ]) {
      expect(out, factory).toContain(factory);
    }
    // Only the input list: a scene title is not an input name.
    expect(out).toContain("Movie Viewing");
  });

  it("finds a name that stands only in a raw YNCA line", () => {
    const out = scrub({ lines: ["@ZONE3:ZONENAME=Gaestezimmer", "@BT:DEVICENAME=Pixel von Max"] });
    expect(out).not.toContain("Gaestezimmer");
    expect(out).not.toContain("Pixel von Max");
  });

  it("an empty secret stays empty — the report shows that none is set", () => {
    const out = scrub({ key: "", password: "geheim" });
    expect(out).toContain('"key":""');
    expect(out).toContain('"password":"***"');
  });

  it("replaces a taught value wherever it occurs, the same marker for the same value", () => {
    const out = scrub({ a: "rx at yamaha.fritz.box", b: ["yamaha.fritz.box"] }, p =>
      p.teach("host", "yamaha.fritz.box"),
    );
    expect(out).not.toContain("fritz");
    expect(out.match(/host-1/g)).toHaveLength(2);
  });

  // Round 97: the master replaces a name as a whole word with `_` and `-` as boundaries — a name made of protocol words
  // alone would replace them in every protocol key and value.
  it("keeps a name made of protocol words readable, so net_radio and its input stay readable", () => {
    const out = scrub({ net_radio: { input: "net_radio" }, "MAIN:INP": "NET RADIO", z: "Wohnzimmer" }, p => {
      p.teach("name", "Radio");
      p.teach("name", "Wohnzimmer");
    });
    expect(out).toBe('{"net_radio":{"input":"net_radio"},"MAIN:INP":"NET RADIO","z":"name-1"}');
  });

  // A network name shaped like a model designation (WLAN-ABC123) is a name like any other — the model filter belongs to
  // the log lines only.
  it("replaces a network name shaped like a model designation", () => {
    const out = scrub({
      "system/getNetworkStatus": { network_name: "WLAN-ABC123", wireless_lan: { ssid: "FRITZ-7590" } },
    });
    expect(leaked(out, ["WLAN-ABC123"], "name")).toEqual([]);
    expect(leaked(out, ["FRITZ-7590"], "network")).toEqual([]);
  });

  it("leaves numbers, booleans and short values alone", () => {
    const out = scrub({ n: 41.5, b: true, s: "Jo on" }, p => p.teach("name", "Jo"));
    expect(out).toBe('{"n":41.5,"b":true,"s":"Jo on"}');
  });

  it("keeps the zone names a receiver ships with readable", () => {
    const out = scrub({ a: "Living", b: "Zone A", c: "Room 2" }, p => {
      for (const name of ["Living", "Zone A", "Room 2"]) {
        p.teach("name", name);
      }
    });
    expect(out).toBe('{"a":"Living","b":"Zone A","c":"Room 2"}');
  });

  it("keeps a serial of zeros — the cleaned fixtures carry it, and it says nothing about the person", () => {
    const out = scrub({ system_id: "00000000", line: "id 00000000, count 1000000000" });
    expect(out).toBe('{"system_id":"00000000","line":"id 00000000, count 1000000000"}');
  });

  it("replaces a WLAN name wherever it stands, also inside a longer token", () => {
    const out = scrub({ wireless_lan: { ssid: "FRITZ-7590" }, line: "joined FRITZ-7590_5G" });
    expect(out).toBe('{"wireless_lan":{"ssid":"network-1"},"line":"joined network-1_5G"}');
  });

  it("replaces a MAC without separators that has no letter in it", () => {
    const out = scrub({ "system/getNetworkStatus": { mac_address: { wired_lan: "001122334455" } } });
    expect(out).toBe('{"system/getNetworkStatus":{"mac_address":{"wired_lan":"mac-1"}}}');
  });

  it("replaces the zone names MusicCast's getNameText reports", () => {
    const out = scrub({ "system/getNameText": { zone_list: [{ id: "main", text: "Wohnzimmer" }] } });
    expect(out).toBe('{"system/getNameText":{"zone_list":[{"id":"main","text":"name-1"}]}}');
  });

  it("blanks a secret inside a list", () => {
    const out = scrub({ accounts: [{ password: "geheim" }, { token: "abc" }] });
    expect(out).toBe('{"accounts":[{"password":"***"},{"token":"***"}]}');
  });

  it("replaces many names in many lines, each name with its own placeholder", () => {
    const strings = Array.from({ length: 500 }, (_, i) => `line ${i}: Raumname ${i % 30} at 0a1b2b3c`);
    const out = JSON.parse(
      scrub(strings, p => {
        for (let i = 0; i < 30; i++) {
          p.teach("name", `Raumname ${i}`);
        }
        p.teach("serial", "0A1B2B3C");
      }),
    ) as string[];
    expect(out[7]).toMatch(/^line 7: name-\d+ at serial-1$/);
    expect(leaked(JSON.stringify(out), ["Raumname"], "name")).toEqual([]);
    expect(leaked(JSON.stringify(out), ["0a1b2b3c"], "serial")).toEqual([]);
  });

  it("replaces the longest known value first, in one pass", () => {
    const out = scrub({ a: "Kinderzimmer and Kinderzimmer Nord" }, p => {
      p.teach("name", "Kinderzimmer");
      p.teach("name", "Kinderzimmer Nord");
    });
    expect(out).toBe('{"a":"name-1 and name-2"}');
  });

  it("replaces a UUID, but keeps one that is all zeros (not set)", () => {
    const out = scrub({
      analytics_info: { uuid: "5F0C7C2E-1D1B-4C55-9F3E-2B9C1A7D8E11" },
      again: "app 5f0c7c2e-1d1b-4c55-9f3e-2b9c1a7d8e11",
      unset: "00000000-0000-0000-0000-000000000000",
    });
    expect(out).not.toMatch(/5f0c7c2e/i);
    expect(out.match(/uuid-1/g)).toHaveLength(2);
    expect(out).toContain("00000000-0000-0000-0000-000000000000");
  });

  it("takes MusicCast's device_id for the MAC it is — one marker with the MAC of the network status", () => {
    const out = scrub({
      "system/getDeviceInfo": { device_id: "00A0DED4F504" },
      "system/getNetworkStatus": { mac_address: { wired_lan: "00a0ded4f504" } },
      line: "MAC 00:A0:DE:D4:F5:04",
    });
    expect(leaked(out, ["00A0DED4F504", "00:A0:DE:D4:F5:04"], "mac")).toEqual([]);
    expect(out.match(/mac-\d/g)).toHaveLength(3);
    expect(out).not.toContain("serial-");
  });

  it("replaces the raw and the decoded spelling of an XML name", () => {
    const out = scrub({
      body: "<Name><Zone>Bad &amp; WC</Zone></Name>",
      val: "Bad & WC",
    });
    expect(leaked(out, ["Bad & WC", "Bad &amp; WC"], "name")).toEqual([]);
    expect(out).toMatch(/^\{"body":"<Name><Zone>name-\d<\/Zone><\/Name>","val":"name-\d"\}$/);
  });

  // The name patterns of the log lines follow two lines of main.ts — a changed wording there must fail here, or
  // the names in those lines would silently leave in clear.
  it("knows the log lines of main.ts that carry a device's name", () => {
    const main = readFileSync(join(__dirname, "../../main.ts"), "utf8");
    expect(main).toMatch(/`SSDP alive from \$\{address\}: \$\{found\.name[^`]*\} announced itself`/);
    expect(main).toContain('`${deviceId}: device name set to "${label}"`');
  });
});

import { describe, expect, it } from "vitest";
import { Pseudonymiser } from "./pseudonymiser";

function scrub(report: unknown, teach?: (p: Pseudonymiser) => void): string {
  const p = new Pseudonymiser();
  teach?.(p);
  p.learn(report);
  return JSON.stringify(p.walk(report));
}

describe("Pseudonymiser", () => {
  it("replaces addresses with stable markers and keeps masks and the unspecified address", () => {
    const out = scrub({
      a: "192.168.178.26",
      b: "at 192.168.178.26 and 8.8.8.8",
      mask: "255.255.255.0",
      none: "0.0.0.0",
    });
    expect(out).not.toContain("192.168.178.26");
    expect(out).toContain('"a":"ip-private-1"');
    expect(out).toContain("at ip-private-1 and ip-public-1");
    expect(out).toContain("255.255.255.0");
    expect(out).toContain("0.0.0.0");
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
    // A serial keeps its last four characters — the object ids carry them anyway.
    expect(out).toMatch(/serial-\d-…7553/);
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

  it("replaces a taught value wherever it occurs, the same marker for the same value", () => {
    const out = scrub({ a: "rx at yamaha.fritz.box", b: ["yamaha.fritz.box"] }, p =>
      p.teach("host", "yamaha.fritz.box"),
    );
    expect(out).not.toContain("fritz");
    expect(out.match(/host-1/g)).toHaveLength(2);
  });

  it("leaves numbers, booleans and short values alone", () => {
    const p = new Pseudonymiser();
    p.teach("name", "TV");
    expect(p.walk({ n: 41.5, b: true, s: "TV on" })).toEqual({ n: 41.5, b: true, s: "TV on" });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  // Review 2026-10-05, B8: every string compiled every known value's pattern anew (~400 ms per report here,
  // seconds on a Pi). The patterns are built once per set of known values.
  it("compiles the known values once, not per string, and again only after a new value", () => {
    const p = new Pseudonymiser();
    const compile = vi.spyOn(p as unknown as { compile(): unknown }, "compile");
    for (let i = 0; i < 30; i++) {
      p.teach("name", `Raumname ${i}`);
    }
    p.teach("serial", "0A1B2B3C");
    const strings = Array.from({ length: 500 }, (_, i) => `line ${i}: Raumname ${i % 30} at 0a1b2b3c`);
    const out = p.walk(strings) as string[];
    expect(compile).toHaveBeenCalledTimes(1);
    expect(out[7]).toMatch(/^line 7: name-\d+ at serial-1-…2B3C$/);
    p.teach("name", "Wintergarten");
    p.text("Wintergarten");
    expect(compile).toHaveBeenCalledTimes(2);
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
    expect(out).not.toMatch(/00a0ded4f504/i);
    expect(out.match(/mac-1/g)).toHaveLength(3);
    expect(out).not.toContain("serial-");
  });

  it("gives the raw and the decoded spelling of an XML name one marker", () => {
    const out = scrub({
      body: "<Name><Zone>Bad &amp; WC</Zone></Name>",
      val: "Bad & WC",
    });
    expect(out).toBe('{"body":"<Name><Zone>name-1</Zone></Name>","val":"name-1"}');
  });

  // The name patterns of the log lines follow two lines of main.ts — a changed wording there must fail here, or
  // the names in those lines would silently leave in clear.
  it("knows the log lines of main.ts that carry a device's name", () => {
    const main = readFileSync(join(__dirname, "../../main.ts"), "utf8");
    expect(main).toMatch(/`SSDP alive from \$\{address\}: \$\{found\.name[^`]*\} announced itself`/);
    expect(main).toContain('`${deviceId}: device name set to "${label}"`');
  });
});

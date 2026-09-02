import { describe, it, expect } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { searchInterfaces } from "./network-interfaces";

/**
 * Shorthand for a network-interface entry — only the fields searchInterfaces reads.
 *
 * @param address IP address of the interface
 * @param family Address family string as node reports it
 * @param internal Whether it is a loopback interface
 */
const nif = (address: string, family: string, internal: boolean): NetworkInterfaceInfo =>
  ({ address, family, internal }) as NetworkInterfaceInfo;

describe("searchInterfaces", () => {
  const ifaces = {
    lo0: [nif("127.0.0.1", "IPv4", true), nif("::1", "IPv6", true)],
    en0: [nif("10.47.88.2", "IPv4", false), nif("fe80::1", "IPv6", false)],
    en1: [nif("192.168.1.5", "IPv4", false)],
  };

  it("pins to the configured interface when one is set", () => {
    expect(searchInterfaces("10.47.88.2", ifaces)).toEqual(["10.47.88.2"]);
  });

  it("returns every non-internal IPv4 interface when unset", () => {
    expect(searchInterfaces("", ifaces)).toEqual(["10.47.88.2", "192.168.1.5"]);
    expect(searchInterfaces(undefined, ifaces)).toEqual(["10.47.88.2", "192.168.1.5"]);
  });

  it("treats the 0.0.0.0 wildcard as unset", () => {
    expect(searchInterfaces("0.0.0.0", ifaces)).toEqual(["10.47.88.2", "192.168.1.5"]);
  });

  it("skips loopback and IPv6 addresses", () => {
    const result = searchInterfaces("", ifaces);
    expect(result).not.toContain("127.0.0.1");
    expect(result).not.toContain("fe80::1");
  });

  it("accepts the numeric family 4 from older Node releases", () => {
    const legacy = { en0: [nif("10.0.0.9", 4 as unknown as string, false)] };
    expect(searchInterfaces("", legacy)).toEqual(["10.0.0.9"]);
  });

  it("returns empty when no usable interface exists (caller falls back to the default route)", () => {
    expect(searchInterfaces("", { lo0: [nif("127.0.0.1", "IPv4", true)] })).toEqual([]);
    expect(searchInterfaces("", {})).toEqual([]);
  });
});

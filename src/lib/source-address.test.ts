import { decideSourceAddress, localAddressOption, sourceAddress } from "./source-address";
import type { LocalNet } from "./network-address";

const NETS: LocalNet[] = [{ iface: "en0", family: "IPv4", address: "192.168.1.5", prefixLength: 24 }];

describe("the address this start listens, sends and connects on (round 87)", () => {
  afterEach(() => {
    decideSourceAddress("", NETS);
  });

  it("an address the host carries is used, and every connection is pinned to it", () => {
    expect(decideSourceAddress("192.168.1.5", NETS)).toEqual({ address: "192.168.1.5", missing: undefined });
    expect(sourceAddress()).toBe("192.168.1.5");
    expect(localAddressOption()).toEqual({ localAddress: "192.168.1.5" });
  });

  it("no choice, or the wildcard, is every address — no connection is pinned", () => {
    for (const setting of ["", "0.0.0.0", "::", undefined]) {
      expect(decideSourceAddress(setting, NETS)).toEqual({ address: undefined, missing: undefined });
      expect(localAddressOption()).toStrictEqual({});
    }
  });

  it("an address the host does not carry falls back to every address and is named for the warning", () => {
    expect(decideSourceAddress("192.0.2.1", NETS)).toEqual({ address: undefined, missing: "192.0.2.1" });
    expect(sourceAddress()).toBeUndefined();
    expect(localAddressOption()).toStrictEqual({});
  });
});

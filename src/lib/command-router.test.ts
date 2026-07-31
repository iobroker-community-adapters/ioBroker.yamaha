import { CommandRouter } from "./command-router";
import type { DeviceRecord, Protocol } from "./types";

function device(...protocols: Protocol[]): DeviceRecord {
  return { id: "d1", ip: "1.2.3.4", protocols: new Set(protocols) };
}

describe("CommandRouter.resolveTransport", () => {
  test("routes a media command to yxc when the device speaks yxc", () => {
    const router = new CommandRouter();
    expect(router.resolveTransport(device("ynca", "yxc"), { kind: "netusb.play" })).toBe("yxc");
  });

  test("routes an amp command to ynca on a ynca+yxc device", () => {
    const router = new CommandRouter();
    expect(router.resolveTransport(device("ynca", "yxc"), { kind: "power" })).toBe("ynca");
  });

  test("routes an amp command to xml when the device speaks only xml", () => {
    const router = new CommandRouter();
    expect(router.resolveTransport(device("xml"), { kind: "power" })).toBe("xml");
  });

  test("routes a tuner command to yxc on a yxc-only device", () => {
    const router = new CommandRouter();
    expect(router.resolveTransport(device("yxc"), { kind: "tuner.band" })).toBe("yxc");
  });

  test("routes an amp command to yxc on a yxc-only (MusicCast) device", () => {
    const router = new CommandRouter();
    expect(router.resolveTransport(device("yxc"), { kind: "power" })).toBe("yxc");
  });

  test("skips a media command when no protocol can serve it", () => {
    const router = new CommandRouter();
    expect(router.resolveTransport(device("xml"), { kind: "netusb.play" })).toBe("skip");
  });
});

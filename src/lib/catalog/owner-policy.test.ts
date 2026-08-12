import { pickOwner } from "./owner-policy";

describe("pickOwner — which transport owns a shared capability", () => {
  test("a capability only one transport offers is owned by that transport", () => {
    expect(pickOwner("dist.role", ["yxc"])).toBe("yxc");
    expect(pickOwner("scene.recall", ["ynca"])).toBe("ynca");
    expect(pickOwner("remoteCode", ["xml"])).toBe("xml");
  });

  test("with no conflict the most modern candidate wins: YXC > YNCA > XML", () => {
    expect(pickOwner("power", ["ynca", "yxc"])).toBe("yxc");
    expect(pickOwner("power", ["ynca", "xml"])).toBe("ynca");
    expect(pickOwner("power", ["xml", "yxc"])).toBe("yxc");
    expect(pickOwner("power", ["yxc", "ynca", "xml"])).toBe("yxc");
  });

  test("volume stays on a dB transport (YNCA/XML), never YXC's raw device scale", () => {
    // Census §3a: YXC volume is the raw 0..161 device scale, YNCA/XML are dB. Owning it via
    // YXC would silently feed existing scripts a different number range.
    expect(pickOwner("volume", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("volume", ["yxc", "xml"])).toBe("xml");
    expect(pickOwner("volume", ["yxc"])).toBe("yxc"); // only YXC present → its scale is all there is
  });

  test("write-loss keys stay with YNCA where YXC is read-only (census §3c)", () => {
    expect(pickOwner("maxVolume", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("extraBass", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("media.playback", ["yxc", "ynca"])).toBe("ynca");
  });

  test("dropdown-rich keys stay with YNCA so the enum states survive (census §3d)", () => {
    expect(pickOwner("input", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("soundProgram", ["yxc", "ynca"])).toBe("ynca");
  });

  test("an override falls back to modernity when none of its preferred transports are present", () => {
    // volume prefers ynca>xml>yxc; with only yxc present it must still resolve.
    expect(pickOwner("volume", ["yxc"])).toBe("yxc");
    // input prefers ynca; with yxc+xml present (no ynca) the modern default (yxc) takes it.
    expect(pickOwner("input", ["yxc", "xml"])).toBe("yxc");
  });
});

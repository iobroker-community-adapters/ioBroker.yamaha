import { canonicalIdOf, capabilityKeyOf, pickOwner, resolveOwnership } from "./owner-policy";

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
    expect(pickOwner("advanced.maxVolume", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("sound.extraBass", ["yxc", "ynca"])).toBe("ynca");
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

describe("resolveOwnership — the owner map across all offered transports", () => {
  test("each capability resolves to its owner; shared by policy, exclusive to its sole transport", () => {
    const owner = resolveOwnership({
      ynca: ["power", "volume", "input", "scene.recall"],
      yxc: ["power", "volume", "input", "dist.role"],
    });
    expect(owner.get("power")).toBe("yxc"); // shared, most modern
    expect(owner.get("volume")).toBe("ynca"); // shared, dB override
    expect(owner.get("input")).toBe("ynca"); // shared, dropdown override
    expect(owner.get("scene.recall")).toBe("ynca"); // YNCA-exclusive
    expect(owner.get("dist.role")).toBe("yxc"); // YXC-exclusive
  });

  test("a single offered transport owns everything it offers", () => {
    const owner = resolveOwnership({ ynca: ["power", "volume"] });
    expect(owner.get("power")).toBe("ynca");
    expect(owner.get("volume")).toBe("ynca");
    expect(owner.size).toBe(2);
  });
});

describe("capabilityKeyOf — the transport-neutral key from a transport's state id", () => {
  test("maps the known id drifts to the canonical key (census §3f, verified)", () => {
    // ynca's own "sound.bass"/"sound.treble" already match the canonical sound.* id — no
    // drift needed since the catalog rename (XML/YXC now natively use "sound.bass" too).
    expect(capabilityKeyOf("ynca", "sound.bass")).toBe("sound.bass");
    expect(capabilityKeyOf("ynca", "sound.treble")).toBe("sound.treble");
    expect(capabilityKeyOf("yxc", "subwooferVolume")).toBe("sound.subwooferTrim");
    expect(capabilityKeyOf("yxc", "partyEnable")).toBe("party");
    expect(capabilityKeyOf("xml", "hdmiOut1")).toBe("hdmi.out1");
    expect(capabilityKeyOf("xml", "hdmiOut2")).toBe("hdmi.out2");
  });

  test("strips a zone prefix to the template key, then applies the drift", () => {
    expect(capabilityKeyOf("ynca", "zone2.volume")).toBe("volume");
    expect(capabilityKeyOf("yxc", "zone3.power")).toBe("power");
    expect(capabilityKeyOf("ynca", "zone2.sound.bass")).toBe("sound.bass");
  });

  test("an already-canonical id passes through unchanged", () => {
    expect(capabilityKeyOf("yxc", "power")).toBe("power");
    expect(capabilityKeyOf("yxc", "dist.role")).toBe("dist.role");
    expect(capabilityKeyOf("xml", "sound.bass")).toBe("sound.bass");
  });
});

describe("canonicalIdOf — the drift-resolved object id, zone prefix kept", () => {
  test("resolves the drift but keeps the zone prefix (the per-zone tree node)", () => {
    expect(canonicalIdOf("ynca", "sound.bass")).toBe("sound.bass");
    expect(canonicalIdOf("ynca", "zone2.sound.bass")).toBe("zone2.sound.bass");
    expect(canonicalIdOf("yxc", "partyEnable")).toBe("party");
    expect(canonicalIdOf("xml", "hdmiOut1")).toBe("hdmi.out1");
  });

  test("a canonical id (with or without a zone) is unchanged", () => {
    expect(canonicalIdOf("yxc", "zone2.volume")).toBe("zone2.volume");
    expect(canonicalIdOf("yxc", "power")).toBe("power");
  });
});

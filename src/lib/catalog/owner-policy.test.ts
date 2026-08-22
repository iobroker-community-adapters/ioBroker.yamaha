import { canonicalIdOf, capabilityKeyOf, pickOwner, resolveOwnership } from "./owner-policy";

describe("pickOwner — which transport owns a shared capability", () => {
  test("a capability only one transport offers is owned by that transport", () => {
    expect(pickOwner("dist.role", ["yxc"])).toBe("yxc");
    expect(pickOwner("scene.recall", ["ynca"])).toBe("ynca");
    expect(pickOwner("multiroom.party", ["xml"])).toBe("xml");
  });

  test("with no conflict the most modern candidate wins: YXC > YNCA > XML", () => {
    expect(pickOwner("power", ["ynca", "yxc"])).toBe("yxc");
    expect(pickOwner("power", ["ynca", "xml"])).toBe("ynca");
    expect(pickOwner("power", ["xml", "yxc"])).toBe("yxc");
    expect(pickOwner("power", ["yxc", "ynca", "xml"])).toBe("yxc");
  });

  test("volume stays on a dB transport (YNCA/XML), never YXC's raw device scale", () => {
    expect(pickOwner("volume", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("volume", ["yxc", "xml"])).toBe("xml");
    expect(pickOwner("volume", ["yxc"])).toBe("yxc");
  });

  test("write-loss keys stay with YNCA/XML where YXC is read-only (census §3c)", () => {
    expect(pickOwner("advanced.maxVolume", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("sound.extraBass", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("sound.dialogueLift", ["yxc", "xml"])).toBe("xml");
  });

  test("dropdown-rich keys stay with YNCA so the enum states survive (census §3d)", () => {
    expect(pickOwner("input", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("soundProgram", ["yxc", "ynca"])).toBe("ynca");
  });

  test("an override falls back to modernity when none of its preferred transports are present", () => {
    expect(pickOwner("volume", ["yxc"])).toBe("yxc");
    expect(pickOwner("input", ["yxc", "xml"])).toBe("yxc");
  });
});

describe("resolveOwnership — the owner map across all offered transports", () => {
  test("each capability resolves to its owner; shared by policy, exclusive to its sole transport", () => {
    const owner = resolveOwnership({
      ynca: ["power", "volume", "input", "scene.recall"],
      yxc: ["power", "volume", "input", "dist.role"],
    });
    expect(owner.get("power")).toBe("yxc");
    expect(owner.get("volume")).toBe("ynca");
    expect(owner.get("input")).toBe("ynca");
    expect(owner.get("scene.recall")).toBe("ynca");
    expect(owner.get("dist.role")).toBe("yxc");
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
    expect(capabilityKeyOf("ynca", "sound.bass")).toBe("sound.bass");
    expect(capabilityKeyOf("ynca", "sound.treble")).toBe("sound.treble");
    expect(capabilityKeyOf("yxc", "subwooferVolume")).toBe("sound.subwooferTrim");
    expect(capabilityKeyOf("yxc", "multiroom.partyEnable")).toBe("multiroom.party");
    expect(capabilityKeyOf("xml", "hdmiOut1")).toBe("hdmi.out1");
    expect(capabilityKeyOf("xml", "hdmiOut2")).toBe("hdmi.out2");
  });

  test("strips a zone prefix to the template key, then applies the drift", () => {
    expect(capabilityKeyOf("ynca", "multiroom.zone2.volume")).toBe("volume");
    expect(capabilityKeyOf("yxc", "multiroom.zone3.power")).toBe("power");
    expect(capabilityKeyOf("ynca", "multiroom.zone2.sound.bass")).toBe("sound.bass");
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
    expect(canonicalIdOf("ynca", "multiroom.zone2.sound.bass")).toBe("multiroom.zone2.sound.bass");
    expect(canonicalIdOf("yxc", "multiroom.partyEnable")).toBe("multiroom.party");
    expect(canonicalIdOf("xml", "hdmiOut1")).toBe("hdmi.out1");
  });

  test("a canonical id (with or without a zone) is unchanged", () => {
    expect(canonicalIdOf("yxc", "multiroom.zone2.volume")).toBe("multiroom.zone2.volume");
    expect(canonicalIdOf("yxc", "power")).toBe("power");
  });
});

describe("pickOwner fallbacks", () => {
  it("falls back to modernity when the override lists no present transport", () => {
    // "sound.dialogueLift" prefers XML then YXC. On a device where only YNCA
    // offers it, an override-only lookup would leave the datapoint ownerless and
    // the whole tree coordination would throw.
    expect(pickOwner("sound.dialogueLift", ["ynca"])).toBe("ynca");
    expect(pickOwner("sound.surroundDecoder", ["xml"])).toBe("xml");
  });

  it("uses modernity for a key with no override at all", () => {
    expect(pickOwner("power", ["xml", "ynca", "yxc"])).toBe("yxc");
    expect(pickOwner("power", ["xml", "ynca"])).toBe("ynca");
  });
});

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
    // The unified tuner.preset (v2.0.0) is writable on BOTH — no override, modernity wins.
    expect(pickOwner("tuner.preset", ["yxc", "ynca"])).toBe("yxc");
    // The unified player block's settable states (v2.0.0): YXC is read-only there
    // (toggles/buttons only), YNCA writes them directly — write-proof beats modernity.
    expect(pickOwner("player.playback", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("player.repeat", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("player.shuffle", ["yxc", "ynca"])).toBe("ynca");
    // Alone, YXC still owns them — a MusicCast speaker keeps its read-only display.
    expect(pickOwner("player.playback", ["yxc"])).toBe("yxc");
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

describe("scene.recall ownership (#615 — write-proof beats modernity)", () => {
  test("the proven writers outrank YNCA's name-based claim", () => {
    // RX-V473 class: YNCA (names readable) + XML (write value declared) — XML wins,
    // because the 2012 generation refuses the YNCA scene put with @RESTRICTED.
    expect(pickOwner("scene.recall", ["ynca", "xml"])).toBe("xml");
    // MusicCast class: YXC declares the recall endpoint per zone — it wins outright.
    expect(pickOwner("scene.recall", ["yxc", "xml"])).toBe("yxc");
    expect(pickOwner("scene.recall", ["yxc", "ynca", "xml"])).toBe("yxc");
    // A device where only YNCA exists keeps the last-resort YNCA path.
    expect(pickOwner("scene.recall", ["ynca"])).toBe("ynca");
  });
});

describe("scene.list ownership (audit 2026-09-02 — title sources before the count source)", () => {
  test("the transports that know the titles own the list; MusicCast only when it is alone", () => {
    // MusicCast connects in seconds and knows the slot COUNT but no titles; by modernity it
    // would publish a title-less list on the first contact that stands until the next restart.
    expect(pickOwner("scene.list", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("scene.list", ["yxc", "xml"])).toBe("xml");
    expect(pickOwner("scene.list", ["yxc", "ynca", "xml"])).toBe("xml");
    expect(pickOwner("scene.list", ["yxc"])).toBe("yxc");
  });
});

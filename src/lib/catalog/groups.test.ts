import { describe, it, expect } from "vitest";
import { groupOf, SWITCHABLE_GROUPS } from "./groups";

describe("groupOf", () => {
  it("maps player sources to the player group — flat and grouped ids", () => {
    expect(groupOf("spotify.playback")).toBe("player");
    expect(groupOf("netRadio.station")).toBe("player");
    expect(groupOf("netPlayer.play")).toBe("player");
    expect(groupOf("cd.playback")).toBe("player");
    expect(groupOf("player.spotify.playback")).toBe("player");
  });

  it("maps tuner and dab to the tuner group", () => {
    expect(groupOf("tuner.band")).toBe("tuner");
    expect(groupOf("dab.channelLabel")).toBe("tuner");
    expect(groupOf("tuner.dab.channelLabel")).toBe("tuner");
  });

  it("maps each extra zone to the zones group", () => {
    expect(groupOf("zone2.volume")).toBe("zones");
    expect(groupOf("zone4.power")).toBe("zones");
  });

  it("maps dist/multiroom, hdmi and scene", () => {
    expect(groupOf("dist.groupName")).toBe("multiroom");
    expect(groupOf("multiroom.groupName")).toBe("multiroom");
    expect(groupOf("hdmi.out1")).toBe("hdmi");
    expect(groupOf("scene.recall")).toBe("scene");
  });

  it("keeps the amplifier core, sound and info in the always-on amp group", () => {
    expect(groupOf("power")).toBe("amp");
    expect(groupOf("volume")).toBe("amp");
    expect(groupOf("input")).toBe("amp");
    expect(groupOf("sound.bass")).toBe("amp");
    expect(groupOf("info.model")).toBe("amp");
  });

  it("does not offer the amp core as a switch (only zone2-4 are the zones group)", () => {
    expect(SWITCHABLE_GROUPS).not.toContain("amp");
    expect(SWITCHABLE_GROUPS).toContain("zones");
  });
});

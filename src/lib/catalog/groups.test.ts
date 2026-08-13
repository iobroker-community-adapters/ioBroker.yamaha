import { describe, it, expect } from "vitest";
import { groupOf, isGroupEnabled, SWITCHABLE_GROUPS } from "./groups";

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

  it("keeps the amplifier core and info in the always-on amp group", () => {
    expect(groupOf("power")).toBe("amp");
    expect(groupOf("volume")).toBe("amp");
    expect(groupOf("input")).toBe("amp");
    expect(groupOf("soundProgram")).toBe("amp");
    expect(groupOf("sleep")).toBe("amp");
    expect(groupOf("info.model")).toBe("amp");
    expect(groupOf("inputText")).toBe("amp");
  });

  it("maps sound-processing and tone-tuning ids (bare and sound.*-prefixed) to the sound group", () => {
    // bare canonical ids (ynca's own "sound.bass"/"sound.treble" drift to these via owner-policy)
    expect(groupOf("bass")).toBe("sound");
    expect(groupOf("treble")).toBe("sound");
    expect(groupOf("straight")).toBe("sound");
    expect(groupOf("enhancer")).toBe("sound");
    expect(groupOf("pureDirect")).toBe("sound");
    expect(groupOf("adaptiveDrc")).toBe("sound");
    expect(groupOf("surroundDecoder")).toBe("sound");
    expect(groupOf("extraBass")).toBe("sound");
    expect(groupOf("subwooferTrim")).toBe("sound");
    expect(groupOf("balance")).toBe("sound");
    expect(groupOf("equalizerLow")).toBe("sound");
    // sound.* prefix (headphone bass/treble keep their channel, unlike bass/treble)
    expect(groupOf("sound.bass")).toBe("sound");
    expect(groupOf("sound.headphoneBass")).toBe("sound");
  });

  it("maps setup/config ids to the advanced group", () => {
    expect(groupOf("maxVolume")).toBe("advanced");
    expect(groupOf("speakerA")).toBe("advanced");
    expect(groupOf("speakerB")).toBe("advanced");
    expect(groupOf("initialVolume.mode")).toBe("advanced");
    expect(groupOf("speakers.pattern")).toBe("advanced");
    expect(groupOf("inputNames.hdmi1")).toBe("advanced");
  });

  it("maps Zone B and the all-zones power switch to the zones group (not the always-on core)", () => {
    expect(groupOf("zoneB.power")).toBe("zones");
    expect(groupOf("zoneB.volume")).toBe("zones");
    expect(groupOf("masterPower")).toBe("zones");
  });

  it("maps distributionEnable and party mode to the multiroom group", () => {
    expect(groupOf("distributionEnable")).toBe("multiroom");
    expect(groupOf("party")).toBe("multiroom");
    expect(groupOf("partyMute")).toBe("multiroom");
  });

  it("maps HDMI routing and lip-sync to the hdmi group on every zone, not the zones group", () => {
    expect(groupOf("hdmi.output")).toBe("hdmi");
    expect(groupOf("lipSync.hdmiOut1")).toBe("hdmi");
    expect(groupOf("zone2.hdmi.output")).toBe("hdmi");
    expect(groupOf("zone3.lipSync.hdmiOut2")).toBe("hdmi");
  });

  it("does not offer the amp core as a switch (only zone2-4 are the zones group)", () => {
    expect(SWITCHABLE_GROUPS).not.toContain("amp");
    expect(SWITCHABLE_GROUPS).toContain("zones");
    expect(SWITCHABLE_GROUPS).toContain("sound");
    expect(SWITCHABLE_GROUPS).toContain("advanced");
  });
});

describe("isGroupEnabled", () => {
  it("keeps the amp core on regardless of config", () => {
    expect(isGroupEnabled("power", {})).toBe(true);
    expect(isGroupEnabled("info.model", { group_amp: false })).toBe(true);
  });

  it("turns the sound and advanced groups off like any other switchable group", () => {
    expect(isGroupEnabled("sound.bass", { group_sound: false })).toBe(false);
    expect(isGroupEnabled("maxVolume", { group_advanced: false })).toBe(false);
    expect(isGroupEnabled("sound.bass", {})).toBe(true);
  });

  it("defaults every group to on when its flag is absent or true", () => {
    expect(isGroupEnabled("player.spotify.playback", {})).toBe(true);
    expect(isGroupEnabled("tuner.band", { group_tuner: true })).toBe(true);
  });

  it("turns a group off only when its own flag is explicitly false", () => {
    expect(isGroupEnabled("player.spotify.playback", { group_player: false })).toBe(false);
    expect(isGroupEnabled("multiroom.role", { group_multiroom: false })).toBe(false);
    // an off flag for a different group leaves this one on
    expect(isGroupEnabled("player.spotify.playback", { group_tuner: false })).toBe(true);
  });
});

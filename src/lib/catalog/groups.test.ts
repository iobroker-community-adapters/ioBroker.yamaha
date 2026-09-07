import { describe, it, expect } from "vitest";
import { groupOf, groupsOf, isGroupEnabled, SWITCHABLE_GROUPS } from "./groups";

describe("groupOf", () => {
  it("maps player sources to the player group", () => {
    expect(groupOf("player.spotify.playback")).toBe("player");
    expect(groupOf("player.netRadio.station")).toBe("player");
    expect(groupOf("player.netPlayer.play")).toBe("player");
    expect(groupOf("player.cd.playback")).toBe("player");
  });

  it("maps tuner and dab to the tuner group", () => {
    expect(groupOf("tuner.band")).toBe("tuner");
    expect(groupOf("tuner.dab.channelLabel")).toBe("tuner");
  });

  it("gives a zone's amp core the amp theme — the zone itself hangs on multiroom", () => {
    // The theme is read with the zone prefix stripped: a zone's volume is amp-core, exactly
    // like the main zone's. That it disappears with the multiroom switch is groupsOf's job.
    expect(groupOf("multiroom.zone2.volume")).toBe("amp");
    expect(groupOf("multiroom.zone4.power")).toBe("amp");
    expect(groupsOf("multiroom.zone2.volume")).toEqual(["multiroom", "amp"]);
  });

  it("maps the bare multiroom zone channel objects to multiroom", () => {
    expect(groupOf("multiroom.zone2")).toBe("multiroom");
    expect(groupOf("multiroom.zone3")).toBe("multiroom");
    expect(groupOf("multiroom.zone4")).toBe("multiroom");
  });

  it("maps multiroom, hdmi and scene", () => {
    expect(groupOf("multiroom.group.name")).toBe("multiroom");
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

  it("maps every sound-processing and tone-tuning id — all now real sound.* ids, no bare exceptions", () => {
    expect(groupOf("sound.bass")).toBe("sound");
    expect(groupOf("sound.treble")).toBe("sound");
    expect(groupOf("sound.straight")).toBe("sound");
    expect(groupOf("sound.enhancer")).toBe("sound");
    expect(groupOf("sound.pureDirect")).toBe("sound");
    expect(groupOf("sound.adaptiveDrc")).toBe("sound");
    expect(groupOf("sound.surroundDecoder")).toBe("sound");
    expect(groupOf("sound.extraBass")).toBe("sound");
    expect(groupOf("sound.subwooferTrim")).toBe("sound");
    expect(groupOf("sound.balance")).toBe("sound");
    expect(groupOf("sound.equalizer.low")).toBe("sound");
    expect(groupOf("sound.clearVoice")).toBe("sound");
    expect(groupOf("sound.bassExtension")).toBe("sound");
    expect(groupOf("sound.ypaoVolume")).toBe("sound");
    expect(groupOf("sound.headphoneBass")).toBe("sound");
    // A zone's sound item is a SOUND datapoint that happens to live in a zone: the Sound
    // switch has to reach it, and the Multiroom switch does too (audit 2026-09-06).
    expect(groupOf("multiroom.zone2.sound.enhancer")).toBe("sound");
    expect(groupsOf("multiroom.zone2.sound.enhancer")).toEqual(["multiroom", "sound"]);
  });

  it("maps every setup/config id to the advanced group — all now real advanced.* ids", () => {
    expect(groupOf("advanced.maxVolume")).toBe("advanced");
    expect(groupOf("advanced.speakers.speakerA")).toBe("advanced");
    expect(groupOf("advanced.speakers.speakerB")).toBe("advanced");
    expect(groupOf("advanced.initialVolume.mode")).toBe("advanced");
    expect(groupOf("advanced.speakers.pattern")).toBe("advanced");
    expect(groupOf("advanced.inputNames.hdmi1")).toBe("advanced");
  });

  it("maps Zone B and the all-zones power switch to the multiroom group", () => {
    expect(groupOf("multiroom.zoneB.power")).toBe("multiroom");
    expect(groupOf("multiroom.zoneB.volume")).toBe("multiroom");
    expect(groupOf("multiroom.masterPower")).toBe("multiroom");
  });

  it("maps distributionEnable and party mode to the multiroom group", () => {
    expect(groupOf("multiroom.distributionEnable")).toBe("multiroom");
    expect(groupOf("multiroom.party")).toBe("multiroom");
    expect(groupOf("multiroom.partyMute")).toBe("multiroom");
  });

  it("maps HDMI routing and lip-sync to the hdmi group, in the zones too", () => {
    expect(groupOf("hdmi.output")).toBe("hdmi");
    expect(groupOf("hdmi.lipSyncOut1")).toBe("hdmi");
    // Zoned HDMI is HDMI, and follows both switches.
    expect(groupOf("multiroom.zone2.hdmi.output")).toBe("hdmi");
    expect(groupsOf("multiroom.zone3.hdmi.lipSyncOut2")).toEqual(["multiroom", "hdmi"]);
  });

  it("does not offer the amp core as a switch and has no zones group", () => {
    expect(SWITCHABLE_GROUPS).not.toContain("amp");
    expect(SWITCHABLE_GROUPS).not.toContain("zones");
    expect(SWITCHABLE_GROUPS).toContain("multiroom");
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
    expect(isGroupEnabled("advanced.maxVolume", { group_advanced: false })).toBe(false);
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

  it("gates zones and zone B through the multiroom switch", () => {
    expect(isGroupEnabled("multiroom.zone2.volume", { group_multiroom: false })).toBe(false);
    expect(isGroupEnabled("multiroom.zoneB.power", { group_multiroom: false })).toBe(false);
    expect(isGroupEnabled("multiroom.masterPower", { group_multiroom: false })).toBe(false);
    expect(isGroupEnabled("multiroom.zone2.volume", {})).toBe(true);
  });

  it("the clock/alarm block is its own switchable group", () => {
    expect(groupOf("clock.alarm.oneday.time")).toBe("clock");
    expect(groupOf("clock.autoSync")).toBe("clock");
    expect(isGroupEnabled("clock.alarm.on", { group_clock: false })).toBe(false);
    expect(isGroupEnabled("clock.alarm.on", {})).toBe(true);
  });
});

describe("groupOf — the on-screen remote", () => {
  it("counts the remote pad as part of playback & browsing, on every transport", () => {
    // The pad is how the menu is operated, and on YNCA/XML the browsing surface creates it.
    // Were it in the always-on core, switching the group off would leave a dead pad behind.
    expect(groupOf("remote.cursor")).toBe("player");
    expect(groupOf("remote.menu")).toBe("player");
    expect(groupOf("multiroom.zone2.remote.cursor")).toBe("player");
    expect(groupsOf("multiroom.zone2.remote.cursor")).toEqual(["multiroom", "player"]);
  });
});

describe("a switch reaches its own theme in EVERY zone (audit 2026-09-06)", () => {
  // Measured over 25 MusicCast and 15 YNCA device captures: reading the first path segment
  // raw left 304 playback, 57+26 sound, 16+20 advanced and 12 scene datapoints of the zones
  // standing after the switch that was meant to remove them.
  const zoned = [
    ["group_player", "multiroom.zone2.player.playback"],
    ["group_player", "multiroom.zone2.remote.cursor"],
    ["group_sound", "multiroom.zone3.sound.enhancer"],
    ["group_advanced", "multiroom.zone2.advanced.maxVolume"],
    ["group_scene", "multiroom.zone4.scene.recall"],
    ["group_hdmi", "multiroom.zone2.hdmi.output"],
    ["group_tuner", "multiroom.zone2.tuner.band"],
  ] as const;

  it.each(zoned)("%s = false removes %s", (flag, id) => {
    expect(isGroupEnabled(id, { [flag]: false })).toBe(false);
  });

  it("and multiroom still removes the zones whole, whatever their theme", () => {
    for (const [, id] of zoned) {
      expect(isGroupEnabled(id, { group_multiroom: false })).toBe(false);
    }
    // while the device-wide multiroom states carry no second group
    expect(groupsOf("multiroom.party")).toEqual(["multiroom"]);
    expect(groupsOf("multiroom.group.leave")).toEqual(["multiroom"]);
  });

  it("leaves the main zone's datapoints alone when only multiroom is off", () => {
    expect(isGroupEnabled("sound.enhancer", { group_multiroom: false })).toBe(true);
    expect(isGroupEnabled("player.playback", { group_multiroom: false })).toBe(true);
  });
});

describe("audit 2026-09-06 — the group switch reaches its own theme in every zone", () => {
  it("a zone datapoint hangs on multiroom AND its theme", () => {
    expect(groupsOf("multiroom.zone2.sound.enhancer")).toEqual(["multiroom", "sound"]);
    expect(groupsOf("sound.enhancer")).toEqual(["sound"]);
  });
});

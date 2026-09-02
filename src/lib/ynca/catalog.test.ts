import {
  buildYncaCatalog,
  funcToEntry,
  idToEntry,
  presentYncaEntries,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
} from "./catalog";
import { CHANNEL_NAMES } from "../catalog/types";
import type { EnumSpec } from "../catalog/value-coerce";
import type { YncaCapabilities } from "./capability";
import { capabilitiesFromLines as parseCapabilities } from "./__fixtures__/capabilities-from-lines";
import rxA810 from "./__fixtures__/RX-A810.json";

describe("YNCA catalog", () => {
  test("a MAIN amplifier function becomes a top-level state carrying its YNCA function", () => {
    const power = buildYncaCatalog().find(e => e.id === "power");
    expect(power).toMatchObject({ subunit: "MAIN", func: "PWR", write: true, role: "switch.power" });
    expect(power?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
  });

  test("the DAB date/time drops the device's padded zero placeholder, keeps a real reading", () => {
    // Text values pass through verbatim, and the receiver pads this field: with no DAB time it
    // answers `"     \'00 00:00"` (measured on an RX-V6A, DAB status "not_ready"), against real
    // readings of the form `04NOV\'22 12:24` in the reference logs.
    const decode = buildYncaCatalog().find(e => e.id === "tuner.dab.dateTime")?.wireDecode;
    expect(decode).toBeDefined();
    expect(decode?.("     '00 00:00")).toBe("");
    expect(decode?.("   ")).toBe("");
    expect(decode?.("04NOV'22 12:24")).toBe("04NOV'22 12:24");
    expect(decode?.("  04NOV'22 12:24 ")).toBe("04NOV'22 12:24");
  });

  test("a device answering both tuner subunits offers every band, not only the last-mapped set", () => {
    // TUN carries {AM, FM}, DAB carries {DAB, FM} — both under the id tuner.band. Whichever
    // definition the tree kept last used to decide the dropdown, so AM could silently vanish.
    const dual = presentYncaEntries({ model: "X", subunits: { TUN: { BAND: "AM" }, DAB: { BAND: "DAB" } } });
    const bands = dual.filter(e => e.id === "tuner.band");
    expect(bands).toHaveLength(2);
    for (const band of bands) {
      expect(Object.keys((band.spec as EnumSpec).states).sort()).toEqual(["AM", "DAB", "FM"]);
    }
  });

  test("a single-subunit device keeps exactly its own bands", () => {
    const classic = presentYncaEntries({ model: "X", subunits: { TUN: { BAND: "AM" } } });
    const band = classic.find(e => e.id === "tuner.band");
    expect(Object.keys((band?.spec as EnumSpec).states).sort()).toEqual(["AM", "FM"]);
  });

  test("each additional zone gets its own prefixed states", () => {
    expect(buildYncaCatalog().find(e => e.id === "multiroom.zone2.volume")).toMatchObject({
      subunit: "ZONE2",
      func: "VOL",
    });
  });

  test("input is an enum dropdown carrying the full device-agnostic input list", () => {
    const input = buildYncaCatalog().find(e => e.id === "input");
    expect(input?.spec.kind).toBe("enum");
    const states = (input?.spec as EnumSpec).states;
    expect(states).toHaveProperty("HDMI1");
    expect(states).toHaveProperty("TUNER");
    expect(states).toHaveProperty("Spotify");
  });

  test("extra bass is an on/off boolean (Auto/Off) on every zone", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "sound.extraBass")).toMatchObject({ subunit: "MAIN", func: "EXBASS" });
    expect(cat.find(e => e.id === "sound.extraBass")?.spec).toEqual({ kind: "onoff", on: "Auto", off: "Off" });
    expect(cat.find(e => e.id === "multiroom.zone2.sound.extraBass")).toMatchObject({
      subunit: "ZONE2",
      func: "EXBASS",
    });
  });

  test("max volume and initial volume level are numbers with a dB unit", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "advanced.maxVolume")).toMatchObject({ subunit: "MAIN", func: "MAXVOL" });
    expect(cat.find(e => e.id === "advanced.maxVolume")?.spec).toMatchObject({ kind: "number", unit: "dB" });
    expect(cat.find(e => e.id === "advanced.initialVolume.level")?.spec).toMatchObject({
      kind: "number",
      unit: "dB",
    });
  });

  test("lip-sync offsets are numbers in ms", () => {
    expect(buildYncaCatalog().find(e => e.id === "hdmi.lipSyncOut1")?.spec).toMatchObject({
      kind: "number",
      unit: "ms",
    });
  });

  test("3D Cinema DSP keeps its wire function name 3DCINEMA", () => {
    expect(buildYncaCatalog().find(e => e.id === "sound.cinemaDsp3d")).toMatchObject({
      func: "3DCINEMA",
      subunit: "MAIN",
    });
  });

  test("Zone B and speaker A/B functions exist on MAIN only", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "multiroom.zoneB.volume")).toMatchObject({ subunit: "MAIN", func: "ZONEBVOL" });
    expect(cat.find(e => e.id === "multiroom.zone2.zoneB.volume")).toBeUndefined();
    expect(cat.find(e => e.id === "advanced.speakers.speakerA")).toMatchObject({ subunit: "MAIN", func: "SPEAKERA" });
    expect(cat.find(e => e.id === "multiroom.zoneB.power")?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
  });

  test("scene names are no longer own datapoints — the recall entry sweeps them as aliases (v2.0.0)", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "scene.name1")).toBeUndefined();
    // All twelve name functions still ride the sweep (they feed the dropdown labels
    // and the scene.list state), attached to the recall entry as read aliases.
    const recall = cat.find(e => e.id === "scene.recall");
    expect(recall?.readFunc).toBe("SCENE1NAME");
    expect(recall?.readAliases).toContain("SCENE12NAME");
    expect(sweepGets(cat).some(get => get.subunit === "MAIN" && get.func === "SCENE7NAME")).toBe(true);
  });

  test("scene recall triggers a scene: writable 1..12, encodes to 'Scene N', write-only, gated on scene names", () => {
    const cat = buildYncaCatalog();
    const recall = cat.find(e => e.id === "scene.recall");
    expect(recall).toMatchObject({ subunit: "MAIN", func: "SCENE", write: true });
    expect(recall?.spec).toMatchObject({ kind: "number", min: 1, max: 12 });
    // encodes the plain number to the YNCA wire value "Scene N" (ynca lib: _put("SCENE", f"Scene {id}"))
    expect(yncaCommand("scene.recall", 3, idToEntry(cat))).toEqual({
      subunit: "MAIN",
      func: "SCENE",
      value: "Scene 3",
    });
    // write-only: a SCENE1NAME device push maps to NO state (the names feed the
    // dropdown labels and scene.list, not a datapoint).
    expect(funcToEntry(cat).get("MAIN:SCENE1NAME")).toBeUndefined();
    // appears only when the device reports scenes (gated on scene-1 name presence)
    const withScenes: YncaCapabilities = { model: "RX", subunits: { MAIN: { SCENE1NAME: "Movie" } } };
    expect(yncaObjectsFor(withScenes).map(o => o.id)).toContain("scene.recall");
    const noScenes: YncaCapabilities = { model: "RX", subunits: { MAIN: { PWR: "On" } } };
    expect(yncaObjectsFor(noScenes).map(o => o.id)).not.toContain("scene.recall");
  });

  test("system info and controls carry intelligent types", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "info.model")).toMatchObject({ subunit: "SYS", func: "MODELNAME", write: false });
    expect(cat.find(e => e.id === "info.model")?.spec).toEqual({ kind: "text" });
    expect(cat.find(e => e.id === "info.firmware")).toMatchObject({ subunit: "SYS", func: "VERSION", write: false });
    expect(cat.find(e => e.id === "multiroom.masterPower")?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
    expect(cat.find(e => e.id === "hdmi.out1")?.spec).toEqual({ kind: "onoff", on: "On", off: "Off" });
    expect(cat.find(e => e.id === "advanced.speakers.pattern")?.spec.kind).toBe("enum");
  });

  test("all 23 input names are read-only text states on SYS", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "advanced.inputNames.hdmi1")).toMatchObject({
      subunit: "SYS",
      func: "INPNAMEHDMI1",
      write: false,
    });
    expect(cat.filter(e => e.id.startsWith("advanced.inputNames.")).length).toBe(23);
  });

  test("the AM/FM tuner is complete: RDS text B, program type and search mode", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "tuner.rdsTextB")).toMatchObject({ subunit: "TUN", func: "RDSTXTB", write: false });
    expect(cat.find(e => e.id === "tuner.rdsProgramType")?.spec).toEqual({ kind: "text" });
    expect(cat.find(e => e.id === "tuner.searchMode")?.spec.kind).toBe("enum");
  });

  test("playback reads from PLAYBACKINFO but writes to PLAYBACK (flat block, per subunit)", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.playback" && e.subunit === "SPOTIFY")).toMatchObject({
      func: "PLAYBACK",
      write: true,
    });
    expect(sweepGets(cat)).toContainEqual({ subunit: "SPOTIFY", func: "PLAYBACKINFO" });
    expect(funcToEntry(cat).get("SPOTIFY:PLAYBACKINFO")?.id).toBe("player.playback");
  });

  test("playback is a numeric media.state coded from PLAYBACKINFO (Play=0)", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.playback")?.role).toBe("media.state");
    // Every source subunit reports into the ONE flat state (v2.0.0) — the controller
    // routes it to the zones listening to that source.
    expect(yncaStateUpdate({ subunit: "SPOTIFY", func: "PLAYBACKINFO", value: "Play" }, funcToEntry(cat))).toEqual({
      id: "player.playback",
      value: 0,
    });
  });

  test("track skip is exposed as next/prev buttons that put Skip Fwd/Rev on PLAYBACK", () => {
    const cat = buildYncaCatalog();
    const next = cat.find(e => e.id === "player.next" && e.subunit === "SPOTIFY");
    const prev = cat.find(e => e.id === "player.prev" && e.subunit === "SPOTIFY");
    expect(next?.role).toBe("button.next");
    expect(prev?.role).toBe("button.prev");
    // The wire value is fixed per direction; the SUBUNIT is picked by the controller
    // from the zone's input — asserted via a one-entry map, like the controller writes.
    expect(yncaCommand("player.next", true, new Map([["player.next", next!]]))).toEqual({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      value: "Skip Fwd",
    });
    expect(yncaCommand("player.prev", true, new Map([["player.prev", prev!]]))).toEqual({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      value: "Skip Rev",
    });
  });

  test("next/prev buttons are CREATED for a real device (which reports only PLAYBACKINFO)", () => {
    // Regression: gating the buttons on their write function PLAYBACK created them on no
    // real device — every fixture answers only PLAYBACKINFO. Object creation, not just the
    // catalog entry, must be verified against real device responses.
    const capabilities = parseCapabilities(rxA810);
    const ids = yncaObjectsFor(capabilities).map(object => object.id);
    expect(ids).toContain("player.playback");
    expect(ids).toContain("player.next");
    expect(ids).toContain("player.prev");
    // The per-source copies of the block are gone (v2.0.0) — only the genuinely
    // source-own recall/store states keep their per-source paths.
    const sourceOwn = ids.filter(id => /^player\.(usb|spotify)\./.test(id));
    expect(sourceOwn.every(id => /\.(preset|presetSave|bookmark)$/.test(id))).toBe(true);
  });

  test("player sources expose station, total/elapsed time, preset and channel metadata", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.station" && e.subunit === "NETRADIO")).toMatchObject({ func: "STATION" });
    expect(cat.find(e => e.id === "player.totalTime" && e.subunit === "SERVER")).toMatchObject({ func: "TOTALTIME" });
    expect(cat.find(e => e.id === "player.elapsedTime" && e.subunit === "USB")).toMatchObject({ func: "ELAPSEDTIME" });
    // Since #613 the per-source preset is a writable recall — genuinely source-own, so
    // it KEEPS its per-source path (v2.0.0).
    expect(cat.find(e => e.id === "player.netRadio.preset")).toMatchObject({
      spec: { kind: "number" },
      write: true,
      writeOnly: true,
    });
  });

  test("the DAB subunit's FM half lands on the flat tuner ids; only DAB detail keeps tuner.dab (v2.0.0)", () => {
    const cat = buildYncaCatalog();
    // The band state says which band the flat values describe — same id as TUN's band.
    expect(cat.find(e => e.id === "tuner.band" && e.subunit === "DAB")).toMatchObject({ func: "BAND" });
    expect(cat.find(e => e.id === "tuner.band" && e.subunit === "DAB")?.spec.kind).toBe("enum");
    // Genuinely DAB-specific detail stays under tuner.dab.
    expect(cat.find(e => e.id === "tuner.dab.serviceLabel")).toMatchObject({
      subunit: "DAB",
      func: "DABSERVICELABEL",
      write: false,
    });
    expect(cat.find(e => e.id === "tuner.dab.dls")?.spec).toEqual({ kind: "text" });
    // The FM frequency reads into the ONE unified kHz state — the MHz wire value is
    // converted on decode, the band-dependent write is controller-routed.
    const dabFreq = cat.find(e => e.id === "tuner.frequency" && e.subunit === "DAB");
    expect(dabFreq).toMatchObject({ func: "FMFREQ", write: true });
    expect(dabFreq?.spec).toMatchObject({ kind: "number", unit: "kHz", decimals: 0 });
    expect(cat.find(e => e.id === "tuner.searchMode" && e.subunit === "DAB")?.spec.kind).toBe("enum");
    // The pre-2.0.0 dab.* FM aliases are gone.
    expect(cat.some(e => e.id.startsWith("tuner.dab.fm"))).toBe(false);
  });

  test("the init sweep asks each function once per subunit", () => {
    const gets = sweepGets(buildYncaCatalog());
    expect(gets).toContainEqual({ subunit: "MAIN", func: "PWR" });
    expect(gets).toContainEqual({ subunit: "ZONE2", func: "VOL" }); // zone prefix doesn't affect sweep
  });

  test("funcToEntry maps a device line (subunit:func) back to its state id", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(map.get("MAIN:PWR")?.id).toBe("power");
    expect(map.get("ZONE2:VOL")?.id).toBe("multiroom.zone2.volume");
  });

  test("idToEntry maps a state write back to its subunit and function", () => {
    expect(idToEntry(buildYncaCatalog()).get("multiroom.zone2.volume")).toMatchObject({
      subunit: "ZONE2",
      func: "VOL",
    });
  });

  test("yncaObjectsFor builds only the objects a device reported", () => {
    const caps: YncaCapabilities = { model: "RX", subunits: { MAIN: { PWR: "On", VOL: "-30.0" } } };
    const objs = yncaObjectsFor(caps);
    const ids = objs.map(o => o.id);
    expect(ids).toContain("power");
    expect(ids).toContain("volume");
    expect(ids).not.toContain("mute"); // not reported
    expect(objs.find(o => o.id === "power")?.common.type).toBe("boolean");
  });

  test("yncaObjectsFor builds a playback object when the device reports PLAYBACKINFO (readFunc, not func)", () => {
    // The device answers the sweep under the readFunc (PLAYBACKINFO); the object must
    // still be created, or the seed writes <source>.playback with no object behind it.
    const caps: YncaCapabilities = { model: "RX", subunits: { SPOTIFY: { PLAYBACKINFO: "Play" } } };
    const ids = yncaObjectsFor(caps).map(o => o.id);
    expect(ids).toContain("player.playback");
  });

  test("a streaming source reporting TRACK (not SONG) still gets a track object (Spotify/Tidal/Deezer)", () => {
    // Spotify/Tidal/Deezer/Pandora answer the title under TRACK, the older sources under SONG;
    // both wire funcs must feed the one `track` state or the title stays empty on the streamers.
    const caps: YncaCapabilities = { model: "RX", subunits: { SPOTIFY: { TRACK: "Yellow" } } };
    expect(yncaObjectsFor(caps).map(o => o.id)).toContain("player.track");
  });

  test("a device line under TRACK decodes to the track state", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "SPOTIFY", func: "TRACK", value: "Yellow" }, map)).toEqual({
      id: "player.track",
      value: "Yellow",
    });
  });

  test("yncaStateUpdate decodes a device line to a typed state via the func map", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "MAIN", func: "PWR", value: "On" }, map)).toEqual({ id: "power", value: true });
    expect(yncaStateUpdate({ subunit: "MAIN", func: "VOL", value: "-30.0" }, map)).toEqual({
      id: "volume",
      value: -30,
    });
    expect(yncaStateUpdate({ subunit: "MAIN", func: "NOPE", value: "x" }, map)).toBeUndefined();
  });

  test("yncaCommand encodes a state write to a subunit/func/value triple via the id map", () => {
    const map = idToEntry(buildYncaCatalog());
    expect(yncaCommand("power", true, map)).toEqual({ subunit: "MAIN", func: "PWR", value: "On" });
    expect(yncaCommand("multiroom.zone2.mute", false, map)).toEqual({ subunit: "ZONE2", func: "MUTE", value: "Off" });
    expect(yncaCommand("nope", 1, map)).toBeUndefined();
    expect(yncaCommand("volume", null, map)).toBeUndefined(); // null is not a valid write
    expect(yncaCommand("volume", "abc", map)).toBeUndefined(); // non-finite number is dropped
  });

  test("every numeric write carries the wire format its YNCA function demands (#612)", () => {
    const map = idToEntry(buildYncaCatalog());
    // Volume needs one fixed decimal — "VOL=-38" is read as tenths by the receiver.
    expect(yncaCommand("volume", -38, map)).toEqual({ subunit: "MAIN", func: "VOL", value: "-38.0" });
    expect(yncaCommand("multiroom.zone2.volume", -21.5, map)).toEqual({
      subunit: "ZONE2",
      func: "VOL",
      value: "-21.5",
    });
    expect(yncaCommand("multiroom.zoneB.volume", -30, map)).toEqual({
      subunit: "MAIN",
      func: "ZONEBVOL",
      value: "-30.0",
    });
    // In the STATIC map the newer tone dialect wins (TONEBASS is listed after SPBASS);
    // the per-device dialect choice has its own test below.
    expect(yncaCommand("sound.bass", 3, map)).toEqual({ subunit: "MAIN", func: "TONEBASS", value: "3.0" });
    expect(yncaCommand("sound.headphoneTreble", -2.5, map)).toEqual({
      subunit: "MAIN",
      func: "HPTREBLE",
      value: "-2.5",
    });
    expect(yncaCommand("advanced.initialVolume.level", -45, map)).toEqual({
      subunit: "MAIN",
      func: "INITVOLLVL",
      value: "-45.0",
    });
    // Max volume steps in 5 dB — except the literal ceiling 16.5, which is valid as-is.
    expect(yncaCommand("advanced.maxVolume", -20, map)).toEqual({ subunit: "MAIN", func: "MAXVOL", value: "-20.0" });
    expect(yncaCommand("advanced.maxVolume", 16.5, map)).toEqual({ subunit: "MAIN", func: "MAXVOL", value: "16.5" });
    // The unified tuner.frequency write (v2.0.0) is band-routed by the controller
    // (AMFREQ whole kHz / FMFREQ MHz with two decimals) BEFORE this generic path —
    // its wire formats are asserted in the device-controller tests. Reads convert
    // both wire forms into the ONE kHz state:
    const funcs = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "TUN", func: "FMFREQ", value: "98.10" }, funcs)).toEqual({
      id: "tuner.frequency",
      value: 98100,
    });
    expect(yncaStateUpdate({ subunit: "TUN", func: "AMFREQ", value: "1440" }, funcs)).toEqual({
      id: "tuner.frequency",
      value: 1440,
    });
    // Lip-sync offsets are whole milliseconds.
    expect(yncaCommand("hdmi.lipSyncOut1", 12.6, map)).toEqual({
      subunit: "MAIN",
      func: "LIPSYNCHDMIOUT1OFFSET",
      value: "13",
    });
    // Scene recall rounds a stray fraction instead of sending "Scene 2.7".
    expect(yncaCommand("scene.recall", 2.7, map)).toEqual({ subunit: "MAIN", func: "SCENE", value: "Scene 3" });
  });

  test("the stored-station surface (#613): tuner preset read/write, up/down, source recall", () => {
    const map = idToEntry(buildYncaCatalog());
    // Recall by number goes out as a bare integer on the device's own tuner subunit —
    // the per-device write map picks TUN here (a DAB device is controller-routed).
    const tunOnly: YncaCapabilities = { model: "RX-V473", subunits: { TUN: { PRESET: "1" } } };
    expect(yncaCommand("tuner.preset", 7, idToEntry(presentYncaEntries(tunOnly)))).toEqual({
      subunit: "TUN",
      func: "PRESET",
      value: "7",
    });
    expect(yncaCommand("tuner.presetUp", true, map)).toEqual({ subunit: "TUN", func: "PRESET", value: "Up" });
    expect(yncaCommand("tuner.presetDown", true, map)).toEqual({ subunit: "TUN", func: "PRESET", value: "Down" });
    // Favourite recall exists on the preset-capable sources only (ynca spec mixins).
    expect(yncaCommand("player.netRadio.preset", 3, map)).toEqual({ subunit: "NETRADIO", func: "PRESET", value: "3" });
    expect(yncaCommand("player.usb.preset", 12, map)).toEqual({ subunit: "USB", func: "PRESET", value: "12" });
    expect(yncaCommand("player.spotify.preset", 3, map)).toBeUndefined();
    // DAB recalls live on the SAME unified tuner.preset id (v2.0.0) — DABPRESET and
    // FMPRESET are both writable; the band-dependent pick is controller-routed.
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.subunit === "DAB" && e.func === "DABPRESET")).toMatchObject({
      id: "tuner.preset",
      write: true,
    });
    expect(cat.find(e => e.subunit === "DAB" && e.func === "FMPRESET")).toMatchObject({
      id: "tuner.preset",
      write: true,
    });
  });

  test("a reported preset lands as its number; the 'No Preset' sentinel becomes 0", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "TUN", func: "PRESET", value: "1" }, map)).toEqual({
      id: "tuner.preset",
      value: 1,
    });
    expect(yncaStateUpdate({ subunit: "TUN", func: "PRESET", value: "No Preset" }, map)).toEqual({
      id: "tuner.preset",
      value: 0,
    });
    // The DAB subunit's presets report into the SAME unified id (v2.0.0).
    expect(yncaStateUpdate({ subunit: "DAB", func: "DABPRESET", value: "No Preset" }, map)).toEqual({
      id: "tuner.preset",
      value: 0,
    });
    expect(yncaStateUpdate({ subunit: "DAB", func: "FMPRESET", value: "4" }, map)).toEqual({
      id: "tuner.preset",
      value: 4,
    });
  });

  test("the catalog covers sound, HDMI, DSP and global (SYS/TUN) functions", () => {
    const cat = buildYncaCatalog();
    const ids = cat.map(e => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "sound.bass",
        "sound.treble",
        "hdmi.output",
        "sound.surroundAI",
        "multiroom.party",
        "tuner.band",
      ]),
    );
    expect(cat.find(e => e.id === "multiroom.party")).toMatchObject({ subunit: "SYS", func: "PARTY" });
    expect(cat.find(e => e.id === "tuner.band")).toMatchObject({ subunit: "TUN", func: "BAND" });
    expect(cat.find(e => e.id === "multiroom.zone2.sound.bass")).toMatchObject({ subunit: "ZONE2", func: "SPBASS" });
  });

  test("every player source reports into the ONE flat block; only source-own states keep their path", () => {
    const cat = buildYncaCatalog();
    // One entry per (source, function) — all on the flat id.
    expect(cat.filter(e => e.id === "player.artist").map(e => e.subunit)).toContain("NETRADIO");
    expect(cat.filter(e => e.id === "player.playback").map(e => e.subunit)).toContain("SPOTIFY");
    expect(cat.filter(e => e.id === "player.track").map(e => e.subunit)).toContain("USB");
    expect(cat.filter(e => e.id === "player.repeat").map(e => e.subunit)).toContain("SERVER");
    // Source-own states stay per source; the old per-source playback copies are gone.
    expect(cat.some(e => e.id === "player.netRadio.preset")).toBe(true);
    expect(cat.some(e => e.id === "player.spotify.playback")).toBe(false);
  });

  test("every channel the catalog creates has a curated display name (no raw-id fallback)", () => {
    const segments = new Set<string>();
    for (const entry of buildYncaCatalog()) {
      const parts = entry.id.split(".");
      for (let i = 1; i < parts.length; i++) {
        segments.add(parts[i - 1]);
      }
    }
    const uncurated = [...segments].filter(segment => !(segment in CHANNEL_NAMES));
    expect(uncurated).toEqual([]);
  });
});

describe("official-command-list additions (2026-08-25)", () => {
  const cat = buildYncaCatalog();
  const ids = idToEntry(cat);

  test("tuner preset store: a slot number goes out verbatim, 0 becomes Auto", () => {
    expect(yncaCommand("tuner.presetSave", 7, ids)).toEqual({ subunit: "TUN", func: "MEM", value: "7" });
    expect(yncaCommand("tuner.presetSave", 0, ids)).toEqual({ subunit: "TUN", func: "MEM", value: "Auto" });
  });

  test("player preset store exists on the MEM-capable sources only", () => {
    expect(yncaCommand("player.netRadio.presetSave", 3, ids)).toEqual({
      subunit: "NETRADIO",
      func: "MEM",
      value: "3",
    });
    expect(ids.get("player.usb.presetSave")).toBeDefined();
    expect(ids.get("player.spotify.presetSave")).toBeUndefined();
  });

  test("net-radio bookmark writes On/Off and never reads back", () => {
    expect(yncaCommand("player.netRadio.bookmark", true, ids)).toEqual({
      subunit: "NETRADIO",
      func: "BOOKMARK",
      value: "On",
    });
    const entry = ids.get("player.netRadio.bookmark");
    expect(entry?.writeOnly).toBe(true);
  });

  test("bluetooth: connect switch, pairing buttons, connected indicator", () => {
    expect(yncaCommand("player.bluetooth.connect", true, ids)).toEqual({
      subunit: "BT",
      func: "CONNECT",
      value: "Connect",
    });
    expect(yncaCommand("player.bluetooth.pairing", true, ids)).toEqual({
      subunit: "BT",
      func: "PAIRING",
      value: "Start",
    });
    expect(yncaCommand("player.bluetooth.pairingCancel", true, ids)).toEqual({
      subunit: "BT",
      func: "PAIRING",
      value: "Cancel",
    });
    expect(yncaStateUpdate({ subunit: "BT", func: "CONNECTINFO", value: "Connected" }, funcToEntry(cat))).toEqual({
      id: "player.bluetooth.connected",
      value: true,
    });
  });

  test("tuner FM mode, tuned and stereo indicators decode from the wire", () => {
    const funcs = funcToEntry(cat);
    expect(yncaStateUpdate({ subunit: "TUN", func: "FMMODE", value: "Mono" }, funcs)).toEqual({
      id: "tuner.fmMode",
      value: "Mono",
    });
    expect(yncaStateUpdate({ subunit: "TUN", func: "TUNED", value: "Assert" }, funcs)).toEqual({
      id: "tuner.tuned",
      value: true,
    });
    expect(yncaStateUpdate({ subunit: "TUN", func: "SIGSTEREOMONO", value: "Negate" }, funcs)).toEqual({
      id: "tuner.stereo",
      value: false,
    });
  });

  test("adaptive DSP is a MAIN-only sound state with the Off/Auto value set", () => {
    const entry = ids.get("sound.adaptiveDsp");
    expect(entry?.subunit).toBe("MAIN");
    expect(yncaCommand("sound.adaptiveDsp", "Auto", ids)).toEqual({
      subunit: "MAIN",
      func: "ADAPTIVEDSP",
      value: "Auto",
    });
  });

  test("the per-device write map speaks each generation's tone dialect (SPBASS vs TONEBASS)", () => {
    // A classic receiver reports SPBASS; the MusicCast generation reports TONEBASS
    // (RX-V6A full sweep, 2026-09-01). The write must use the function THIS device
    // answered — a fixed table would send the wrong generation's command.
    const classic: YncaCapabilities = { model: "RX-V473", subunits: { MAIN: { SPBASS: "3.0" } } };
    const classicMap = idToEntry(presentYncaEntries(classic));
    expect(yncaCommand("sound.bass", 3, classicMap)).toEqual({ subunit: "MAIN", func: "SPBASS", value: "3.0" });

    const musiccast: YncaCapabilities = { model: "RX-V6A", subunits: { MAIN: { TONEBASS: "0.0" } } };
    const musiccastMap = idToEntry(presentYncaEntries(musiccast));
    expect(yncaCommand("sound.bass", 3, musiccastMap)).toEqual({ subunit: "MAIN", func: "TONEBASS", value: "3.0" });

    // A function the device never reported is not writable at all (claim with proof).
    expect(yncaCommand("sound.treble", 1, classicMap)).toBeUndefined();
  });

  test("the RX-V6A sweep's newly mapped functions decode to their states", () => {
    const funcs = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "MAIN", func: "TONEBASS", value: "0.0" }, funcs)).toEqual({
      id: "sound.bass",
      value: 0,
    });
    expect(yncaStateUpdate({ subunit: "ZONE2", func: "TONETREBLE", value: "-1.5" }, funcs)).toEqual({
      id: "multiroom.zone2.sound.treble",
      value: -1.5,
    });
    expect(yncaStateUpdate({ subunit: "MAIN", func: "DIALOGUELVL", value: "2" }, funcs)).toEqual({
      id: "sound.dialogueLevel",
      value: 2,
    });
    expect(yncaStateUpdate({ subunit: "AIRPLAY", func: "VOLINTERLOCK", value: "Limited" }, funcs)).toEqual({
      id: "player.airplay.volumeInterlock",
      value: "Limited",
    });
    expect(yncaStateUpdate({ subunit: "BT", func: "DEVICENAME", value: "Pixel" }, funcs)).toEqual({
      id: "player.bluetooth.deviceName",
      value: "Pixel",
    });
    expect(yncaStateUpdate({ subunit: "DAB", func: "DABOFFAIR", value: "Negate" }, funcs)).toEqual({
      id: "tuner.dab.offAir",
      value: false,
    });
    expect(yncaStateUpdate({ subunit: "SYS", func: "YNCAPORT", value: "50000" }, funcs)).toEqual({
      id: "advanced.yncaPort",
      value: 50000,
    });
    // The port is deliberately read-only — writing it would cut this very connection.
    expect(yncaCommand("advanced.yncaPort", 50001, idToEntry(buildYncaCatalog()))).toBeUndefined();
    // Speaker-pattern amp assign and the trigger level write with their documented enums.
    expect(yncaCommand("advanced.speakers.pattern1Amp", "5ch BI-AMP", idToEntry(buildYncaCatalog()))).toEqual({
      subunit: "SYS",
      func: "SPPATTERN1AMP",
      value: "5ch BI-AMP",
    });
    expect(yncaCommand("advanced.trigger1Manual", "Lo", idToEntry(buildYncaCatalog()))).toEqual({
      subunit: "SYS",
      func: "TRIG1MANUAL",
      value: "Lo",
    });
  });
});

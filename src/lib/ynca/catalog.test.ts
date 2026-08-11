import {
  buildYncaCatalog,
  funcToEntry,
  idToEntry,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
} from "./catalog";
import { CHANNEL_NAMES } from "../catalog/types";
import type { EnumSpec } from "../catalog/value-coerce";
import type { YncaCapabilities } from "./capability";

describe("YNCA catalog", () => {
  test("a MAIN amplifier function becomes a top-level state carrying its YNCA function", () => {
    const power = buildYncaCatalog().find(e => e.id === "power");
    expect(power).toMatchObject({ subunit: "MAIN", func: "PWR", write: true, role: "switch.power" });
    expect(power?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
  });

  test("each additional zone gets its own prefixed states", () => {
    expect(buildYncaCatalog().find(e => e.id === "zone2.volume")).toMatchObject({ subunit: "ZONE2", func: "VOL" });
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
    expect(cat.find(e => e.id === "extraBass")).toMatchObject({ subunit: "MAIN", func: "EXBASS" });
    expect(cat.find(e => e.id === "extraBass")?.spec).toEqual({ kind: "onoff", on: "Auto", off: "Off" });
    expect(cat.find(e => e.id === "zone2.extraBass")).toMatchObject({ subunit: "ZONE2", func: "EXBASS" });
  });

  test("max volume and initial volume level are numbers with a dB unit", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "maxVolume")).toMatchObject({ subunit: "MAIN", func: "MAXVOL" });
    expect(cat.find(e => e.id === "maxVolume")?.spec).toMatchObject({ kind: "number", unit: "dB" });
    expect(cat.find(e => e.id === "initialVolume.level")?.spec).toMatchObject({ kind: "number", unit: "dB" });
  });

  test("lip-sync offsets are numbers in ms", () => {
    expect(buildYncaCatalog().find(e => e.id === "lipSync.hdmiOut1")?.spec).toMatchObject({
      kind: "number",
      unit: "ms",
    });
  });

  test("3D Cinema DSP keeps its wire function name 3DCINEMA", () => {
    expect(buildYncaCatalog().find(e => e.id === "cinemaDsp3d")).toMatchObject({ func: "3DCINEMA", subunit: "MAIN" });
  });

  test("Zone B and speaker A/B functions exist on MAIN only", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "zoneB.volume")).toMatchObject({ subunit: "MAIN", func: "ZONEBVOL" });
    expect(cat.find(e => e.id === "zone2.zoneB.volume")).toBeUndefined();
    expect(cat.find(e => e.id === "speakerA")).toMatchObject({ subunit: "MAIN", func: "SPEAKERA" });
    expect(cat.find(e => e.id === "zoneB.power")?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
  });

  test("scene names are read-only text on MAIN (1..12)", () => {
    const cat = buildYncaCatalog();
    const s1 = cat.find(e => e.id === "scene.name1");
    expect(s1).toMatchObject({ subunit: "MAIN", func: "SCENE1NAME", write: false });
    expect(s1?.spec).toEqual({ kind: "text" });
    expect(cat.find(e => e.id === "scene.name12")).toMatchObject({ func: "SCENE12NAME" });
  });

  test("scene recall triggers a scene: writable 1..12, encodes to 'Scene N', write-only, gated on scene names", () => {
    const cat = buildYncaCatalog();
    const recall = cat.find(e => e.id === "scene.recall");
    expect(recall).toMatchObject({ subunit: "MAIN", func: "SCENE", write: true });
    expect(recall?.spec).toMatchObject({ kind: "number", min: 1, max: 12 });
    // encodes the plain number to the YNCA wire value "Scene N" (ynca lib: _put("SCENE", f"Scene {id}"))
    expect(yncaCommand("scene.recall", 3, idToEntry(cat))).toEqual({ subunit: "MAIN", func: "SCENE", value: "Scene 3" });
    // write-only: a SCENE1NAME device push must still map to the name state, not the recall
    expect(funcToEntry(cat).get("MAIN:SCENE1NAME")?.id).toBe("scene.name1");
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
    expect(cat.find(e => e.id === "masterPower")?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
    expect(cat.find(e => e.id === "hdmi.out1")?.spec).toEqual({ kind: "onoff", on: "On", off: "Off" });
    expect(cat.find(e => e.id === "speakers.pattern")?.spec.kind).toBe("enum");
  });

  test("all 23 input names are read-only text states on SYS", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "inputNames.hdmi1")).toMatchObject({
      subunit: "SYS",
      func: "INPNAMEHDMI1",
      write: false,
    });
    expect(cat.filter(e => e.id.startsWith("inputNames.")).length).toBe(23);
  });

  test("the AM/FM tuner is complete: RDS text B, program type and search mode", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "tuner.rdsTextB")).toMatchObject({ subunit: "TUN", func: "RDSTXTB", write: false });
    expect(cat.find(e => e.id === "tuner.rdsProgramType")?.spec).toEqual({ kind: "text" });
    expect(cat.find(e => e.id === "tuner.searchMode")?.spec.kind).toBe("enum");
  });

  test("playback reads from PLAYBACKINFO but writes to PLAYBACK", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "spotify.playback")).toMatchObject({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      write: true,
    });
    expect(sweepGets(cat)).toContainEqual({ subunit: "SPOTIFY", func: "PLAYBACKINFO" });
    expect(funcToEntry(cat).get("SPOTIFY:PLAYBACKINFO")?.id).toBe("spotify.playback");
  });

  test("playback offers skip forward/back as writable values (the ynca lib Playback enum has them)", () => {
    const cat = buildYncaCatalog();
    const states = (cat.find(e => e.id === "spotify.playback")?.spec as EnumSpec).states;
    expect(states).toHaveProperty("Skip Fwd");
    expect(states).toHaveProperty("Skip Rev");
    expect(yncaCommand("spotify.playback", "Skip Fwd", idToEntry(cat))).toEqual({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      value: "Skip Fwd",
    });
  });

  test("player sources expose station, total/elapsed time, preset and channel metadata", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "netRadio.station")).toMatchObject({ subunit: "NETRADIO", func: "STATION" });
    expect(cat.find(e => e.id === "server.totalTime")).toMatchObject({ subunit: "SERVER", func: "TOTALTIME" });
    expect(cat.find(e => e.id === "usb.elapsedTime")).toMatchObject({ subunit: "USB", func: "ELAPSEDTIME" });
    expect(cat.find(e => e.id === "netRadio.preset")?.spec).toEqual({ kind: "text" });
  });

  test("the DAB tuner is catalogued as its own DAB subunit under a dab channel", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "dab.band")).toMatchObject({ subunit: "DAB", func: "BAND" });
    expect(cat.find(e => e.id === "dab.band")?.spec.kind).toBe("enum");
    expect(cat.find(e => e.id === "dab.serviceLabel")).toMatchObject({
      subunit: "DAB",
      func: "DABSERVICELABEL",
      write: false,
    });
    expect(cat.find(e => e.id === "dab.dls")?.spec).toEqual({ kind: "text" });
    expect(cat.find(e => e.id === "dab.fmFrequency")?.spec).toMatchObject({ kind: "number", unit: "kHz" });
    expect(cat.find(e => e.id === "dab.fmSearchMode")?.spec.kind).toBe("enum");
  });

  test("the init sweep asks each function once per subunit", () => {
    const gets = sweepGets(buildYncaCatalog());
    expect(gets).toContainEqual({ subunit: "MAIN", func: "PWR" });
    expect(gets).toContainEqual({ subunit: "ZONE2", func: "VOL" });
  });

  test("funcToEntry maps a device line (subunit:func) back to its state id", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(map.get("MAIN:PWR")?.id).toBe("power");
    expect(map.get("ZONE2:VOL")?.id).toBe("zone2.volume");
  });

  test("idToEntry maps a state write back to its subunit and function", () => {
    expect(idToEntry(buildYncaCatalog()).get("zone2.volume")).toMatchObject({ subunit: "ZONE2", func: "VOL" });
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
    expect(ids).toContain("spotify.playback");
  });

  test("a streaming source reporting TRACK (not SONG) still gets a track object (Spotify/Tidal/Deezer)", () => {
    // Spotify/Tidal/Deezer/Pandora answer the title under TRACK, the older sources under SONG;
    // both wire funcs must feed the one `track` state or the title stays empty on the streamers.
    const caps: YncaCapabilities = { model: "RX", subunits: { SPOTIFY: { TRACK: "Yellow" } } };
    expect(yncaObjectsFor(caps).map(o => o.id)).toContain("spotify.track");
  });

  test("a device line under TRACK decodes to the track state", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "SPOTIFY", func: "TRACK", value: "Yellow" }, map)).toEqual({
      id: "spotify.track",
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
    expect(yncaCommand("zone2.mute", false, map)).toEqual({ subunit: "ZONE2", func: "MUTE", value: "Off" });
    expect(yncaCommand("nope", 1, map)).toBeUndefined();
    expect(yncaCommand("volume", null, map)).toBeUndefined(); // null is not a valid write
    expect(yncaCommand("volume", "abc", map)).toBeUndefined(); // non-finite number is dropped
  });

  test("the catalog covers sound, HDMI, DSP and global (SYS/TUN) functions", () => {
    const cat = buildYncaCatalog();
    const ids = cat.map(e => e.id);
    expect(ids).toEqual(
      expect.arrayContaining(["sound.bass", "sound.treble", "hdmi.output", "surroundAI", "party", "tuner.band"]),
    );
    expect(cat.find(e => e.id === "party")).toMatchObject({ subunit: "SYS", func: "PARTY" });
    expect(cat.find(e => e.id === "tuner.band")).toMatchObject({ subunit: "TUN", func: "BAND" });
    expect(cat.find(e => e.id === "zone2.sound.bass")).toMatchObject({ subunit: "ZONE2", func: "SPBASS" });
  });

  test("player sources carry the shared playback functions under their channel", () => {
    const cat = buildYncaCatalog();
    const ids = cat.map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining(["netRadio.artist", "spotify.playback", "usb.track", "server.repeat"]));
    expect(cat.find(e => e.id === "spotify.playback")).toMatchObject({ subunit: "SPOTIFY", func: "PLAYBACK" });
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

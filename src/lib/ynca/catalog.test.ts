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
import { capabilitiesFromLines as parseCapabilities } from "./__fixtures__/capabilities-from-lines";
import rxA810 from "./__fixtures__/RX-A810.json";

describe("YNCA catalog", () => {
  test("a MAIN amplifier function becomes a top-level state carrying its YNCA function", () => {
    const power = buildYncaCatalog().find(e => e.id === "power");
    expect(power).toMatchObject({ subunit: "MAIN", func: "PWR", write: true, role: "switch.power" });
    expect(power?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
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
    expect(buildYncaCatalog().find(e => e.id === "lipSync.hdmiOut1")?.spec).toMatchObject({
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
    expect(cat.find(e => e.id === "advanced.speakerA")).toMatchObject({ subunit: "MAIN", func: "SPEAKERA" });
    expect(cat.find(e => e.id === "multiroom.zoneB.power")?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
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
    expect(yncaCommand("scene.recall", 3, idToEntry(cat))).toEqual({
      subunit: "MAIN",
      func: "SCENE",
      value: "Scene 3",
    });
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

  test("playback reads from PLAYBACKINFO but writes to PLAYBACK", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.spotify.playback")).toMatchObject({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      write: true,
    });
    expect(sweepGets(cat)).toContainEqual({ subunit: "SPOTIFY", func: "PLAYBACKINFO" });
    expect(funcToEntry(cat).get("SPOTIFY:PLAYBACKINFO")?.id).toBe("player.spotify.playback");
  });

  test("playback is a numeric media.state coded from PLAYBACKINFO (Play=0)", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.spotify.playback")?.role).toBe("media.state");
    expect(yncaStateUpdate({ subunit: "SPOTIFY", func: "PLAYBACKINFO", value: "Play" }, funcToEntry(cat))).toEqual({
      id: "player.spotify.playback",
      value: 0,
    });
    expect(yncaCommand("player.spotify.playback", 0, idToEntry(cat))).toEqual({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      value: "Play",
    });
  });

  test("track skip is exposed as next/prev buttons that put Skip Fwd/Rev on PLAYBACK", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.spotify.next")?.role).toBe("button.next");
    expect(cat.find(e => e.id === "player.spotify.prev")?.role).toBe("button.prev");
    expect(yncaCommand("player.spotify.next", true, idToEntry(cat))).toEqual({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      value: "Skip Fwd",
    });
    expect(yncaCommand("player.spotify.prev", true, idToEntry(cat))).toEqual({
      subunit: "SPOTIFY",
      func: "PLAYBACK",
      value: "Skip Rev",
    });
  });

  test("next/prev buttons are CREATED for a real device (which reports only PLAYBACKINFO)", () => {
    // Regression: gating the buttons on their write function PLAYBACK created them on no
    // real device — every fixture answers only PLAYBACKINFO. Object creation, not just the
    // catalog entry, must be verified against real device responses.
    const capabilities = parseCapabilities(rxA810 as string[]);
    const ids = yncaObjectsFor(capabilities).map(object => object.id);
    expect(ids).toContain("player.usb.playback");
    expect(ids).toContain("player.usb.next");
    expect(ids).toContain("player.usb.prev");
    // A source the device does not report gets none of the three.
    expect(ids).not.toContain("player.spotify.playback");
    expect(ids).not.toContain("player.spotify.next");
  });

  test("player sources expose station, total/elapsed time, preset and channel metadata", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "player.netRadio.station")).toMatchObject({ subunit: "NETRADIO", func: "STATION" });
    expect(cat.find(e => e.id === "player.server.totalTime")).toMatchObject({ subunit: "SERVER", func: "TOTALTIME" });
    expect(cat.find(e => e.id === "player.usb.elapsedTime")).toMatchObject({ subunit: "USB", func: "ELAPSEDTIME" });
    // Since #613 the per-source preset is a writable recall (was a dead read-only text).
    expect(cat.find(e => e.id === "player.netRadio.preset")).toMatchObject({
      spec: { kind: "number" },
      write: true,
      writeOnly: true,
    });
  });

  test("the DAB tuner is catalogued as its own DAB subunit under a dab channel", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "tuner.dab.band")).toMatchObject({ subunit: "DAB", func: "BAND" });
    expect(cat.find(e => e.id === "tuner.dab.band")?.spec.kind).toBe("enum");
    expect(cat.find(e => e.id === "tuner.dab.serviceLabel")).toMatchObject({
      subunit: "DAB",
      func: "DABSERVICELABEL",
      write: false,
    });
    expect(cat.find(e => e.id === "tuner.dab.dls")?.spec).toEqual({ kind: "text" });
    // MHz, not kHz: every device fixture reports "FMFREQ=98.10"-style megahertz values.
    expect(cat.find(e => e.id === "tuner.dab.fmFrequency")?.spec).toMatchObject({
      kind: "number",
      unit: "MHz",
      decimals: 2,
    });
    expect(cat.find(e => e.id === "tuner.dab.fmSearchMode")?.spec.kind).toBe("enum");
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
    expect(ids).toContain("player.spotify.playback");
  });

  test("a streaming source reporting TRACK (not SONG) still gets a track object (Spotify/Tidal/Deezer)", () => {
    // Spotify/Tidal/Deezer/Pandora answer the title under TRACK, the older sources under SONG;
    // both wire funcs must feed the one `track` state or the title stays empty on the streamers.
    const caps: YncaCapabilities = { model: "RX", subunits: { SPOTIFY: { TRACK: "Yellow" } } };
    expect(yncaObjectsFor(caps).map(o => o.id)).toContain("player.spotify.track");
  });

  test("a device line under TRACK decodes to the track state", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(yncaStateUpdate({ subunit: "SPOTIFY", func: "TRACK", value: "Yellow" }, map)).toEqual({
      id: "player.spotify.track",
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
    expect(yncaCommand("sound.bass", 3, map)).toEqual({ subunit: "MAIN", func: "SPBASS", value: "3.0" });
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
    // FM frequency is MHz with two fixed decimals; AM stays a whole kHz count.
    expect(yncaCommand("tuner.fmFrequency", 98.1, map)).toEqual({ subunit: "TUN", func: "FMFREQ", value: "98.10" });
    expect(yncaCommand("tuner.amFrequency", 1440, map)).toEqual({ subunit: "TUN", func: "AMFREQ", value: "1440" });
    // Lip-sync offsets are whole milliseconds.
    expect(yncaCommand("lipSync.hdmiOut1", 12.6, map)).toEqual({
      subunit: "MAIN",
      func: "LIPSYNCHDMIOUT1OFFSET",
      value: "13",
    });
    // Scene recall rounds a stray fraction instead of sending "Scene 2.7".
    expect(yncaCommand("scene.recall", 2.7, map)).toEqual({ subunit: "MAIN", func: "SCENE", value: "Scene 3" });
  });

  test("the stored-station surface (#613): tuner preset read/write, up/down, source recall", () => {
    const map = idToEntry(buildYncaCatalog());
    // Recall by number goes out as a bare integer; up/down as the wire words.
    expect(yncaCommand("tuner.preset", 7, map)).toEqual({ subunit: "TUN", func: "PRESET", value: "7" });
    expect(yncaCommand("tuner.presetUp", true, map)).toEqual({ subunit: "TUN", func: "PRESET", value: "Up" });
    expect(yncaCommand("tuner.presetDown", true, map)).toEqual({ subunit: "TUN", func: "PRESET", value: "Down" });
    // Favourite recall exists on the preset-capable sources only (ynca spec mixins).
    expect(yncaCommand("player.netRadio.preset", 3, map)).toEqual({ subunit: "NETRADIO", func: "PRESET", value: "3" });
    expect(yncaCommand("player.usb.preset", 12, map)).toEqual({ subunit: "USB", func: "PRESET", value: "12" });
    expect(yncaCommand("player.spotify.preset", 3, map)).toBeUndefined();
    // DAB presets are writable recalls too.
    expect(yncaCommand("tuner.dab.preset", 2, map)).toEqual({ subunit: "DAB", func: "DABPRESET", value: "2" });
    expect(yncaCommand("tuner.dab.fmPreset", 4, map)).toEqual({ subunit: "DAB", func: "FMPRESET", value: "4" });
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
    expect(yncaStateUpdate({ subunit: "DAB", func: "DABPRESET", value: "No Preset" }, map)).toEqual({
      id: "tuner.dab.preset",
      value: 0,
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

  test("player sources carry the shared playback functions under their channel", () => {
    const cat = buildYncaCatalog();
    const ids = cat.map(e => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "player.netRadio.artist",
        "player.spotify.playback",
        "player.usb.track",
        "player.server.repeat",
      ]),
    );
    expect(cat.find(e => e.id === "player.spotify.playback")).toMatchObject({ subunit: "SPOTIFY", func: "PLAYBACK" });
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
    expect(
      yncaStateUpdate({ subunit: "BT", func: "CONNECTINFO", value: "Connected" }, funcToEntry(cat)),
    ).toEqual({ id: "player.bluetooth.connected", value: true });
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
});

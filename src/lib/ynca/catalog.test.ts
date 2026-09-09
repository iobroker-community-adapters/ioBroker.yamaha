import {
  availGets,
  buildYncaCatalog,
  bundleGets,
  deviceInputStates,
  enumStatesFor,
  funcToEntry,
  idToEntry,
  presentYncaEntries,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
  type YncaEntry,
} from "./catalog";
import { CHANNEL_NAME_KEYS } from "../catalog/types";
import { catalogToObjects } from "../catalog/build-objects";
import type { EnumSpec } from "../catalog/value-coerce";
import type { YncaCapabilities } from "./capability";
import { capabilitiesFromLines as parseCapabilities } from "./__fixtures__/capabilities-from-lines";
import rxA810 from "./__fixtures__/RX-A810.json";
import { YNCA_BROWSE_SOURCES } from "../browse/ynca-browse-driver";

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

  test("all 29 input names are read-only text states on SYS", () => {
    const cat = buildYncaCatalog();
    expect(cat.find(e => e.id === "advanced.inputNames.hdmi1")).toMatchObject({
      subunit: "SYS",
      func: "INPNAMEHDMI1",
      write: false,
    });
    // 29 since the 2026-09-06 audit: an RX-V583 protocol answers INPNAME for the network and
    // system sources too (TUNER, AUX, SERVER, NET RADIO, MusicCast Link, Bluetooth), which the
    // physical-inputs-only list did not carry — a user who renamed those saw nothing.
    expect(cat.filter(e => e.id.startsWith("advanced.inputNames.")).length).toBe(29);
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

  test("the playback times are seconds, with the readable form beside them", () => {
    // The wire carries "1:23"; the datapoint the media player binds to needs seconds, and
    // the readable form is a second datapoint fed from the same answer. Before this, YNCA
    // published only the text — so the player had no time at all on a YNCA-only receiver,
    // and the datapoint's TYPE depended on which protocol answered.
    const cat = buildYncaCatalog().filter(e => e.subunit === "NETRADIO");
    const elapsed = cat.find(e => e.id === "player.elapsedTime");
    expect(elapsed).toMatchObject({ role: "media.elapsed", write: false });
    expect(elapsed?.spec).toMatchObject({ kind: "number", unit: "s" });
    const text = cat.find(e => e.id === "player.elapsedTimeText");
    expect(text).toMatchObject({ role: "media.elapsed.text", derived: true });

    const map = funcToEntry(cat);
    // The derived twin shares the wire function, so it must NOT displace its source in the
    // device→state map (that map is keyed SUBUNIT:FUNC — last one in wins).
    expect(map.get("NETRADIO:ELAPSEDTIME")?.id).toBe("player.elapsedTime");
    expect(yncaStateUpdate({ subunit: "NETRADIO", func: "ELAPSEDTIME", value: "1:23" }, map)).toEqual({
      id: "player.elapsedTime",
      value: 83,
    });
    expect(yncaStateUpdate({ subunit: "NETRADIO", func: "TOTALTIME", value: "1:02:03" }, map)).toEqual({
      id: "player.totalTime",
      value: 3723,
    });
    // A stopped source answers with a placeholder — that is no time, so no value is written.
    expect(yncaStateUpdate({ subunit: "NETRADIO", func: "ELAPSEDTIME", value: "--:--" }, map)).toBeUndefined();
    expect(yncaStateUpdate({ subunit: "NETRADIO", func: "ELAPSEDTIME", value: "" }, map)).toBeUndefined();
  });

  test("each assignable input name carries the input it names", () => {
    // All of them used to read "Input names" — the folder's own label — so the object tree
    // showed a folder and its children with one and the same text.
    const named = buildYncaCatalog().filter(e => e.id.startsWith("advanced.inputNames."));
    expect(named).toHaveLength(29);
    const objects = catalogToObjects(named).filter(o => o.type === "state");
    const english = objects.map(o => (o.common.name as Record<string, string>).en);
    expect(new Set(english).size).toBe(29);
    expect(english).toContain("Input name (HDMI1)");
    // The two that are not simply the upper-cased key follow the device's own spelling.
    expect(english).toContain("Input name (V-AUX)");
    expect(english).toContain("Input name (MULTI CH)");
    expect(english).toContain("Input name (MusicCast Link)");
    expect(english).toContain("Input name (NET RADIO)");
  });

  test("a coded write accepts the number as text, and still refuses junk", () => {
    // ioBroker lets anything write a state: a VIS widget or a script may send "0" for a
    // numeric coded state. That has to reach the device as its command word, while a
    // null/empty/non-numeric write stays dropped.
    const map = idToEntry(buildYncaCatalog().filter(e => e.subunit === "NETRADIO"));
    expect(yncaCommand("player.playback", 0, map)).toMatchObject({ func: "PLAYBACK", value: "Play" });
    expect(yncaCommand("player.playback", "0", map)).toMatchObject({ func: "PLAYBACK", value: "Play" });
    expect(yncaCommand("player.repeat", "2", map)).toMatchObject({ func: "REPEAT", value: "All" });
    expect(yncaCommand("player.playback", null, map)).toBeUndefined();
    expect(yncaCommand("player.playback", "", map)).toBeUndefined();
    expect(yncaCommand("player.playback", "abc", map)).toBeUndefined();
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
    // The up/down keys share their ids with DAB and HD Radio; the per-device map of a classic
    // receiver hands them to TUN (the static map's last entry is the HD Radio one since 2026-09-09).
    const classic = idToEntry(presentYncaEntries({ model: "RX-V473", subunits: { TUN: { PRESET: "1" } } }));
    expect(yncaCommand("tuner.presetUp", true, classic)).toEqual({ subunit: "TUN", func: "PRESET", value: "Up" });
    expect(yncaCommand("tuner.presetDown", true, classic)).toEqual({ subunit: "TUN", func: "PRESET", value: "Down" });
    // Favourite recall exists on the preset-capable sources only (ynca spec mixins).
    expect(yncaCommand("player.netRadio.preset", 3, map)).toEqual({ subunit: "NETRADIO", func: "PRESET", value: "3" });
    expect(yncaCommand("player.usb.preset", 12, map)).toEqual({ subunit: "USB", func: "PRESET", value: "12" });
    expect(yncaCommand("player.spotify.preset", 3, map)).toEqual({ subunit: "SPOTIFY", func: "PRESET", value: "3" });
    expect(yncaCommand("player.deezer.preset", 3, map)).toBeUndefined();
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
    const uncurated = [...segments].filter(segment => !(segment in CHANNEL_NAME_KEYS));
    expect(uncurated).toEqual([]);
  });
});

describe("official-command-list additions (2026-08-25)", () => {
  const cat = buildYncaCatalog();
  const ids = idToEntry(cat);

  test("tuner preset store: a slot number goes out verbatim, 0 becomes Auto", () => {
    // A classic receiver's per-device map (TUN answered PRESET) — the static map ends on HD Radio.
    const classic = idToEntry(presentYncaEntries({ model: "RX-V473", subunits: { TUN: { PRESET: "1" } } }));
    expect(yncaCommand("tuner.presetSave", 7, classic)).toEqual({ subunit: "TUN", func: "MEM", value: "7" });
    expect(yncaCommand("tuner.presetSave", 0, classic)).toEqual({ subunit: "TUN", func: "MEM", value: "Auto" });
  });

  test("player preset store exists on the MEM-capable sources only", () => {
    expect(yncaCommand("player.netRadio.presetSave", 3, ids)).toEqual({
      subunit: "NETRADIO",
      func: "MEM",
      value: "3",
    });
    expect(ids.get("player.usb.presetSave")).toBeDefined();
    // Spotify stores presets on the RX-A850 (official 2015 list); Deezer and TIDAL on no list.
    expect(ids.get("player.spotify.presetSave")).toBeDefined();
    expect(ids.get("player.deezer.presetSave")).toBeUndefined();
    expect(ids.get("player.tidal.presetSave")).toBeUndefined();
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

describe("deviceInputStates — the YNCA input list narrowed by PROOF, never by silence (#619)", () => {
  const probed = new Set(availGets(buildYncaCatalog()).map(get => get.subunit));

  test("drops the sources whose subunit the AVAIL probe proved absent (RX-V473 answers)", () => {
    const present = new Set(["MAIN", "AIRPLAY", "IPODUSB", "NETRADIO", "SERVER", "TUN", "USB"]);
    const states = deviceInputStates({ present, probed }, "main", "HDMI1");
    for (const kept of [
      "HDMI1",
      "AV6",
      "V-AUX",
      "AUDIO",
      "AirPlay",
      "iPod (USB)",
      "NET RADIO",
      "SERVER",
      "TUNER",
      "USB",
    ]) {
      expect(states, kept).toHaveProperty(kept);
    }
    for (const gone of [
      "Spotify",
      "Deezer",
      "TIDAL",
      "Napster",
      "Pandora",
      "Bluetooth",
      "PC",
      "MusicCast Link",
      "iPod",
      "Rhapsody",
      "SIRIUS",
    ]) {
      expect(states, gone).not.toHaveProperty(gone);
    }
  });

  test("a device that ignored the AVAIL probe is not judged — nothing is dropped", () => {
    // Subunits that answered SOME function in a blind sweep are not a proof of the others' absence.
    const states = deviceInputStates({ present: new Set(["MAIN", "NETRADIO"]), probed: new Set() }, "main");
    expect(states).toHaveProperty("Spotify");
    expect(states).toHaveProperty("Bluetooth");
  });

  test("keeps a source whose subunit the probe does not cover — it cannot be judged", () => {
    const states = deviceInputStates({ present: new Set(["MAIN"]), probed }, "main");
    for (const unjudged of ["UAW", "JUKE", "Qobuz", "Amazon Music", "Alexa"]) {
      expect(states, unjudged).toHaveProperty(unjudged);
    }
    // SiriusXM and SIRIUS Internet Radio have subunits since 2026-09-09 — the probe judges them.
    expect(states).not.toHaveProperty("SiriusXM");
    expect(states).not.toHaveProperty("SIRIUS InternetRadio");
  });

  test("an XML source flag 0 drops a source the AVAIL probe could not judge; flag 1 keeps it", () => {
    const evidence = { present: new Set(["MAIN"]), probed, xmlFeatures: { JUKE: false, Qobuz: true, Alexa: false } };
    const states = deviceInputStates(evidence, "main");
    expect(states).not.toHaveProperty("JUKE");
    expect(states).not.toHaveProperty("Alexa");
    expect(states).toHaveProperty("Qobuz");
  });

  test("the tuner input is absent only when Tuner, DAB and HD_Radio are ALL flagged 0 (RX-V6A: Tuner=0, DAB=1)", () => {
    const base = { present: new Set(["MAIN"]), probed: new Set<string>() };
    expect(
      deviceInputStates({ ...base, xmlFeatures: { Tuner: false, DAB: true, HD_Radio: false } }, "main"),
    ).toHaveProperty("TUNER");
    expect(
      deviceInputStates({ ...base, xmlFeatures: { Tuner: false, DAB: false, HD_Radio: false } }, "main"),
    ).not.toHaveProperty("TUNER");
    // A partial flag set judges nothing.
    expect(deviceInputStates({ ...base, xmlFeatures: { Tuner: false } }, "main")).toHaveProperty("TUNER");
  });

  test("physical inputs are never dropped by YNCA evidence alone; an XML input name ADDS one, never removes", () => {
    const states = deviceInputStates(
      {
        present: new Set(["MAIN"]),
        probed,
        xmlInputNames: { HDMI_1: "Apple TV", AUX: "AUX", V_AUX: "V-AUX", X_Y: "?" },
      },
      "main",
    );
    for (const physical of [
      "AUDIO",
      "AUDIO1",
      "AUX",
      "NET",
      "USB/NET",
      "AV7",
      "CD",
      "HDMI7",
      "LINE1",
      "OPTICAL1",
      "PHONO",
      "TV",
    ]) {
      expect(states, physical).toHaveProperty(physical);
    }
    // An unknown name key adds its classic form; nothing is removed.
    expect(states).toHaveProperty("X Y");
  });

  test("offers Main Zone Sync on a zone, not on the main zone", () => {
    expect(deviceInputStates({ present: new Set(["MAIN"]), probed }, "main")).not.toHaveProperty("Main Zone Sync");
    expect(deviceInputStates({ present: new Set(["MAIN", "ZONE2"]), probed }, "zone2")).toHaveProperty(
      "Main Zone Sync",
    );
  });

  test("always offers the value the zone currently reports", () => {
    expect(deviceInputStates({ present: new Set(["MAIN"]), probed }, "main", "Qobuz")).toHaveProperty("Qobuz");
    expect(
      deviceInputStates({ present: new Set(["MAIN"]), probed, xmlFeatures: { Spotify: false } }, "main", "Spotify"),
    ).toHaveProperty("Spotify");
  });
});

describe("enumStatesFor — the candidates of the generation plus everything the device reported", () => {
  const entry = (func: string): ReturnType<typeof buildYncaCatalog>[number] =>
    buildYncaCatalog().find(e => e.subunit === "MAIN" && e.func === func) ??
    buildYncaCatalog().find(e => e.subunit === "SYS" && e.func === func)!;

  test("hdmi.output: the documented four plus the single-output OUT the RX-A700 reports", () => {
    const states = enumStatesFor(entry("HDMIOUT"), ["OUT"], "OUT");
    expect(states).toMatchObject({ Off: "Off", OUT: "OUT", OUT1: "OUT1", "OUT1 + 2": "OUT1 + 2" });
  });

  test("sound.surroundDecoder: the nine-value core of the classic generation; Auto and AURO-3D only when reported", () => {
    const core = enumStatesFor(entry("2CHDECODER"), []);
    expect(Object.keys(core)).toHaveLength(9);
    expect(core).not.toHaveProperty("Auto");
    expect(enumStatesFor(entry("2CHDECODER"), ["Auto", "AURO-3D"], "Auto")).toMatchObject({
      Auto: "Auto",
      "AURO-3D": "AURO-3D",
    });
  });

  test("a spelling only one device uses is offered on that device (RX-V1067: 'Dolby ProLogicII(Movie)')", () => {
    expect(enumStatesFor(entry("2CHDECODER"), ["Dolby ProLogicII(Movie)"])).toHaveProperty("Dolby ProLogicII(Movie)");
  });

  test("speakers.pattern1Amp has no candidates — only what the device reported", () => {
    expect(enumStatesFor(entry("SPPATTERN1AMP"), [])).toEqual({});
    expect(enumStatesFor(entry("SPPATTERN1AMP"), ["7ch +FPR"], "7ch +FPR")).toEqual({ "7ch +FPR": "7ch +FPR" });
  });

  test("hdmi.aspect and hdmi.resolution carry the documented values incl. Smart Zoom and 4K", () => {
    expect(enumStatesFor(entry("HDMIASPECT"), [])).toHaveProperty("Smart Zoom");
    expect(enumStatesFor(entry("HDMIRESOL"), [])).toHaveProperty("4K");
  });

  test("soundProgram candidates are the 27 documented names of the classic generation, not the 41-entry union", () => {
    const states = enumStatesFor(entry("SOUNDPRG"), []);
    expect(Object.keys(states)).toHaveLength(27);
    expect(states).toHaveProperty("5ch Stereo");
    expect(states).not.toHaveProperty("Disco");
    expect(enumStatesFor(entry("SOUNDPRG"), ["Disco"], "Disco")).toHaveProperty("Disco");
  });

  test("the current value is offered even when it was never observed before", () => {
    expect(enumStatesFor(entry("HDMIASPECT"), [], "Whatever")).toHaveProperty("Whatever");
  });
});

describe("the 2010–2015 command lists, completed (coverage audit 2026-09-09)", () => {
  const cat = buildYncaCatalog();
  const find = (subunit: string, func: string, id?: string): YncaEntry | undefined =>
    cat.find(e => e.subunit === subunit && e.func === func && (id === undefined || e.id === id));

  test("the second TV audio return input and the audio select share the official value sets", () => {
    expect(find("MAIN", "TVAUDIN2")).toMatchObject({ id: "advanced.tvAudioIn2", write: true });
    expect((find("MAIN", "TVAUDIN2")?.spec as EnumSpec).states).toEqual(
      (find("MAIN", "TVAUDIN1")?.spec as EnumSpec).states,
    );
    expect(find("MAIN", "AUDSEL")).toMatchObject({ id: "advanced.audioSelect", write: true });
    expect(Object.keys((find("MAIN", "AUDSEL")?.spec as EnumSpec).states)).toEqual([
      "Auto",
      "HDMI",
      "Coax/Opt",
      "Analog",
    ]);
  });

  test("zones carry balance, pre-out mode, the 2010 tone dialect and four scenes — the main zone does not", () => {
    expect(find("ZONE2", "BALANCE")).toMatchObject({ id: "multiroom.zone2.sound.balance" });
    expect(find("ZONE2", "BALANCE")?.spec).toMatchObject({ kind: "number", min: -20, max: 20, step: 1 });
    expect(find("ZONE3", "VOLFIXVAR")).toMatchObject({ id: "multiroom.zone3.volumeOutput" });
    expect(Object.keys((find("ZONE3", "VOLFIXVAR")?.spec as EnumSpec).states)).toEqual(["Variable", "Fixed"]);
    expect(find("ZONE2", "BASS")).toMatchObject({ id: "multiroom.zone2.sound.bass" });
    expect(find("ZONE2", "BASS")?.spec).toMatchObject({ kind: "number", unit: "dB", min: -10, max: 10, step: 2 });
    expect(find("ZONE2", "TREBLE")).toMatchObject({ id: "multiroom.zone2.sound.treble" });
    for (const subunit of ["ZONE2", "ZONE3", "ZONE4"]) {
      const recall = find(subunit, "SCENE");
      expect(recall).toMatchObject({ readFunc: "SCENE1NAME", readAliases: ["SCENE2NAME", "SCENE3NAME", "SCENE4NAME"] });
      expect(recall?.spec).toMatchObject({ kind: "number", min: 1, max: 4 });
      expect(recall?.wireEncode?.(3)).toBe("Scene 3");
    }
    for (const func of ["BALANCE", "VOLFIXVAR", "BASS", "TREBLE"]) {
      expect(find("MAIN", func)).toBeUndefined();
    }
  });

  test("system-wide: party volume keys, HDMI video mode, the lip-sync block, RS-232C standby, region, tuner step, update notice", () => {
    expect(find("SYS", "PARTYVOL", "multiroom.partyVolumeUp")).toMatchObject({ readFunc: "PARTY", writeOnly: true });
    expect(find("SYS", "PARTYVOL", "multiroom.partyVolumeUp")?.wireEncode?.(true)).toBe("Up");
    expect(find("SYS", "PARTYVOL", "multiroom.partyVolumeDown")?.wireEncode?.(true)).toBe("Down");
    expect(Object.keys((find("SYS", "HDMIVIDEOMODE")?.spec as EnumSpec).states)).toEqual(["Direct", "Processing"]);
    expect(find("SYS", "HDMIVIDEOMODE")?.id).toBe("hdmi.videoMode");
    expect(Object.keys((find("SYS", "LIPSYNCMODE")?.spec as EnumSpec).states)).toEqual(["Manual", "Auto"]);
    expect(find("SYS", "LIPSYNCTOTALDELAY")).toMatchObject({ id: "hdmi.lipSyncTotalDelay", write: true });
    expect(find("SYS", "LIPSYNCTOTALDELAY")?.spec).toMatchObject({
      kind: "number",
      unit: "ms",
      min: 0,
      max: 500,
      step: 1,
    });
    expect(find("SYS", "LIPSYNCTOTALDELAYINFO")).toMatchObject({ id: "hdmi.lipSyncTvOffset", write: false });
    expect(find("SYS", "LIPSYNCSELINFO")).toMatchObject({ id: "hdmi.lipSyncOutput", write: false });
    expect(Object.keys((find("SYS", "LIPSYNCSELINFO")?.spec as EnumSpec).states)).toEqual([
      "Disable",
      "Analog",
      "HDMI1 Auto",
      "HDMI1 Manual",
      "HDMI2 Auto",
      "HDMI2 Manual",
    ]);
    expect(find("SYS", "RS232CSTANDBY")).toMatchObject({ id: "advanced.rs232Standby", write: true });
    expect(find("SYS", "RS232CSTANDBY")?.spec).toEqual({ kind: "onoff", on: "On", off: "Off" });
    expect(find("SYS", "DEST")).toMatchObject({ id: "info.region", write: false });
    expect(find("SYS", "FREQSTEP")).toMatchObject({ id: "tuner.frequencyStep", write: false });
    expect(Object.keys((find("SYS", "FREQSTEP")?.spec as EnumSpec).states)).toEqual([
      "FM50/AM9",
      "FM100/AM9",
      "FM100/AM10",
      "FM200/AM10",
    ]);
    expect(find("SYS", "UPDTNOTICEMSG")).toMatchObject({ id: "advanced.updateNotice", write: true });
    // A PUT-only function without any readable proof gets no datapoint (REMOTECODE).
    expect(find("SYS", "REMOTECODE")).toBeUndefined();
  });

  test("trigger output 2 mirrors trigger output 1, and both cover every input the lists assign a trigger to", () => {
    for (const n of [1, 2]) {
      expect(find("SYS", `TRIG${n}TYPE`)).toMatchObject({ id: `advanced.trigger${n}Type`, nameArgs: [n] });
      expect(find("SYS", `TRIG${n}ZONE`)).toMatchObject({ id: `advanced.trigger${n}Zone`, nameArgs: [n] });
      expect(find("SYS", `TRIG${n}MANUAL`)).toMatchObject({ id: `advanced.trigger${n}Manual` });
      for (const key of [
        "audio1",
        "av7",
        "hdmi7",
        "airplay",
        "bt",
        "dock",
        "ipodusb",
        "multich",
        "net",
        "siriusxm",
        "spotify",
        "uaw",
      ]) {
        const entry = find("SYS", `TRIG${n}INP${key.toUpperCase()}`);
        expect(entry, `${n}:${key}`).toMatchObject({ id: `advanced.trigger${n}Inputs.${key}` });
      }
      expect(find("SYS", `TRIG${n}INPIPODUSB`)?.nameArgs).toEqual([n, "iPod (USB)"]);
    }
    expect(find("SYS", "TRIG1INPHDMI7")?.spec).toEqual({ kind: "enum", states: { Lo: "Lo", Hi: "Hi" } });
  });

  test("speaker pattern 2 mirrors pattern 1 entry for entry, with the pattern number in the name", () => {
    const pattern = (n: number): YncaEntry[] =>
      cat
        .filter(e => e.subunit === "SYS" && e.func.startsWith(`SPPATTERN${n}`))
        .sort((a, b) => a.func.localeCompare(b.func));
    const one = pattern(1);
    const two = pattern(2);
    expect(one.length).toBeGreaterThanOrEqual(21);
    expect(two.map(e => e.func)).toEqual(one.map(e => e.func.replace("SPPATTERN1", "SPPATTERN2")));
    expect(two.map(e => e.id)).toEqual(one.map(e => e.id.replace("pattern1", "pattern2")));
    for (const [a, b] of one.map((e, i) => [e, two[i]] as const)) {
      expect(b.spec, a.func).toEqual(a.spec);
      expect(b.nameKey).toBe(a.nameKey);
      expect(a.nameArgs).toEqual([1]);
      expect(b.nameArgs).toEqual([2]);
    }
    // The 2012 crossover per speaker group, the rear presence pair, the second subwoofer's
    // phase and the subwoofer layout; the 2015 front-presence config/crossover and layouts.
    for (const func of [
      "FRNTCRSOVR",
      "CENTCRSOVR",
      "SURCRSOVR",
      "SURBCRSOVR",
      "REARPRES",
      "SWFR2PHASE",
      "SWFRLAYOUT",
      "FPLAYOUT",
      "FPRESCNFG",
      "FPRESCRSOVR",
      "SURLAYOUT",
    ]) {
      expect(find("SYS", `SPPATTERN1${func}`), func).toBeDefined();
    }
    expect(Object.keys((find("SYS", "SPPATTERN1SWFRLAYOUT")?.spec as EnumSpec).states)).toEqual([
      "Left & Right",
      "Front & Rear",
      "Monaural x2",
    ]);
    expect(Object.keys((find("SYS", "SPPATTERN1FPLAYOUT")?.spec as EnumSpec).states)).toEqual([
      "Front",
      "Overhead",
      "Dolby",
    ]);
    expect(Object.keys((find("SYS", "SPPATTERN1SURLAYOUT")?.spec as EnumSpec).states)).toEqual(["Rear", "Front"]);
    expect(Object.keys((find("SYS", "SPPATTERN1FPRESCNFG")?.spec as EnumSpec).states)).toEqual([
      "None",
      "Small",
      "Large",
    ]);
    expect((find("SYS", "SPPATTERN1CENTCRSOVR")?.spec as EnumSpec).states).toEqual(
      (find("SYS", "SPPATTERN1SWFRCRSOVR")?.spec as EnumSpec).states,
    );
  });

  test("the sweep bundles: one GET that answers many, per present subunit — never for an absent one", () => {
    const gets = bundleGets(new Set(["MAIN", "ZONE2", "TUN", "NETRADIO", "USB"]));
    const pairs = gets.map(get => `${get.subunit}:${get.func}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        "MAIN:BASIC",
        "MAIN:SCENENAME",
        "ZONE2:BASIC",
        "ZONE2:SCENENAME",
        "TUN:SIGINFO",
        "TUN:RDSINFO",
        "NETRADIO:METAINFO",
        "USB:METAINFO",
      ]),
    );
    expect(pairs.some(pair => pair.startsWith("ZONE3:") || pair.startsWith("SPOTIFY:"))).toBe(false);
    expect(bundleGets(new Set())).toEqual([]);
    // A bundle function is never a catalog function of its own.
    expect(cat.some(e => ["BASIC", "SCENENAME", "SIGINFO", "RDSINFO", "METAINFO"].includes(e.func))).toBe(false);
  });
});

describe("HD Radio and the Sirius subunits (coverage audit 2026-09-09, 7 + 6/4/1 official lists)", () => {
  const cat = buildYncaCatalog();
  const find = (subunit: string, func: string, id?: string): YncaEntry | undefined =>
    cat.find(e => e.subunit === subunit && e.func === func && (id === undefined || e.id === id));

  test("HD Radio is a tuner: band, frequency, presets, search mode and the signal flags land on the flat tuner ids", () => {
    expect(find("HDRADIO", "BAND")).toMatchObject({ id: "tuner.band" });
    expect(Object.keys((find("HDRADIO", "BAND")?.spec as EnumSpec).states).sort()).toEqual(["AM", "FM"]);
    expect(find("HDRADIO", "AMFREQ")).toMatchObject({ id: "tuner.frequency" });
    expect(find("HDRADIO", "FMFREQ")?.wireDecode?.("98.10")).toBe("98100");
    expect(find("HDRADIO", "PRESET", "tuner.preset")?.wireDecode?.("No Preset")).toBe("0");
    expect(find("HDRADIO", "PRESET", "tuner.presetUp")?.wireEncode?.(true)).toBe("Up");
    expect(find("HDRADIO", "MEM")).toMatchObject({ id: "tuner.presetSave", writeOnly: true });
    expect(find("HDRADIO", "SEARCHMODE")).toMatchObject({ id: "tuner.searchMode" });
    expect(find("HDRADIO", "TUNED")).toMatchObject({ id: "tuner.tuned" });
    expect(find("HDRADIO", "SIGSTEREOMONO")).toMatchObject({ id: "tuner.stereo" });
  });

  test("HD Radio's own: audio mode, programme (with PRGNUM as read alias), programme type, digital flag, eight availabilities, tags, metadata", () => {
    expect(find("HDRADIO", "AUDIOMODE")).toMatchObject({ id: "tuner.hdRadio.audioMode" });
    expect(Object.keys((find("HDRADIO", "AUDIOMODE")?.spec as EnumSpec).states)).toEqual(["Auto", "Mono"]);
    const program = find("HDRADIO", "PRGSEL");
    expect(program).toMatchObject({ id: "tuner.hdRadio.program", write: true, readAliases: ["PRGNUM"] });
    expect(Object.keys((program?.spec as EnumSpec).states)).toEqual([
      "---",
      "HD1",
      "HD2",
      "HD3",
      "HD4",
      "HD5",
      "HD6",
      "HD7",
      "HD8",
    ]);
    expect(find("HDRADIO", "PRGTYPE")).toMatchObject({
      id: "tuner.hdRadio.programType",
      write: false,
      readAliases: ["CATEGORY"],
    });
    expect(find("HDRADIO", "HDSIGINFO")?.spec).toEqual({ kind: "onoff", on: "Assert", off: "Negate" });
    for (let n = 1; n <= 8; n++) {
      const avail = find("HDRADIO", `AVAILPRG${n}`);
      expect(avail, `AVAILPRG${n}`).toMatchObject({
        id: `tuner.hdRadio.program${n}Available`,
        nameArgs: [n],
        write: false,
      });
      expect(avail?.spec).toEqual({ kind: "onoff", on: "Available", off: "Unavailable" });
    }
    expect(find("HDRADIO", "TAGINFO")).toMatchObject({ id: "tuner.hdRadio.tagAvailable", write: false });
    expect(find("HDRADIO", "TAGSET")).toMatchObject({
      id: "tuner.hdRadio.tagSave",
      writeOnly: true,
      readFunc: "TAGINFO",
    });
    expect(find("HDRADIO", "TAGSET")?.wireEncode?.(true)).toBe("Add");
    for (const [func, id] of [
      ["STATION", "station"],
      ["ARTIST", "artist"],
      ["SONG", "track"],
      ["ALBUM", "album"],
    ]) {
      expect(find("HDRADIO", func), func).toMatchObject({ id: `tuner.hdRadio.${id}`, write: false });
    }
    // The bundles cover it, and it is no catalog function of its own.
    expect(cat.some(e => e.subunit === "HDRADIO" && (e.func === "SIGINFO" || e.func === "METAINFO"))).toBe(false);
    expect(
      bundleGets(new Set(["HDRADIO"]))
        .map(get => get.func)
        .sort(),
    ).toEqual(["METAINFO", "SIGINFO"]);
  });

  test("a device whose only tuner is HD Radio keeps TUNER in its input list; the probe judges all three tuner subunits", () => {
    const probed = new Set(availGets(cat).map(get => get.subunit));
    expect(probed.has("HDRADIO")).toBe(true);
    expect(deviceInputStates({ present: new Set(["MAIN", "HDRADIO"]), probed }, "main")).toHaveProperty("TUNER");
    expect(deviceInputStates({ present: new Set(["MAIN"]), probed }, "main")).not.toHaveProperty("TUNER");
  });

  test("the SIRIUS satellite tuner's own: channel, category keys, search mode, antenna level, names, parental lock", () => {
    expect(find("SIRIUS", "CHSEL")).toMatchObject({ id: "player.sirius.channel", write: true });
    expect(find("SIRIUS", "CHSEL")?.spec).toMatchObject({ kind: "number", min: 0, max: 255, step: 1 });
    expect(find("SIRIUS", "CHNUM")).toMatchObject({ id: "player.sirius.channelNumber", write: false });
    expect(find("SIRIUS", "CATSEL", "player.sirius.categoryUp")).toMatchObject({
      writeOnly: true,
      readFunc: "CATNAME",
    });
    expect(find("SIRIUS", "CATSEL", "player.sirius.categoryDown")?.wireEncode?.(true)).toBe("Down");
    expect(Object.keys((find("SIRIUS", "SEARCHMODE")?.spec as EnumSpec).states)).toEqual([
      "All Ch",
      "Category",
      "Preset",
    ]);
    expect(find("SIRIUS", "ANTLVL")).toMatchObject({ id: "player.sirius.antennaLevel", write: false });
    expect(Object.keys((find("SIRIUS", "ANTLVL")?.spec as EnumSpec).states)).toEqual([
      "No Signal",
      "Weak",
      "Good",
      "Excellent",
    ]);
    expect(find("SIRIUS", "CATNAME")).toMatchObject({ id: "player.sirius.categoryName" });
    expect(find("SIRIUS", "COMPOSER")).toMatchObject({ id: "player.sirius.composer" });
    expect(find("SIRIUS", "PLOCK")?.spec).toEqual({ kind: "onoff", on: "Locked", off: "Unlocked" });
  });

  test("SIRIUS Internet Radio and SiriusXM are player sources with presets, a store and a menu", () => {
    for (const [subunit, channel] of [
      ["SIRIUSIR", "siriusInternetRadio"],
      ["SIRIUSXM", "siriusXm"],
    ]) {
      expect(find(subunit, "PLAYBACK"), subunit).toMatchObject({ id: "player.playback" });
      expect(find(subunit, "PRESET"), subunit).toMatchObject({ id: `player.${channel}.preset` });
      expect(find(subunit, "MEM"), subunit).toMatchObject({ id: `player.${channel}.presetSave` });
    }
    expect(YNCA_BROWSE_SOURCES.map(source => source.subunit)).toEqual(expect.arrayContaining(["SIRIUSIR", "SIRIUSXM"]));
    expect(bundleGets(new Set(["SIRIUSIR", "SIRIUSXM"])).map(get => `${get.subunit}:${get.func}`)).toEqual([
      "SIRIUSIR:METAINFO",
      "SIRIUSXM:METAINFO",
    ]);
  });

  test("the RX-A850 presets on AirPlay, Bluetooth, Spotify, Server and Pandora are offered where the source is", () => {
    for (const subunit of ["AIRPLAY", "BT", "SPOTIFY", "SERVER", "PANDORA"]) {
      expect(find(subunit, "PRESET"), subunit).toBeDefined();
      expect(find(subunit, "MEM"), subunit).toBeDefined();
    }
  });
});

describe("the resolver hands the reported value to the object (for the coordinator's adoption rule)", () => {
  test("an enum object carries reportedValue when the resolver names one", () => {
    const entries = presentYncaEntries({ model: "X", subunits: { MAIN: { INP: "TV" } } });
    const objects = catalogToObjects(entries, entry =>
      entry.id === "input" ? { states: { TV: "TV", HDMI1: "HDMI1" }, origin: "derived", reported: "TV" } : undefined,
    );
    expect(objects.find(o => o.id === "input")).toMatchObject({ reportedValue: "TV", statesOrigin: "derived" });
  });
});

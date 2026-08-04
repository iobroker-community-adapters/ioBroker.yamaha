"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var catalog_exports = {};
__export(catalog_exports, {
  buildYncaCatalog: () => buildYncaCatalog,
  funcToEntry: () => funcToEntry,
  idToEntry: () => idToEntry,
  sweepGets: () => sweepGets
});
module.exports = __toCommonJS(catalog_exports);
function selfMap(values) {
  return Object.fromEntries(values.map((value) => [value, value]));
}
const INPUT_STATES = selfMap([
  "AUDIO",
  "AUDIO1",
  "AUDIO2",
  "AUDIO3",
  "AUDIO4",
  "AUDIO5",
  "AV1",
  "AV2",
  "AV3",
  "AV4",
  "AV5",
  "AV6",
  "AV7",
  "CD",
  "COAXIAL1",
  "COAXIAL2",
  "DOCK",
  "HDMI1",
  "HDMI2",
  "HDMI3",
  "HDMI4",
  "HDMI5",
  "HDMI6",
  "HDMI7",
  "LINE1",
  "LINE2",
  "LINE3",
  "Main Zone Sync",
  "MULTI CH",
  "OPTICAL1",
  "OPTICAL2",
  "PHONO",
  "TV",
  "V-AUX",
  "AirPlay",
  "Bluetooth",
  "Deezer",
  "iPod",
  "iPod (USB)",
  "MusicCast Link",
  "Napster",
  "NET RADIO",
  "Pandora",
  "PC",
  "Rhapsody",
  "SERVER",
  "SIRIUS",
  "SIRIUS InternetRadio",
  "SiriusXM",
  "Spotify",
  "TIDAL",
  "TUNER",
  "UAW",
  "USB"
]);
const SOUNDPRG_STATES = selfMap([
  "Action Game",
  "Adventure",
  "Arena",
  "Cellar Club",
  "Chamber",
  "Church in Freiburg",
  "Church in Royaumont",
  "Church in Tokyo",
  "Disco",
  "Drama",
  "Enhanced",
  "Hall in Amsterdam",
  "Hall in Frankfurt",
  "Hall in Munich",
  "Hall in Munich A",
  "Hall in Munich B",
  "Hall in Stuttgart",
  "Hall in USA A",
  "Hall in USA B",
  "Hall in Vienna",
  "Mono Movie",
  "Music Video",
  "Pavilion",
  "Recital/Opera",
  "Roleplaying Game",
  "Sci-Fi",
  "Spectacle",
  "Sports",
  "Standard",
  "Surround Decoder",
  "The Bottom Line",
  "The Roxy Theatre",
  "Village Gate",
  "Village Vanguard",
  "Warehouse Loft",
  "2ch Stereo",
  "5ch Stereo",
  "7ch Stereo",
  "9ch Stereo",
  "11ch Stereo",
  "All-Ch Stereo"
]);
const SLEEP_STATES = selfMap(["Off", "30 min", "60 min", "90 min", "120 min"]);
const AMP_FUNCS = [
  {
    func: "PWR",
    state: "power",
    name: "Power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "VOL",
    state: "volume",
    name: "Volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MUTE",
    state: "mute",
    name: "Mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "INP",
    state: "input",
    name: "Input",
    spec: { kind: "enum", states: INPUT_STATES },
    write: true,
    role: "media.input"
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    name: "Sound program",
    spec: { kind: "enum", states: SOUNDPRG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "STRAIGHT",
    state: "straight",
    name: "Straight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "ENHANCER",
    state: "enhancer",
    name: "Enhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PUREDIRMODE",
    state: "pureDirect",
    name: "Pure Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SLEEP",
    state: "sleep",
    name: "Sleep timer",
    spec: { kind: "enum", states: SLEEP_STATES },
    write: true,
    role: "state"
  }
];
const ZONES = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "zone2." },
  { subunit: "ZONE3", prefix: "zone3." },
  { subunit: "ZONE4", prefix: "zone4." }
];
function buildYncaCatalog() {
  const entries = [];
  for (const zone of ZONES) {
    for (const fn of AMP_FUNCS) {
      entries.push({
        id: `${zone.prefix}${fn.state}`,
        name: fn.name,
        spec: fn.spec,
        write: fn.write,
        role: fn.role,
        subunit: zone.subunit,
        func: fn.func
      });
    }
  }
  return entries;
}
function sweepGets(entries) {
  const seen = /* @__PURE__ */ new Set();
  const gets = [];
  for (const entry of entries) {
    const key = `${entry.subunit}:${entry.func}`;
    if (!seen.has(key)) {
      seen.add(key);
      gets.push({ subunit: entry.subunit, func: entry.func });
    }
  }
  return gets;
}
function funcToEntry(entries) {
  return new Map(entries.map((entry) => [`${entry.subunit}:${entry.func}`, entry]));
}
function idToEntry(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildYncaCatalog,
  funcToEntry,
  idToEntry,
  sweepGets
});
//# sourceMappingURL=catalog.js.map

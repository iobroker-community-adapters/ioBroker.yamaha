"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var pure_helpers_exports = {};
__export(pure_helpers_exports, {
  LABEL_RANK: () => LABEL_RANK,
  RENAMED_CHANNELS: () => RENAMED_CHANNELS,
  RENAMED_STATE_IDS: () => RENAMED_STATE_IDS,
  childlessChannelIds: () => childlessChannelIds,
  isUsefulDeviceName: () => isUsefulDeviceName,
  legacyDeviceRow: () => legacyDeviceRow,
  mergeDiscovered: () => mergeDiscovered,
  neverWrittenStateIds: () => neverWrittenStateIds,
  nextDeviceLabel: () => nextDeviceLabel,
  parseDevices: () => parseDevices,
  renamedObjectIds: () => renamedObjectIds,
  sanitizeId: () => sanitizeId,
  staleObjects: () => staleObjects,
  stripNamespace: () => stripNamespace,
});
module.exports = __toCommonJS(pure_helpers_exports);
function isConfiguredDevice(entry) {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry;
  return (
    typeof candidate.ip === "string" &&
    candidate.ip.length > 0 &&
    (candidate.name === void 0 || typeof candidate.name === "string")
  );
}
function sanitizeId(raw) {
  return raw.replace(/[^A-Za-z0-9\-_]/g, "_");
}
function stripNamespace(fullId, namespace) {
  return fullId.slice(namespace.length + 1);
}
function parseDevices(raw, onCollision) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const records = [];
  const taken = /* @__PURE__ */ new Set(["info"]);
  for (const entry of raw) {
    if (!isConfiguredDevice(entry)) {
      continue;
    }
    const id = sanitizeId(entry.name && entry.name.length > 0 ? entry.name : entry.ip);
    if (taken.has(id)) {
      onCollision == null ? void 0 : onCollision(entry.name || entry.ip, id);
      continue;
    }
    taken.add(id);
    records.push({ id, ip: entry.ip });
  }
  return records;
}
function mergeDiscovered(known, found, onCollision) {
  var _a;
  const byId = /* @__PURE__ */ new Map();
  for (const device of known) {
    if (device.id === "info" || byId.has(device.id)) {
      continue;
    }
    byId.set(device.id, { ...device });
  }
  for (const device of found) {
    const label = device.name || device.ip;
    const id = sanitizeId(label);
    const remembered = byId.get(id);
    if (remembered) {
      remembered.ip = device.ip;
      continue;
    }
    const ipOwner = [...byId.values()].find(record => record.ip === device.ip);
    if (id === "info" || ipOwner) {
      onCollision == null ? void 0 : onCollision(label, (_a = ipOwner == null ? void 0 : ipOwner.id) != null ? _a : id);
      continue;
    }
    byId.set(id, { id, ip: device.ip });
  }
  return [...byId.values()];
}
function staleObjects(existing, deviceIds, namespace) {
  if (deviceIds.size === 0) {
    return [];
  }
  const isKept = fullId => {
    const top = stripNamespace(fullId, namespace).split(".")[0];
    return top === "info" || deviceIds.has(top);
  };
  return existing.filter(id => !isKept(id)).sort((a, b) => b.length - a.length);
}
const V2_PLAYER_BLOCK_STATES = [
  "playback",
  "artist",
  "album",
  "track",
  "station",
  "channelName",
  "totalTime",
  "elapsedTime",
  "repeat",
  "shuffle",
  "albumArt",
  "source",
  "play",
  "pause",
  "stop",
  "next",
  "prev",
  "repeatToggle",
  "shuffleToggle",
];
const V2_SLIMMED_SOURCES = [
  "netPlayer",
  "cd",
  "netRadio",
  "server",
  "usb",
  "napster",
  "pandora",
  "rhapsody",
  "sirius",
  "pc",
  "airplay",
  "bluetooth",
];
const RENAMED_STATE_IDS = [
  "hdmiOut",
  "directMode",
  "masterPower",
  "party",
  "partyMute",
  "distributionEnable",
  "partyEnable",
  "remoteCode",
  // v1.0.0 multiroom regroup: the MusicCast-Link states moved into their own
  // multiroom.group folder, so the tree itself tells device-group from all-zones scope.
  "multiroom.distributionEnable",
  // Short-lived v1.0.0 pre-cut id — mislabeled "active", the field means "enabled for use".
  "multiroom.group.streamingActive",
  "multiroom.role",
  "multiroom.groupId",
  "multiroom.groupName",
  "multiroom.serverZone",
  "multiroom.clientList",
  "multiroom.linkClient",
  "multiroom.leaveGroup",
  // ---- v2.0.0 tree rework ------------------------------------------------------
  // Player unification: the per-source copies of the playback block are gone (the
  // slimmed folders keep only their own preset/pairing/drive states).
  ...V2_SLIMMED_SOURCES.flatMap(source => V2_PLAYER_BLOCK_STATES.map(state => `player.${source}.${state}`)),
  // Scenes: the twelve per-name datapoints became the recall dropdown + scene.list.
  ...Array.from({ length: 12 }, (_unused, i) => `scene.name${i + 1}`),
  // Tuner unification: ONE band/frequency/preset; the DAB subunit's FM half moved
  // onto the flat tuner ids, the two per-band frequencies became tuner.frequency.
  "tuner.amFrequency",
  "tuner.fmFrequency",
  "tuner.dab.band",
  "tuner.dab.preset",
  "tuner.dab.fmPreset",
  "tuner.dab.fmFrequency",
  "tuner.dab.fmSearchMode",
  "tuner.dab.fmRdsService",
  "tuner.dab.fmRdsProgramType",
  "tuner.dab.fmRdsText",
  "tuner.dab.fmRdsClock",
  "tuner.dab.fmStereo",
  "tuner.dab.fmTuned",
  "tuner.dab.audioMode",
  // Sound polish: equalizer and signal info each moved into their own subfolder.
  "sound.equalizerMode",
  "sound.equalizerLow",
  "sound.equalizerMid",
  "sound.equalizerHigh",
  "sound.signalFormat",
  "sound.signalSampling",
  "sound.signalBits",
  "sound.signalBitrate",
  // HDMI polish: the lip-sync offsets moved into the hdmi folder (the lipSync
  // channel itself is in RENAMED_CHANNELS); the A/B toggles joined the speakers.
  "advanced.speakerA",
  "advanced.speakerB",
];
const RENAMED_CHANNELS = [
  // pre-0.11 system folder
  "system",
  // v0.18.1 multiroom regroup: zone2/3/4, zoneB, flat multiroom states moved under multiroom/.
  "zone2",
  "zone3",
  "zone4",
  "zoneB",
  // v1.0.0: stray per-zone copies of the device-global YXC states (the zone loop used to
  // prefix them too, yielding multiroom.zoneN.multiroom.* junk) are swept away.
  "multiroom.zone2.multiroom",
  "multiroom.zone3.multiroom",
  "multiroom.zone4.multiroom",
  // Regrouping: media sources moved under player/, DAB under tuner/, dist → multiroom. The old
  // flat channels (and their whole subtree) are deleted so the new grouped ones do not sit
  // beside orphaned copies on an upgraded instance.
  "netRadio",
  "server",
  "usb",
  "spotify",
  "deezer",
  "tidal",
  "napster",
  "pandora",
  "rhapsody",
  "sirius",
  "airplay",
  "bluetooth",
  "pc",
  "musicCastLink",
  "ipod",
  "ipodUsb",
  "netPlayer",
  "cd",
  "dab",
  "dist",
  // Sound/Advanced regroup: DSP/tone-tuning states moved under sound.*, setup-only states
  // (+ the speakers/initialVolume/inputNames subtrees, already dotted before) under advanced.*.
  // {@link renamedObjectIds} also checks these against a stripped zone2/3/4 prefix, so one
  // entry here catches a MAIN state and its zoned copies (e.g. "straight" and "zone2.straight").
  "straight",
  "enhancer",
  "pureDirect",
  "direct",
  "adaptiveDrc",
  "surroundAI",
  "surroundDecoder",
  "cinemaDsp3d",
  "extraBass",
  "bass",
  "treble",
  "subwooferTrim",
  "balance",
  "dialogueLevel",
  "dialogueLift",
  "dtsDialogueControl",
  "monaural",
  "surround3d",
  "adaptiveDspLevel",
  "audioSelect",
  "linkControl",
  "linkAudioDelay",
  "linkAudioQuality",
  "contentsDisplay",
  "equalizerLow",
  "equalizerMid",
  "equalizerHigh",
  "clearVoice",
  "bassExtension",
  "ypaoVolume",
  "maxVolume",
  "speakerA",
  "speakerB",
  "speakers",
  "initialVolume",
  "inputNames",
  // ---- v2.0.0 tree rework: the always-empty source channels are gone entirely
  // (their playback lives in the flat per-zone block), lip sync moved into hdmi.
  "player.spotify",
  "player.deezer",
  "player.tidal",
  "player.ipod",
  "player.ipodUsb",
  "player.musicCastLink",
  "lipSync",
];
function neverWrittenStateIds(objects, states, deviceIds, namespace) {
  const ids = [];
  for (const [fullId, object] of Object.entries(objects)) {
    const common = object == null ? void 0 : object.common;
    if ((object == null ? void 0 : object.type) !== "state" || (common == null ? void 0 : common.read) === false) {
      continue;
    }
    const relative = stripNamespace(fullId, namespace);
    const top = relative.split(".")[0];
    if (!deviceIds.has(top) || relative.slice(top.length + 1).startsWith("info.")) {
      continue;
    }
    const state = states[fullId];
    if (!state || ((state.val === null || state.val === void 0) && !state.lc)) {
      ids.push(fullId);
    }
  }
  return ids;
}
function childlessChannelIds(objects, deviceIds, namespace) {
  const filled = /* @__PURE__ */ new Set();
  for (const [fullId, object] of Object.entries(objects)) {
    if ((object == null ? void 0 : object.type) !== "state") {
      continue;
    }
    for (let cut = fullId.lastIndexOf("."); cut > 0; cut = fullId.lastIndexOf(".", cut - 1)) {
      filled.add(fullId.slice(0, cut));
    }
  }
  const ids = [];
  for (const [fullId, object] of Object.entries(objects)) {
    if ((object == null ? void 0 : object.type) !== "channel" || filled.has(fullId)) {
      continue;
    }
    const relative = stripNamespace(fullId, namespace);
    if (deviceIds.has(relative.split(".")[0])) {
      ids.push(fullId);
    }
  }
  return ids.sort((a, b) => b.length - a.length);
}
function renamedObjectIds(existing, deviceIds, namespace) {
  var _a, _b;
  const stale = [];
  for (const deviceId of deviceIds) {
    const base = `${namespace}.${deviceId}.`;
    for (const full of existing) {
      if (!full.startsWith(base)) {
        continue;
      }
      const rel = full.slice(base.length);
      const zone = (_b = (_a = /^(?:multiroom\.)?zone[234]\./.exec(rel)) == null ? void 0 : _a[0]) != null ? _b : "";
      const template = rel.slice(zone.length);
      const renamedState = RENAMED_STATE_IDS.includes(rel) || RENAMED_STATE_IDS.includes(template);
      const underRenamedChannel = RENAMED_CHANNELS.some(
        ch => rel === ch || rel.startsWith(`${ch}.`) || template === ch || template.startsWith(`${ch}.`),
      );
      if (renamedState || underRenamedChannel) {
        stale.push(full);
      }
    }
  }
  return stale.sort((a, b) => b.length - a.length);
}
function legacyDeviceRow(config) {
  if (Array.isArray(config.devices) && config.devices.length > 0) {
    return void 0;
  }
  const raw =
    typeof config.ip === "string" && config.ip
      ? config.ip
      : typeof config.IP === "string" && config.IP
        ? config.IP
        : void 0;
  if (!raw) {
    return void 0;
  }
  const ip = raw.trim().replace(/:\d+$/, "");
  return ip ? { name: ip, ip } : void 0;
}
const LABEL_RANK = { model: 1, deviceName: 2 };
const GENERIC_ZONE_NAMES = /* @__PURE__ */ new Set(["main", "main zone", "mainzone", "zone", "zone 1", "zone1"]);
function isUsefulDeviceName(candidate) {
  const trimmed = (candidate != null ? candidate : "").trim();
  return trimmed.length > 0 && !GENERIC_ZONE_NAMES.has(trimmed.toLowerCase());
}
function nextDeviceLabel(current, deviceId, candidate, rank, ownName, ownRank) {
  const wanted = (candidate != null ? candidate : "").trim();
  if (!isUsefulDeviceName(wanted) || wanted === current) {
    return void 0;
  }
  const isPlaceholder = current === void 0 || current === deviceId;
  const isOurs = ownName !== void 0 && current === ownName;
  if (!isPlaceholder && !isOurs) {
    return void 0;
  }
  if (isOurs && ownRank !== void 0 && rank < ownRank) {
    return void 0;
  }
  return wanted;
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    LABEL_RANK,
    RENAMED_CHANNELS,
    RENAMED_STATE_IDS,
    childlessChannelIds,
    isUsefulDeviceName,
    legacyDeviceRow,
    mergeDiscovered,
    neverWrittenStateIds,
    nextDeviceLabel,
    parseDevices,
    renamedObjectIds,
    sanitizeId,
    staleObjects,
    stripNamespace,
  });
//# sourceMappingURL=pure-helpers.js.map

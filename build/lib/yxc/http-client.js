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
var http_client_exports = {};
__export(http_client_exports, {
  YXC_SUBSCRIPTION_HEADERS: () => YXC_SUBSCRIPTION_HEADERS,
  YamahaYxcClient: () => YamahaYxcClient,
  isWriteCommand: () => isWriteCommand,
});
module.exports = __toCommonJS(http_client_exports);
var import_node_http = require("node:http");
var import_util = require("../util");
function isWriteCommand(command) {
  var _a;
  const last = (_a = command.split("?")[0].split("/").pop()) != null ? _a : "";
  return /^(set|recall|toggle|start|stop|manage|prepare|control|switch)/.test(last);
}
const REQUEST_TIMEOUT_MS = 4e3;
const API_BASE = "/YamahaExtendedControl/v1";
const YXC_SUBSCRIPTION_HEADERS = {
  "X-AppName": "MusicCast/1.0",
  "X-AppPort": "41100",
};
function defaultSend(ip) {
  return (command, body) =>
    new Promise((resolve, reject) => {
      const url = `http://${ip}${API_BASE}${command}`;
      const onResponse = res => {
        let data = "";
        let bytes = 0;
        res.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > import_util.MAX_HTTP_BODY_BYTES) {
            res.destroy(new Error(`YXC response too large: ${command}`));
            return;
          }
          data += String(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(assertOk(JSON.parse(data), command));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      };
      const req =
        body === void 0
          ? (0, import_node_http.get)(url, { headers: { ...YXC_SUBSCRIPTION_HEADERS } }, onResponse)
          : (0, import_node_http.request)(
              url,
              { method: "POST", headers: { "Content-Type": "application/json", ...YXC_SUBSCRIPTION_HEADERS } },
              onResponse,
            );
      req.on("error", reject);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`YXC request timed out: ${command}`)));
      if (body !== void 0) {
        req.end(body);
      }
    });
}
function assertOk(payload, command) {
  const code = payload == null ? void 0 : payload.response_code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`device refused ${command} (response_code ${code})`);
  }
  return payload;
}
function zoneSeg(zone) {
  return encodeURIComponent(zone || "main");
}
function q(value) {
  return encodeURIComponent(String(value));
}
class YamahaYxcClient {
  send;
  /**
   * @param ip the device IP or hostname
   * @param send transport seam (defaults to a node:http GET); injected in tests
   * @param gate the device's command gate — when given, every request runs through it, so
   *   an embedded device never sees a burst of parallel requests and a stopped adapter
   *   cancels what is still queued. Commands that CHANGE something (`set…`, `recall…`,
   *   `toggle…`, `start/stop…`, `manage…` — the API names them consistently) are queued
   *   with user priority so a button press overtakes background polling.
   */
  constructor(ip, send = defaultSend(ip), gate) {
    this.send = gate
      ? (command, body) => gate.run(() => send(command, body), isWriteCommand(command) ? "user" : "background")
      : send;
  }
  /**
   * Read the device's capabilities (zones, functions, inputs, ranges).
   *
   * @returns the getFeatures response
   */
  getFeatures() {
    return this.send("/system/getFeatures");
  }
  /**
   * Read a zone's current status.
   *
   * @param zone the zone (`main`, `zone2`, …)
   * @returns the getStatus response
   */
  getStatus(zone) {
    return this.send(`/${zoneSeg(zone)}/getStatus`);
  }
  /**
   * Read the device's system info (model name, device id, firmware version).
   *
   * @returns the getDeviceInfo response
   */
  getDeviceInfo() {
    return this.send("/system/getDeviceInfo");
  }
  /**
   * Read the names a user gave this device's zones and inputs in the MusicCast app.
   * The main zone's text is what the device calls itself there.
   *
   * @returns the getNameText response
   */
  getNameText() {
    return this.send("/system/getNameText");
  }
  /**
   * Read a player source's play info.
   *
   * @param source the player: undefined = network/USB, `cd`, or `tuner`
   * @returns the getPlayInfo response
   */
  getPlayInfo(source) {
    const src = source === "cd" ? "cd" : source === "tuner" ? "tuner" : "netusb";
    return this.send(`/${src}/getPlayInfo`);
  }
  /**
   * Set a zone's power.
   *
   * @param on whether to power on (else standby)
   * @param zone the zone
   * @returns the command response
   */
  power(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setPower?power=${on ? "on" : "standby"}`);
  }
  /**
   * Set a zone's absolute volume (raw YXC scale).
   *
   * @param to the raw volume value
   * @param zone the zone
   * @returns the command response
   */
  setVolumeTo(to, zone) {
    return this.send(`/${zoneSeg(zone)}/setVolume?volume=${q(to)}`);
  }
  /**
   * Set a zone's mute.
   *
   * @param on whether to mute
   * @param zone the zone
   * @returns the command response
   */
  mute(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setMute?enable=${on ? "true" : "false"}`);
  }
  /**
   * Select a zone's input.
   *
   * @param input the input name
   * @param zone the zone
   * @returns the command response
   */
  setInput(input, zone) {
    return this.send(`/${zoneSeg(zone)}/setInput?input=${q(input)}`);
  }
  /**
   * Select a zone's sound program.
   *
   * @param program the sound program name
   * @param zone the zone
   * @returns the command response
   */
  setSound(program, zone) {
    return this.send(`/${zoneSeg(zone)}/setSoundProgram?program=${q(program)}`);
  }
  /**
   * Turn a zone's enhancer on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  setEnhancer(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setEnhancer?enable=${on ? "true" : "false"}`);
  }
  /**
   * Turn a zone's pure direct on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  setPureDirect(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setPureDirect?enable=${on ? "true" : "false"}`);
  }
  /**
   * Set a zone's subwoofer trim.
   *
   * @param to the trim value
   * @param zone the zone
   * @returns the command response
   */
  setSubwooferVolumeTo(to, zone) {
    return this.send(`/${zoneSeg(zone)}/setSubwooferVolume?volume=${q(to)}`);
  }
  /**
   * Set a zone's tone-control bass.
   *
   * @param to the bass value
   * @param zone the zone
   * @returns the command response
   */
  setBassTo(to, zone) {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&bass=${q(to)}`);
  }
  /**
   * Set a zone's tone-control treble.
   *
   * @param to the treble value
   * @param zone the zone
   * @returns the command response
   */
  setTrebleTo(to, zone) {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&treble=${q(to)}`);
  }
  /**
   * Set a zone's sleep timer in minutes.
   *
   * @param minutes the sleep timer
   * @param zone the zone
   * @returns the command response
   */
  sleep(minutes, zone) {
    return this.send(`/${zoneSeg(zone)}/setSleep?sleep=${q(minutes)}`);
  }
  /**
   * Turn a zone's Direct mode on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  setDirect(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setDirect?enable=${on ? "true" : "false"}`);
  }
  /**
   * Turn a zone's Clear Voice on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  setClearVoice(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setClearVoice?enable=${on ? "true" : "false"}`);
  }
  /**
   * Turn a zone's bass extension on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  setBassExtension(on, zone) {
    return this.send(`/${zoneSeg(zone)}/setBassExtension?enable=${on ? "true" : "false"}`);
  }
  /**
   * Set a zone's balance.
   *
   * @param value the balance value
   * @param zone the zone
   * @returns the command response
   */
  setBalance(value, zone) {
    return this.send(`/${zoneSeg(zone)}/setBalance?value=${q(value)}`);
  }
  /**
   * Set the manual graphic equalizer. The device takes all three bands in one call, so
   * the caller supplies low/mid/high together (the controller fills the unchanged two).
   *
   * @param low the low-band value
   * @param mid the mid-band value
   * @param high the high-band value
   * @param zone the target zone
   * @returns the device response
   */
  setEqualizer(low, mid, high, zone) {
    return this.send(`/${zoneSeg(zone)}/setEqualizer?mode=manual&low=${q(low)}&mid=${q(mid)}&high=${q(high)}`);
  }
  /**
   * Read the device's MusicCast-Link distribution state (role, group, client list).
   *
   * @returns the getDistributionInfo response
   */
  getDistributionInfo() {
    return this.send("/dist/getDistributionInfo");
  }
  /**
   * Set the group master's client roster (POST); part of the link/unlink sequence.
   *
   * @param info the server-info payload
   * @returns the device response
   */
  setServerInfo(info) {
    return this.send("/dist/setServerInfo", JSON.stringify(info));
  }
  /**
   * Set a group member's membership (POST); part of the link/unlink sequence.
   *
   * @param info the client-info payload
   * @returns the device response
   */
  setClientInfo(info) {
    return this.send("/dist/setClientInfo", JSON.stringify(info));
  }
  /**
   * Start distributing to the group's clients — called on the master after the infos are set.
   *
   * @param num the distribution number (0 for the default)
   * @returns the device response
   */
  startDistribution(num) {
    return this.send(`/dist/startDistribution?num=${q(num)}`);
  }
  /**
   * Stop distributing — called on the master to break up the group.
   *
   * @returns the device response
   */
  stopDistribution() {
    return this.send("/dist/stopDistribution");
  }
  /**
   * Start the network/USB player.
   *
   * @returns the command response
   */
  playNet() {
    return this.send("/netusb/setPlayback?playback=play");
  }
  /**
   * Pause the network/USB player.
   *
   * @returns the command response
   */
  pauseNet() {
    return this.send("/netusb/setPlayback?playback=pause");
  }
  /**
   * Stop the network/USB player.
   *
   * @returns the command response
   */
  stopNet() {
    return this.send("/netusb/setPlayback?playback=stop");
  }
  /**
   * Skip to the next track.
   *
   * @returns the command response
   */
  nextNet() {
    return this.send("/netusb/setPlayback?playback=next");
  }
  /**
   * Skip to the previous track.
   *
   * @returns the command response
   */
  prevNet() {
    return this.send("/netusb/setPlayback?playback=previous");
  }
  /**
   * Drive the CD transport with a YXC action word (`play`, `pause`, `stop`, `next`, `previous`).
   *
   * @param action the CD action word
   * @returns the command response
   */
  setCDPlayback(action) {
    return this.send(`/cd/setPlayback?playback=${q(action)}`);
  }
  /**
   * Toggle the network/USB player's repeat mode.
   *
   * @returns the command response
   */
  toggleNetRepeat() {
    return this.send("/netusb/toggleRepeat");
  }
  /**
   * Toggle the network/USB player's shuffle mode.
   *
   * @returns the command response
   */
  toggleNetShuffle() {
    return this.send("/netusb/toggleShuffle");
  }
  /**
   * Toggle the CD player's repeat mode.
   *
   * @returns the command response
   */
  toggleCDRepeat() {
    return this.send("/cd/toggleRepeat");
  }
  /**
   * Toggle the CD player's shuffle mode.
   *
   * @returns the command response
   */
  toggleCDShuffle() {
    return this.send("/cd/toggleShuffle");
  }
  /**
   * Open or close the CD tray.
   *
   * @returns the command response
   */
  toggleTray() {
    return this.send("/cd/toggleTray");
  }
  /**
   * Set the tuner band (`am`, `fm`, `dab`).
   *
   * @param band the band
   * @returns the command response
   */
  setBand(band) {
    return this.send(`/tuner/setBand?band=${q(band)}`);
  }
  /**
   * Set the tuner frequency for a band. `tuning` selects HOW to tune and is not optional:
   * the reference library sends `tuning=direct` for an absolute frequency
   * (`yamaha-yxc-nodejs/lib/yxc_api_cmd.js:1186` setFreqDirect). Without it the device
   * answers a non-zero response code and the write never reaches the tuner.
   *
   * @param band the band the frequency belongs to
   * @param freq the frequency (kHz, as the device reports it)
   * @returns the command response
   */
  setFreq(band, freq) {
    return this.send(`/tuner/setFreq?band=${q(band)}&tuning=direct&num=${q(freq)}`);
  }
  /**
   * Turn party mode on/off (system-wide).
   *
   * @param on whether to enable
   * @returns the command response
   */
  setPartyMode(on) {
    return this.send(`/system/setPartyMode?enable=${on ? "true" : "false"}`);
  }
  /**
   * Recall a stored network/USB preset.
   *
   * @param num the preset number
   * @param zone the zone
   * @returns the command response
   */
  recallPreset(num, zone) {
    return this.send(`/netusb/recallPreset?zone=${zoneSeg(zone)}&num=${q(num)}`);
  }
  /**
   * Read one window of a netusb source's browsable list (menu browsing, #613). The
   * URL mirrors `yamaha-yxc-nodejs` getListInfo (list_id omitted = the main list).
   *
   * @param input the netusb input (net_radio, server, usb, …)
   * @param index the 0-based index of the window's first entry
   * @param size how many entries to fetch (the device caps at 8)
   * @returns the list_info response
   */
  getListInfo(input, index, size = 8) {
    return this.send(`/netusb/getListInfo?input=${q(input)}&index=${q(index)}&size=${q(size)}`);
  }
  /**
   * Drive the netusb list (`yamaha-yxc-nodejs` setListControl, list_id `main`):
   * select a folder / play an item by absolute index, or go one level back.
   *
   * @param type the operation (select opens a folder, play starts an item, return goes back)
   * @param index the absolute entry index (select/play only)
   * @param zone the zone that receives a played item
   * @returns the command response
   */
  setListControl(type, index, zone) {
    const indexSeg = index === void 0 ? "" : `&index=${q(index)}`;
    const zoneSegment = zone === void 0 ? "" : `&zone=${zoneSeg(zone)}`;
    return this.send(`/netusb/setListControl?list_id=main&type=${q(type)}${indexSeg}${zoneSegment}`);
  }
  /**
   * Read the stored network/USB favourites (preset slots with their names).
   *
   * @returns the preset_info response
   */
  getPresetInfo() {
    return this.send("/netusb/getPresetInfo");
  }
  /**
   * Read the recently played network/USB items.
   *
   * @returns the recent_info response
   */
  getRecentInfo() {
    return this.send("/netusb/getRecentInfo");
  }
  /**
   * Recall an entry from the recently-played list.
   *
   * @param num the recent-list position (1-based)
   * @param zone the zone
   * @returns the command response
   */
  recallRecentItem(num, zone) {
    return this.send(`/netusb/recallRecentItem?zone=${zoneSeg(zone)}&num=${q(num)}`);
  }
  /**
   * Read the tuner preset list for one band (`common` on devices with a shared list).
   *
   * @param band the band (`common`, `am`, `fm`, `dab`)
   * @returns the preset_info response
   */
  getTunerPresetInfo(band) {
    return this.send(`/tuner/getPresetInfo?band=${q(band)}`);
  }
  /**
   * Recall a tuner preset. The URL is the official YXC form (verified against
   * aiomusiccast, the Home-Assistant reference client).
   *
   * @param band the band the preset list belongs to (`common`, `am`, `fm`, `dab`)
   * @param num the preset number
   * @param zone the zone
   * @returns the command response
   */
  recallTunerPreset(band, num, zone) {
    return this.send(`/tuner/recallPreset?zone=${zoneSeg(zone)}&band=${q(band)}&num=${q(num)}`);
  }
  /**
   * Step to the next/previous stored tuner preset.
   *
   * @param direction `next` or `previous`
   * @returns the command response
   */
  switchTunerPreset(direction) {
    return this.send(`/tuner/switchPreset?dir=${q(direction)}`);
  }
  /**
   * Read the clock/alarm settings block.
   *
   * @returns the getSettings response
   */
  getClockSettings() {
    return this.send("/clock/getSettings");
  }
  /**
   * Recall a zone's scene (#615). Endpoint and parameter verified against a live
   * RX-V6A (main and zone2 answer the parameter probe; `setScene` does not exist).
   *
   * @param num the scene number (1-based)
   * @param zone the zone
   * @returns the command response
   */
  recallScene(num, zone) {
    return this.send(`/${zoneSeg(zone)}/recallScene?num=${q(num)}`);
  }
  /**
   * Drive the on-screen cursor (the remote's arrow pad). Vocabulary verified against
   * a live RX-V6A (invalid values answer code 4): up/down/left/right/select/return.
   *
   * @param cursor the cursor action
   * @param zone the zone
   * @returns the command response
   */
  controlCursor(cursor, zone) {
    return this.send(`/${zoneSeg(zone)}/controlCursor?cursor=${q(cursor)}`);
  }
  /**
   * Drive the on-screen menus (the remote's menu keys). Vocabulary verified against
   * a live RX-V6A: on_screen/top_menu/menu/option/display/home.
   *
   * @param menu the menu action
   * @param zone the zone
   * @returns the command response
   */
  controlMenu(menu, zone) {
    return this.send(`/${zoneSeg(zone)}/controlMenu?menu=${q(menu)}`);
  }
  /**
   * Read a zone's audio signal info (format, sampling rate, bit depth, bitrate).
   *
   * @param zone the zone
   * @returns the getSignalInfo response
   */
  getSignalInfo(zone) {
    return this.send(`/${zoneSeg(zone)}/getSignalInfo`);
  }
  /**
   * Read the names of the MusicCast playlists (the app-managed lists).
   *
   * @returns the getMcPlaylistName response
   */
  getMcPlaylistName() {
    return this.send("/netusb/getMcPlaylistName");
  }
  /**
   * Read one window of the network player's play queue.
   *
   * @param index the 0-based index of the window's first entry
   * @param size how many entries to fetch (the device caps at 8)
   * @returns the getPlayQueue response
   */
  getPlayQueue(index = 0, size = 8) {
    return this.send(`/netusb/getPlayQueue?index=${q(index)}&size=${q(size)}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    YXC_SUBSCRIPTION_HEADERS,
    YamahaYxcClient,
    isWriteCommand,
  });
//# sourceMappingURL=http-client.js.map

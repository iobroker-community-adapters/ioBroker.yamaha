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
var http_client_exports = {};
__export(http_client_exports, {
  YamahaYxcClient: () => YamahaYxcClient
});
module.exports = __toCommonJS(http_client_exports);
var import_node_http = require("node:http");
const REQUEST_TIMEOUT_MS = 4e3;
const API_BASE = "/YamahaExtendedControl/v1";
function defaultSend(ip) {
  return (command, body) => new Promise((resolve, reject) => {
    const url = `http://${ip}${API_BASE}${command}`;
    const onResponse = (res) => {
      let data = "";
      res.on("data", (chunk) => data += String(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    };
    const req = body === void 0 ? (0, import_node_http.get)(url, onResponse) : (0, import_node_http.request)(url, { method: "POST", headers: { "Content-Type": "application/json" } }, onResponse);
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`YXC request timed out: ${command}`)));
    if (body !== void 0) {
      req.end(body);
    }
  });
}
function zoneSeg(zone) {
  return zone || "main";
}
class YamahaYxcClient {
  send;
  /**
   * @param ip the device IP or hostname
   * @param send transport seam (defaults to a node:http GET); injected in tests
   */
  constructor(ip, send = defaultSend(ip)) {
    this.send = send;
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
    return this.send(`/${zoneSeg(zone)}/setVolume?volume=${to}`);
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
    return this.send(`/${zoneSeg(zone)}/setInput?input=${input}`);
  }
  /**
   * Select a zone's sound program.
   *
   * @param program the sound program name
   * @param zone the zone
   * @returns the command response
   */
  setSound(program, zone) {
    return this.send(`/${zoneSeg(zone)}/setSoundProgram?program=${program}`);
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
    return this.send(`/${zoneSeg(zone)}/setSubwooferVolume?volume=${to}`);
  }
  /**
   * Set a zone's tone-control bass.
   *
   * @param to the bass value
   * @param zone the zone
   * @returns the command response
   */
  setBassTo(to, zone) {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&bass=${to}`);
  }
  /**
   * Set a zone's tone-control treble.
   *
   * @param to the treble value
   * @param zone the zone
   * @returns the command response
   */
  setTrebleTo(to, zone) {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&treble=${to}`);
  }
  /**
   * Set a zone's sleep timer in minutes.
   *
   * @param minutes the sleep timer
   * @param zone the zone
   * @returns the command response
   */
  sleep(minutes, zone) {
    return this.send(`/${zoneSeg(zone)}/setSleep?sleep=${minutes}`);
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
    return this.send(`/${zoneSeg(zone)}/setBalance?value=${value}`);
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
    return this.send(`/${zoneSeg(zone)}/setEqualizer?mode=manual&low=${low}&mid=${mid}&high=${high}`);
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
    return this.send(`/dist/startDistribution?num=${num}`);
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
    return this.send(`/cd/setPlayback?playback=${action}`);
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
    return this.send(`/tuner/setBand?band=${band}`);
  }
  /**
   * Set the tuner frequency for a band (the device needs both band and value).
   *
   * @param band the band the frequency belongs to
   * @param freq the frequency (kHz, as the device reports it)
   * @returns the command response
   */
  setFreq(band, freq) {
    return this.send(`/tuner/setFreq?band=${band}&num=${freq}`);
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
    return this.send(`/netusb/recallPreset?zone=${zoneSeg(zone)}&num=${num}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YamahaYxcClient
});
//# sourceMappingURL=http-client.js.map

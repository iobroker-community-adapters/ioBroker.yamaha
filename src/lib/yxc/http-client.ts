import { get as httpGet, request as httpRequest, type IncomingMessage } from "node:http";
import type { CommandGate } from "../lifecycle/command-gate";

/**
 * Whether a command path changes something on the device (as opposed to reading). The
 * MusicCast API names its endpoints consistently, so the verb at the start of the last
 * path segment decides — that is enough to give user actions priority in the gate.
 *
 * @param command the API command path
 * @returns true for a write/action command
 */
function isWriteCommand(command: string): boolean {
  const last = command.split("?")[0].split("/").pop() ?? "";
  return /^(set|recall|toggle|start|stop|manage|prepare)/.test(last);
}

/** Timeout for a single YXC HTTP request, so an unresponsive device cannot hang the keepalive. */
const REQUEST_TIMEOUT_MS = 4000;

/** Base path of the Yamaha Extended Control HTTP API. */
const API_BASE = "/YamahaExtendedControl/v1";

/**
 * Event-subscription headers, sent with EVERY request (as `yamaha-yxc-nodejs` did —
 * `yxc_api_cmd.js` SendReqToDevice). They are what makes the device push its UDP
 * events to this host on :41100; without them no push ever arrives and every YXC
 * state falls back to the 5-minute keepalive poll. The regular keepalive requests
 * carrying these headers are also what renews the subscription before it expires.
 */
export const YXC_SUBSCRIPTION_HEADERS: Readonly<Record<string, string>> = {
  "X-AppName": "MusicCast/1.0",
  "X-AppPort": "41100",
};

/** Sends a command path and resolves the parsed JSON body — the injectable transport seam. */
export type YxcSend = (command: string, body?: string) => Promise<unknown>;

/** Payload for `/dist/setServerInfo` — the group master's client roster (link_unlink.js). */
export interface YxcServerInfo {
  /** The shared group id (identical on the server and every client). */
  group_id: string;
  /** The server's zone contributing to the group. */
  zone: string;
  /** Whether the listed clients are being added to or removed from the group. */
  type: "add" | "remove";
  /** The client device IPs in the group. */
  client_list: string[];
}

/** Payload for `/dist/setClientInfo` — a group member joining or leaving (link_unlink.js). */
export interface YxcClientInfo {
  /** The shared group id, or an empty string to leave the group. */
  group_id: string;
  /** The client's zones taking part in the group. */
  zone: string[];
}

/**
 * Send `http://<ip><API_BASE><command>` over node:http and resolve its parsed JSON,
 * with a timeout. A GET by default; a POST with a JSON body when `body` is given (the
 * distribution setters need POST). Used as the default transport.
 *
 * @param ip the device IP or hostname
 * @returns a send function bound to that device
 */
function defaultSend(ip: string): YxcSend {
  return (command, body) =>
    new Promise((resolve, reject) => {
      const url = `http://${ip}${API_BASE}${command}`;
      const onResponse = (res: IncomingMessage): void => {
        let data = "";
        res.on("data", chunk => (data += String(chunk)));
        // A connection dropped mid-body emits on the RESPONSE stream, not the request —
        // without this handler that is an unhandled error event, not a rejected promise.
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
        body === undefined
          ? httpGet(url, { headers: { ...YXC_SUBSCRIPTION_HEADERS } }, onResponse)
          : httpRequest(
              url,
              { method: "POST", headers: { "Content-Type": "application/json", ...YXC_SUBSCRIPTION_HEADERS } },
              onResponse,
            );
      req.on("error", reject);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`YXC request timed out: ${command}`)));
      if (body !== undefined) {
        req.end(body);
      }
    });
}

/**
 * The device's own verdict on a request. Every MusicCast answer carries `response_code`
 * (0 = success); anything else means the device REFUSED the request — a wrong input for
 * this zone, a feature the model lacks, a source that is not selected. Without this check
 * a refusal looked exactly like a success: the keepalive counted a refusing device as
 * healthy (so its states froze silently instead of the device being reconnected), and a
 * rejected write produced no warning at all. Turning it into an error lets the existing
 * try/catch paths and the drop detection do their job.
 *
 * @param payload the parsed response body
 * @param command the command path, for the message
 * @returns the payload when the device accepted the request
 */
function assertOk(payload: unknown, command: string): unknown {
  const code = (payload as { response_code?: unknown } | null)?.response_code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`device refused ${command} (response_code ${code})`);
  }
  return payload;
}

/**
 * Map a zone name to its API path segment (the library's getZone for the names we
 * use: main/zone2/zone3/zone4, defaulting an empty zone to main).
 *
 * @param zone the unified zone name
 * @returns the path segment
 */
function zoneSeg(zone?: string): string {
  return encodeURIComponent(zone || "main");
}

/**
 * Percent-encode a value going into a query parameter. The states are dropdowns, but
 * ioBroker lets any script write any string — an unencoded space or `&` would either make
 * the request throw or silently smuggle a second parameter into the device call.
 *
 * @param value the raw value
 * @returns the encoded value
 */
function q(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * A minimal HTTP client for the Yamaha Extended Control (MusicCast) API. Replaces the
 * `yamaha-yxc-nodejs` library, which pulled vulnerable transitive dependencies
 * (`simple-ssdp`, `@root/request`) in through an SSDP-discovery path this adapter never
 * used — the adapter only ever called these HTTP command methods. Each method builds the
 * exact command URL the library built (unit-verified against its source) and GETs it.
 */
export class YamahaYxcClient {
  private readonly send: YxcSend;

  /**
   * @param ip the device IP or hostname
   * @param send transport seam (defaults to a node:http GET); injected in tests
   * @param gate the device's command gate — when given, every request runs through it, so
   *   an embedded device never sees a burst of parallel requests and a stopped adapter
   *   cancels what is still queued. Commands that CHANGE something (`set…`, `recall…`,
   *   `toggle…`, `start/stop…`, `manage…` — the API names them consistently) are queued
   *   with user priority so a button press overtakes background polling.
   */
  public constructor(ip: string, send: YxcSend = defaultSend(ip), gate?: CommandGate) {
    this.send = gate
      ? (command, body) => gate.run(() => send(command, body), isWriteCommand(command) ? "user" : "background")
      : send;
  }

  /**
   * Read the device's capabilities (zones, functions, inputs, ranges).
   *
   * @returns the getFeatures response
   */
  public getFeatures(): Promise<unknown> {
    return this.send("/system/getFeatures");
  }

  /**
   * Read a zone's current status.
   *
   * @param zone the zone (`main`, `zone2`, …)
   * @returns the getStatus response
   */
  public getStatus(zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/getStatus`);
  }

  /**
   * Read the device's system info (model name, device id, firmware version).
   *
   * @returns the getDeviceInfo response
   */
  public getDeviceInfo(): Promise<unknown> {
    return this.send("/system/getDeviceInfo");
  }

  /**
   * Read the names a user gave this device's zones and inputs in the MusicCast app.
   * The main zone's text is what the device calls itself there.
   *
   * @returns the getNameText response
   */
  public getNameText(): Promise<unknown> {
    return this.send("/system/getNameText");
  }

  /**
   * Read a player source's play info.
   *
   * @param source the player: undefined = network/USB, `cd`, or `tuner`
   * @returns the getPlayInfo response
   */
  public getPlayInfo(source?: string): Promise<unknown> {
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
  public power(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setPower?power=${on ? "on" : "standby"}`);
  }

  /**
   * Set a zone's absolute volume (raw YXC scale).
   *
   * @param to the raw volume value
   * @param zone the zone
   * @returns the command response
   */
  public setVolumeTo(to: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setVolume?volume=${q(to)}`);
  }

  /**
   * Set a zone's mute.
   *
   * @param on whether to mute
   * @param zone the zone
   * @returns the command response
   */
  public mute(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setMute?enable=${on ? "true" : "false"}`);
  }

  /**
   * Select a zone's input.
   *
   * @param input the input name
   * @param zone the zone
   * @returns the command response
   */
  public setInput(input: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setInput?input=${q(input)}`);
  }

  /**
   * Select a zone's sound program.
   *
   * @param program the sound program name
   * @param zone the zone
   * @returns the command response
   */
  public setSound(program: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setSoundProgram?program=${q(program)}`);
  }

  /**
   * Turn a zone's enhancer on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setEnhancer(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setEnhancer?enable=${on ? "true" : "false"}`);
  }

  /**
   * Turn a zone's pure direct on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setPureDirect(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setPureDirect?enable=${on ? "true" : "false"}`);
  }

  /**
   * Set a zone's subwoofer trim.
   *
   * @param to the trim value
   * @param zone the zone
   * @returns the command response
   */
  public setSubwooferVolumeTo(to: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setSubwooferVolume?volume=${q(to)}`);
  }

  /**
   * Set a zone's tone-control bass.
   *
   * @param to the bass value
   * @param zone the zone
   * @returns the command response
   */
  public setBassTo(to: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&bass=${q(to)}`);
  }

  /**
   * Set a zone's tone-control treble.
   *
   * @param to the treble value
   * @param zone the zone
   * @returns the command response
   */
  public setTrebleTo(to: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&treble=${q(to)}`);
  }

  /**
   * Set a zone's sleep timer in minutes.
   *
   * @param minutes the sleep timer
   * @param zone the zone
   * @returns the command response
   */
  public sleep(minutes: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setSleep?sleep=${q(minutes)}`);
  }

  /**
   * Turn a zone's Direct mode on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setDirect(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setDirect?enable=${on ? "true" : "false"}`);
  }

  /**
   * Turn a zone's Clear Voice on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setClearVoice(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setClearVoice?enable=${on ? "true" : "false"}`);
  }

  /**
   * Turn a zone's bass extension on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setBassExtension(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setBassExtension?enable=${on ? "true" : "false"}`);
  }

  /**
   * Set a zone's balance.
   *
   * @param value the balance value
   * @param zone the zone
   * @returns the command response
   */
  public setBalance(value: number, zone: string): Promise<unknown> {
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
  public setEqualizer(low: number, mid: number, high: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setEqualizer?mode=manual&low=${q(low)}&mid=${q(mid)}&high=${q(high)}`);
  }

  /**
   * Read the device's MusicCast-Link distribution state (role, group, client list).
   *
   * @returns the getDistributionInfo response
   */
  public getDistributionInfo(): Promise<unknown> {
    return this.send("/dist/getDistributionInfo");
  }

  /**
   * Set the group master's client roster (POST); part of the link/unlink sequence.
   *
   * @param info the server-info payload
   * @returns the device response
   */
  public setServerInfo(info: YxcServerInfo): Promise<unknown> {
    return this.send("/dist/setServerInfo", JSON.stringify(info));
  }

  /**
   * Set a group member's membership (POST); part of the link/unlink sequence.
   *
   * @param info the client-info payload
   * @returns the device response
   */
  public setClientInfo(info: YxcClientInfo): Promise<unknown> {
    return this.send("/dist/setClientInfo", JSON.stringify(info));
  }

  /**
   * Start distributing to the group's clients — called on the master after the infos are set.
   *
   * @param num the distribution number (0 for the default)
   * @returns the device response
   */
  public startDistribution(num: number): Promise<unknown> {
    return this.send(`/dist/startDistribution?num=${q(num)}`);
  }

  /**
   * Stop distributing — called on the master to break up the group.
   *
   * @returns the device response
   */
  public stopDistribution(): Promise<unknown> {
    return this.send("/dist/stopDistribution");
  }

  /**
   * Start the network/USB player.
   *
   * @returns the command response
   */
  public playNet(): Promise<unknown> {
    return this.send("/netusb/setPlayback?playback=play");
  }

  /**
   * Pause the network/USB player.
   *
   * @returns the command response
   */
  public pauseNet(): Promise<unknown> {
    return this.send("/netusb/setPlayback?playback=pause");
  }

  /**
   * Stop the network/USB player.
   *
   * @returns the command response
   */
  public stopNet(): Promise<unknown> {
    return this.send("/netusb/setPlayback?playback=stop");
  }

  /**
   * Skip to the next track.
   *
   * @returns the command response
   */
  public nextNet(): Promise<unknown> {
    return this.send("/netusb/setPlayback?playback=next");
  }

  /**
   * Skip to the previous track.
   *
   * @returns the command response
   */
  public prevNet(): Promise<unknown> {
    return this.send("/netusb/setPlayback?playback=previous");
  }

  /**
   * Drive the CD transport with a YXC action word (`play`, `pause`, `stop`, `next`, `previous`).
   *
   * @param action the CD action word
   * @returns the command response
   */
  public setCDPlayback(action: string): Promise<unknown> {
    return this.send(`/cd/setPlayback?playback=${q(action)}`);
  }

  /**
   * Toggle the network/USB player's repeat mode.
   *
   * @returns the command response
   */
  public toggleNetRepeat(): Promise<unknown> {
    return this.send("/netusb/toggleRepeat");
  }

  /**
   * Toggle the network/USB player's shuffle mode.
   *
   * @returns the command response
   */
  public toggleNetShuffle(): Promise<unknown> {
    return this.send("/netusb/toggleShuffle");
  }

  /**
   * Toggle the CD player's repeat mode.
   *
   * @returns the command response
   */
  public toggleCDRepeat(): Promise<unknown> {
    return this.send("/cd/toggleRepeat");
  }

  /**
   * Toggle the CD player's shuffle mode.
   *
   * @returns the command response
   */
  public toggleCDShuffle(): Promise<unknown> {
    return this.send("/cd/toggleShuffle");
  }

  /**
   * Open or close the CD tray.
   *
   * @returns the command response
   */
  public toggleTray(): Promise<unknown> {
    return this.send("/cd/toggleTray");
  }

  /**
   * Set the tuner band (`am`, `fm`, `dab`).
   *
   * @param band the band
   * @returns the command response
   */
  public setBand(band: string): Promise<unknown> {
    return this.send(`/tuner/setBand?band=${q(band)}`);
  }

  /**
   * Set the tuner frequency for a band (the device needs both band and value).
   *
   * @param band the band the frequency belongs to
   * @param freq the frequency (kHz, as the device reports it)
   * @returns the command response
   */
  public setFreq(band: string, freq: number): Promise<unknown> {
    return this.send(`/tuner/setFreq?band=${q(band)}&num=${q(freq)}`);
  }

  /**
   * Turn party mode on/off (system-wide).
   *
   * @param on whether to enable
   * @returns the command response
   */
  public setPartyMode(on: boolean): Promise<unknown> {
    return this.send(`/system/setPartyMode?enable=${on ? "true" : "false"}`);
  }

  /**
   * Recall a stored network/USB preset.
   *
   * @param num the preset number
   * @param zone the zone
   * @returns the command response
   */
  public recallPreset(num: number, zone: string): Promise<unknown> {
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
  public getListInfo(input: string, index: number, size = 8): Promise<unknown> {
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
  public setListControl(type: "select" | "play" | "return", index?: number, zone?: string): Promise<unknown> {
    const indexSeg = index === undefined ? "" : `&index=${q(index)}`;
    const zoneSegment = zone === undefined ? "" : `&zone=${zoneSeg(zone)}`;
    return this.send(`/netusb/setListControl?list_id=main&type=${q(type)}${indexSeg}${zoneSegment}`);
  }

  /**
   * Read the stored network/USB favourites (preset slots with their names).
   *
   * @returns the preset_info response
   */
  public getPresetInfo(): Promise<unknown> {
    return this.send("/netusb/getPresetInfo");
  }

  /**
   * Read the recently played network/USB items.
   *
   * @returns the recent_info response
   */
  public getRecentInfo(): Promise<unknown> {
    return this.send("/netusb/getRecentInfo");
  }

  /**
   * Recall an entry from the recently-played list.
   *
   * @param num the recent-list position (1-based)
   * @param zone the zone
   * @returns the command response
   */
  public recallRecentItem(num: number, zone: string): Promise<unknown> {
    return this.send(`/netusb/recallRecentItem?zone=${zoneSeg(zone)}&num=${q(num)}`);
  }

  /**
   * Read the tuner preset list for one band (`common` on devices with a shared list).
   *
   * @param band the band (`common`, `am`, `fm`, `dab`)
   * @returns the preset_info response
   */
  public getTunerPresetInfo(band: string): Promise<unknown> {
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
  public recallTunerPreset(band: string, num: number, zone: string): Promise<unknown> {
    return this.send(`/tuner/recallPreset?zone=${zoneSeg(zone)}&band=${q(band)}&num=${q(num)}`);
  }

  /**
   * Step to the next/previous stored tuner preset.
   *
   * @param direction `next` or `previous`
   * @returns the command response
   */
  public switchTunerPreset(direction: "next" | "previous"): Promise<unknown> {
    return this.send(`/tuner/switchPreset?dir=${q(direction)}`);
  }

  /**
   * Read the clock/alarm settings block.
   *
   * @returns the getSettings response
   */
  public getClockSettings(): Promise<unknown> {
    return this.send("/clock/getSettings");
  }
}

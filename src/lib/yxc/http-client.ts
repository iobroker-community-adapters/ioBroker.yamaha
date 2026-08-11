import { get as httpGet, request as httpRequest, type IncomingMessage } from "node:http";

/** Timeout for a single YXC HTTP request, so an unresponsive device cannot hang the keepalive. */
const REQUEST_TIMEOUT_MS = 4000;

/** Base path of the Yamaha Extended Control HTTP API. */
const API_BASE = "/YamahaExtendedControl/v1";

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
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      };
      const req =
        body === undefined
          ? httpGet(url, onResponse)
          : httpRequest(url, { method: "POST", headers: { "Content-Type": "application/json" } }, onResponse);
      req.on("error", reject);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`YXC request timed out: ${command}`)));
      if (body !== undefined) {
        req.end(body);
      }
    });
}

/**
 * Map a zone name to its API path segment (the library's getZone for the names we
 * use: main/zone2/zone3/zone4, defaulting an empty zone to main).
 *
 * @param zone the unified zone name
 * @returns the path segment
 */
function zoneSeg(zone?: string): string {
  return zone || "main";
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
   */
  public constructor(ip: string, send: YxcSend = defaultSend(ip)) {
    this.send = send;
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
    return this.send(`/${zoneSeg(zone)}/setVolume?volume=${to}`);
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
    return this.send(`/${zoneSeg(zone)}/setInput?input=${input}`);
  }

  /**
   * Select a zone's sound program.
   *
   * @param program the sound program name
   * @param zone the zone
   * @returns the command response
   */
  public setSound(program: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setSoundProgram?program=${program}`);
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
    return this.send(`/${zoneSeg(zone)}/setSubwooferVolume?volume=${to}`);
  }

  /**
   * Set a zone's tone-control bass.
   *
   * @param to the bass value
   * @param zone the zone
   * @returns the command response
   */
  public setBassTo(to: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&bass=${to}`);
  }

  /**
   * Set a zone's tone-control treble.
   *
   * @param to the treble value
   * @param zone the zone
   * @returns the command response
   */
  public setTrebleTo(to: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=manual&treble=${to}`);
  }

  /**
   * Set a zone's sleep timer in minutes.
   *
   * @param minutes the sleep timer
   * @param zone the zone
   * @returns the command response
   */
  public sleep(minutes: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setSleep?sleep=${minutes}`);
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
  public setEqualizer(low: number, mid: number, high: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setEqualizer?mode=manual&low=${low}&mid=${mid}&high=${high}`);
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
    return this.send(`/dist/startDistribution?num=${num}`);
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
    return this.send(`/cd/setPlayback?playback=${action}`);
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
    return this.send(`/tuner/setBand?band=${band}`);
  }

  /**
   * Set the tuner frequency for a band (the device needs both band and value).
   *
   * @param band the band the frequency belongs to
   * @param freq the frequency (kHz, as the device reports it)
   * @returns the command response
   */
  public setFreq(band: string, freq: number): Promise<unknown> {
    return this.send(`/tuner/setFreq?band=${band}&num=${freq}`);
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
    return this.send(`/netusb/recallPreset?zone=${zoneSeg(zone)}&num=${num}`);
  }
}

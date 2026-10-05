import { get as httpGet, request as httpRequest, type IncomingMessage } from "node:http";
import type { CommandGate } from "../lifecycle/command-gate";
import { HttpStatusError, readDeviceResponse } from "../util";
import { errText } from "../err-text";

/**
 * Whether a command path changes something on the device (as opposed to reading). The MusicCast API
 * names its endpoints consistently: a READ starts its last path segment with `get`, and everything
 * else — set, recall, toggle, start, stop, control, switch, store, clear, and whatever verb a later
 * endpoint brings — acts. So a button press queues with USER priority and overtakes a running
 * background sweep. The verb list this replaced named verbs no endpoint used and would have demoted a
 * new action verb to background (review 2026-10-05, F).
 *
 * @param command the API command path
 * @returns true for a write/action command
 */
export function isWriteCommand(command: string): boolean {
  const last = command.split("?")[0].split("/").pop() ?? "";
  return !/^get/.test(last);
}

/**
 * A switch value as the API spells it (`enable=true`) — one place instead of eighteen.
 *
 * @param on the switch value
 * @returns `true` or `false`
 */
function flag(on: boolean): string {
  return on ? "true" : "false";
}

/** A media player the transport keys drive — its path segment in the API. */
export type YxcPlayer = "netusb" | "cd";

/** The playback words both players take (YXC Basic §7.3 netusb, §8.2 cd). */
export type YxcPlayback = "play" | "pause" | "stop" | "next" | "previous";

/** Timeout for a single YXC HTTP request, so an unresponsive device cannot hang the keepalive. */
const REQUEST_TIMEOUT_MS = 4000;

/**
 * `getListInfo` may take up to 30 seconds and blocks every other command meanwhile (YXC Basic
 * Rev 1.10 §13.1.6). Cut at 4 s it counted as "no answer": the gate let the next command through to
 * a device still busy, that one timed out too, and the liveness check that follows reported the
 * device gone (audit 2026-09-24, C26).
 */
const LIST_INFO_TIMEOUT_MS = 30_000;

/**
 * How long one request may take before it counts as unanswered.
 *
 * @param command the command path
 * @returns the timeout in ms
 */
export function requestTimeoutFor(command: string): number {
  return command.startsWith("/netusb/getListInfo") ? LIST_INFO_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

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

/**
 * A request that never reached a device answer: the connection was refused or reset, the
 * host is unreachable, or the request timed out. Distinct from a device refusal
 * (`response_code` ≠ 0) so the controller can tell "the device said no" from "nothing
 * answered" — only the latter is a reason to check whether the device is still alive.
 */
export class YxcTransportError extends Error {
  /**
   * @param command the command path that failed
   * @param cause the underlying socket or timeout error
   */
  public constructor(command: string, cause: Error) {
    // Through the helper (an empty-message AggregateError still says its code, E14); the command is
    // added only where the cause does not already name it.
    const reason = errText(cause);
    super(reason.includes(command) ? reason : `${reason} (${command})`, { cause });
    this.name = "YxcTransportError";
  }
}

/**
 * What a MusicCast `response_code` means — the tables of YXC Basic Rev 1.00 §9 / Rev 1.10 §10 and
 * YXC Advanced §6 (which adds 113–115 and the 200s), worded as the specification words them. A log
 * line that said only "response_code 5" left the reader to look it up (audit 2026-09-24, C23).
 */
export const YXC_RESPONSE_CODES: Readonly<Record<number, string>> = {
  1: "Initializing",
  2: "Internal Error",
  3: "Invalid Request",
  4: "Invalid Parameter",
  5: "Guarded",
  6: "Time Out",
  99: "Firmware Updating",
  100: "Access Error",
  101: "Other Errors",
  102: "Wrong User Name",
  103: "Wrong Password",
  104: "Account Expired",
  105: "Account Disconnected/Gone Off/Shut Down",
  106: "Account Number Reached to the Limit",
  107: "Server Maintenance",
  108: "Invalid Account",
  109: "License Error",
  110: "Read Only Mode",
  111: "Max Stations",
  112: "Access Denied",
  113: "There is a need to specify the additional destination Playlist",
  114: "There is a need to create a new Playlist",
  115: "Simultaneous logins has reached the upper limit",
  200: "Linking in progress",
  201: "Unlinking in progress",
};

/**
 * The device answered — and said no (`response_code` ≠ 0). Proof that it is there: a refusal
 * never makes a device "unreachable" (audit 2026-09-24, C15), and a refused write is read back so
 * the datapoint shows what the device kept (C28).
 */
export class YxcRefusalError extends Error {
  /**
   * @param command the command path the device refused
   * @param code the device's `response_code`
   */
  public constructor(
    command: string,
    public readonly code: number,
  ) {
    const meaning = YXC_RESPONSE_CODES[code];
    super(`device refused ${command} (response_code ${code}${meaning ? `: ${meaning}` : ""})`);
    this.name = "YxcRefusalError";
  }
}

/** Sends a command path and resolves the parsed JSON body — the injectable transport seam. */
export type YxcSend = (command: string, body?: string) => Promise<unknown>;

/** Payload for `/dist/setServerInfo` — the group master's client roster (link_unlink.js). */
export interface YxcServerInfo {
  /** The shared group id (identical on the server and every client); "" ends the server role. */
  group_id: string;
  /** The server's zone contributing to the group (YXC Advanced §5.2: optional). */
  zone?: string;
  /** Whether the listed clients are being added to or removed from the group (optional when ending). */
  type?: "add" | "remove";
  /** The client device IPs in the group (optional when ending). */
  client_list?: string[];
}

/** Payload for `/dist/setClientInfo` — a group member joining or leaving (link_unlink.js). */
export interface YxcClientInfo {
  /** The shared group id, or an empty string to leave the group. */
  group_id: string;
  /** The client's zones taking part in the group — not needed when leaving (YXC Advanced §5.3). */
  zone?: string[];
  /** The server's IPv4 address (YXC Advanced §5.3). */
  server_ip_address?: string;
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
      const transportFailure = (e: Error): void => reject(new YxcTransportError(command, e));
      const onResponse = (res: IncomingMessage): void => {
        // Bytes decoded once ("Die Ärzte" arrived as "Die ��rzte", audit 2026-09-24 C5), capped, and the
        // status judged: an error page is the device's (or its booting web server's) answer, never JSON
        // to parse — it travels as `HttpStatusError`, which is no lost connection.
        readDeviceResponse(res, command).then(
          text => {
            try {
              resolve(assertOk(JSON.parse(text), command));
            } catch (e) {
              reject(e instanceof Error ? e : new Error(errText(e)));
            }
          },
          (e: Error) => (e instanceof HttpStatusError ? reject(e) : transportFailure(e)),
        );
      };
      const req =
        body === undefined
          ? httpGet(url, { headers: { ...YXC_SUBSCRIPTION_HEADERS } }, onResponse)
          : httpRequest(
              url,
              { method: "POST", headers: { "Content-Type": "application/json", ...YXC_SUBSCRIPTION_HEADERS } },
              onResponse,
            );
      // Refused, reset, unreachable — and the timeout below, which destroys the request with
      // its own error and lands here too. All of them: no device answered.
      req.on("error", transportFailure);
      req.setTimeout(requestTimeoutFor(command), () => req.destroy(new Error(`YXC request timed out: ${command}`)));
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
    throw new YxcRefusalError(command, code);
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
 * used — the adapter only ever called these HTTP command methods. Each method builds its
 * command URL — the library's where it had one (unit-verified against its source), otherwise
 * per the YXC specification or the aiomusiccast/pyamaha reference — and sends it as a GET, or as
 * a POST with a JSON body where the API requires one.
 */
export class YamahaYxcClient {
  private readonly send: YxcSend;

  /**
   * @param ip the device IP or hostname
   * @param send transport seam (defaults to node:http: GET, POST when a body is given); injected in tests
   * @param gate the device's command gate — when given, every request runs through it, so
   *   an embedded device never sees a burst of parallel requests and a stopped adapter
   *   cancels what is still queued. Commands that CHANGE something (every endpoint that is not
   *   a `get`, see `isWriteCommand`) are queued with user priority so a button press overtakes
   *   background polling.
   */
  public constructor(ip: string, send: YxcSend = defaultSend(ip), gate?: CommandGate) {
    this.send = gate
      ? (command, body) => gate.run(() => send(command, body), isWriteCommand(command) ? "user" : "background")
      : send;
  }

  /**
   * Read one endpoint verbatim for a diagnostics report. Only a READ goes out: the last path segment
   * must start with `get` — anything else is rejected before it reaches the device, so a report can
   * never change a setting.
   *
   * @param path the API path below the version, e.g. `/system/getFeatures` or `/tuner/getPresetInfo?band=fm`
   * @returns the parsed response body
   */
  public read(path: string): Promise<unknown> {
    const last = path.split("?")[0].split("/").pop() ?? "";
    if (!/^get[A-Z]/.test(last)) {
      return Promise.reject(new Error(`not a read: ${path}`));
    }
    return this.send(path);
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
   * Read the device-wide switch states (`/system/getFuncStatus`, bundled reference library
   * `yxc_api_cmd.js`). This is the counterpart of a zone's getStatus for everything that is
   * NOT per zone — the auto standby, the display brightness, the HDMI outputs. The adapter
   * never asked for it until the 2026-09-06 audit, so those settings had no datapoint at all
   * while every one of the bundled device captures declares the matching capability.
   *
   * @returns the getFuncStatus response
   */
  public getFuncStatus(): Promise<unknown> {
    return this.send("/system/getFuncStatus");
  }

  /**
   * Switch the automatic standby on or off (`/system/setAutoPowerStandby`, reference library).
   *
   * @param on true to let the receiver power itself down when idle
   * @returns the command response
   */
  public setAutoPowerStandby(on: boolean): Promise<unknown> {
    return this.send(`/system/setAutoPowerStandby?enable=${flag(on)}`);
  }

  /**
   * Switch HDMI output 1 on or off (`/system/setHdmiOut1`, reference library).
   *
   * @param on true to feed the display on HDMI output 1
   * @returns the command response
   */
  public setHdmiOut1(on: boolean): Promise<unknown> {
    return this.send(`/system/setHdmiOut1?enable=${flag(on)}`);
  }

  /**
   * Switch HDMI output 2 on or off (`/system/setHdmiOut2`, reference library).
   *
   * @param on true to feed the display on HDMI output 2
   * @returns the command response
   */
  public setHdmiOut2(on: boolean): Promise<unknown> {
    return this.send(`/system/setHdmiOut2?enable=${flag(on)}`);
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
    return this.send(`/${zoneSeg(zone)}/setMute?enable=${flag(on)}`);
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
    return this.send(`/${zoneSeg(zone)}/setEnhancer?enable=${flag(on)}`);
  }

  /**
   * Turn a zone's pure direct on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setPureDirect(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setPureDirect?enable=${flag(on)}`);
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
    return this.send(`/${zoneSeg(zone)}/setDirect?enable=${flag(on)}`);
  }

  /**
   * Turn a zone's Clear Voice on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setClearVoice(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setClearVoice?enable=${flag(on)}`);
  }

  /**
   * Turn a zone's bass extension on/off.
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setBassExtension(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setBassExtension?enable=${flag(on)}`);
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
   * Drive a player's transport (YXC Basic §7.3 netusb, §8.2 cd) — ONE endpoint for both players: the network
   * player had five fixed wrappers while the CD one was already parametrised (review 2026-10-05, F).
   *
   * @param player the player (`netusb` or `cd`)
   * @param playback the playback word
   * @returns the command response
   */
  public setPlayback(player: YxcPlayer, playback: YxcPlayback): Promise<unknown> {
    return this.send(`/${player}/setPlayback?playback=${playback}`);
  }

  /**
   * Toggle a player's repeat mode.
   *
   * @param player the player (`netusb` or `cd`)
   * @returns the command response
   */
  public toggleRepeat(player: YxcPlayer): Promise<unknown> {
    return this.send(`/${player}/toggleRepeat`);
  }

  /**
   * Toggle a player's shuffle mode.
   *
   * @param player the player (`netusb` or `cd`)
   * @returns the command response
   */
  public toggleShuffle(player: YxcPlayer): Promise<unknown> {
    return this.send(`/${player}/toggleShuffle`);
  }

  /**
   * Set the network/USB player's repeat mode directly — API 1.19 and later (aiomusiccast
   * `NetUSB.set_repeat`, used by Home Assistant; the specification names only the toggle).
   *
   * @param mode `off` / `one` / `all`
   * @returns the command response
   */
  public setNetRepeat(mode: "off" | "one" | "all"): Promise<unknown> {
    return this.send(`/netusb/setRepeat?mode=${mode}`);
  }

  /**
   * Set the network/USB player's shuffle mode directly — API 1.19 and later (aiomusiccast
   * `NetUSB.set_shuffle`).
   *
   * @param mode `off` / `on`
   * @returns the command response
   */
  public setNetShuffle(mode: "off" | "on"): Promise<unknown> {
    return this.send(`/netusb/setShuffle?mode=${mode}`);
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
   * Set the tuner frequency for a band. `tuning` selects HOW to tune and is not optional:
   * the reference library sends `tuning=direct` for an absolute frequency
   * (`yamaha-yxc-nodejs/lib/yxc_api_cmd.js:1186` setFreqDirect). Without it the device
   * answers a non-zero response code and the write never reaches the tuner.
   *
   * @param band the band the frequency belongs to
   * @param freq the frequency (kHz, as the device reports it)
   * @returns the command response
   */
  public setFreq(band: string, freq: number): Promise<unknown> {
    return this.send(`/tuner/setFreq?band=${q(band)}&tuning=direct&num=${q(freq)}`);
  }

  /**
   * Set a zone's dialogue level (YXC Basic §5.16).
   *
   * @param value the level, within the zone's declared range
   * @param zone the zone
   * @returns the command response
   */
  public setDialogueLevel(value: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setDialogueLevel?value=${q(value)}`);
  }

  /**
   * Set a zone's dialogue lift (YXC Basic §5.17).
   *
   * @param value the lift, within the zone's declared range
   * @param zone the zone
   * @returns the command response
   */
  public setDialogueLift(value: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setDialogueLift?value=${q(value)}`);
  }

  /**
   * Turn a zone's 3D surround on/off (YXC Basic §5.9).
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public set3dSurround(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/set3dSurround?enable=${flag(on)}`);
  }

  /**
   * Set a zone's tone-control mode, leaving bass and treble as they are (YXC Basic §5.13: every parameter but the zone is optional).
   *
   * @param mode a mode the zone declares (`tone_control_mode_list`)
   * @param zone the zone
   * @returns the command response
   */
  public setToneMode(mode: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setToneControl?mode=${q(mode)}`);
  }

  /**
   * Set a zone's equalizer mode, leaving the bands as they are (YXC Basic §5.14).
   *
   * @param mode a mode the zone declares (`equalizer_mode_list`)
   * @param zone the zone
   * @returns the command response
   */
  public setEqualizerMode(mode: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setEqualizer?mode=${q(mode)}`);
  }

  /**
   * Set a zone's MusicCast Link control (YXC Advanced §4.1).
   *
   * @param control a value the zone declares (`link_control_list`)
   * @param zone the zone
   * @returns the command response
   */
  public setLinkControl(control: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setLinkControl?control=${q(control)}`);
  }

  /**
   * Set a zone's MusicCast Link audio delay (YXC Advanced §4.2).
   *
   * @param delay a value the zone declares (`link_audio_delay_list`)
   * @param zone the zone
   * @returns the command response
   */
  public setLinkAudioDelay(delay: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setLinkAudioDelay?delay=${q(delay)}`);
  }

  /**
   * Set a zone's MusicCast Link audio quality (YXC Advanced §4.3).
   *
   * @param mode a value the zone declares (`link_audio_quality_list`)
   * @param zone the zone
   * @returns the command response
   */
  public setLinkAudioQuality(mode: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setLinkAudioQuality?mode=${q(mode)}`);
  }

  /**
   * Set a zone's DTS dialogue control (no specification; aiomusiccast/Home Assistant, pyamaha `SET_DTS_DIALOGUE_CONTROL`).
   *
   * @param num the level, within the zone's declared range
   * @param zone the zone
   * @returns the command response
   */
  public setDtsDialogueControl(num: number, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setDtsDialogueControl?num=${q(num)}`);
  }

  /**
   * Turn a zone's extra bass on/off (no specification; aiomusiccast/Home Assistant, pyamaha `SET_EXTRA_BASS`).
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setExtraBass(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setExtraBass?enable=${flag(on)}`);
  }

  /**
   * Turn a zone's adaptive dynamic range control on/off (no specification; aiomusiccast/Home Assistant, pyamaha `SET_ADAPTIVE_DRC`).
   *
   * @param on whether to enable
   * @param zone the zone
   * @returns the command response
   */
  public setAdaptiveDrc(on: boolean, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setAdaptiveDrc?enable=${flag(on)}`);
  }

  /**
   * Set a zone's surround decoder (no specification; aiomusiccast/Home Assistant, pyamaha `SET_SURR_DECODER_TYPE`).
   *
   * @param type a decoder the zone declares (`surr_decoder_type_list`)
   * @param zone the zone
   * @returns the command response
   */
  public setSurroundDecoderType(type: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/setSurroundDecoderType?type=${q(type)}`);
  }

  /**
   * Set the front-panel dimmer; -1 is automatic where the device declares it (YXC Basic §4.26).
   *
   * @param value the dimmer step, within the declared range
   * @returns the command response
   */
  public setDimmer(value: number): Promise<unknown> {
    return this.send(`/system/setDimmer?value=${q(value)}`);
  }

  /**
   * Select a speaker pattern (no specification and no known caller; pyamaha `SET_SPEAKER_PATTERN`).
   *
   * @param num the pattern number, 1…speaker_pattern_num
   * @returns the command response
   */
  public setSpeakerPattern(num: number): Promise<unknown> {
    return this.send(`/system/setSpeakerPattern?num=${q(num)}`);
  }

  /**
   * Switch speaker set A on/off (YXC Basic §4.24).
   *
   * @param on whether to enable
   * @returns the command response
   */
  public setSpeakerA(on: boolean): Promise<unknown> {
    return this.send(`/system/setSpeakerA?enable=${flag(on)}`);
  }

  /**
   * Switch speaker set B on/off (YXC Basic §4.25).
   *
   * @param on whether to enable
   * @returns the command response
   */
  public setSpeakerB(on: boolean): Promise<unknown> {
    return this.send(`/system/setSpeakerB?enable=${flag(on)}`);
  }

  /**
   * Switch the remote-control IR sensor on/off (YXC Basic §4.23).
   *
   * @param on whether to enable
   * @returns the command response
   */
  public setIrSensor(on: boolean): Promise<unknown> {
    return this.send(`/system/setIrSensor?enable=${flag(on)}`);
  }

  /**
   * Let zone B's volume follow zone A's, or not (YXC Basic §4.27).
   *
   * @param on whether to sync
   * @returns the command response
   */
  public setZoneBVolumeSync(on: boolean): Promise<unknown> {
    return this.send(`/system/setZoneBVolumeSync?enable=${flag(on)}`);
  }

  /**
   * Name the MusicCast group (YXC Advanced §5.6; POST, kept in volatile memory — the device forgets it on restart).
   *
   * @param name the name, UTF-8 within 128 bytes ("" = the default)
   * @returns the command response
   */
  public setGroupName(name: string): Promise<unknown> {
    return this.send("/dist/setGroupName", JSON.stringify({ name }));
  }

  /**
   * Turn party mode on/off (system-wide).
   *
   * @param on whether to enable
   * @returns the command response
   */
  public setPartyMode(on: boolean): Promise<unknown> {
    return this.send(`/system/setPartyMode?enable=${flag(on)}`);
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
   * @param lang the menus' language (`en`, `de`, … — YXC Basic Rev 1.10 §7.7); the device's default without
   * @returns the list_info response
   */
  public getListInfo(input: string, index: number, size = 8, lang?: string): Promise<unknown> {
    return this.send(
      `/netusb/getListInfo?input=${q(input)}&index=${q(index)}&size=${q(size)}${lang ? `&lang=${q(lang)}` : ""}`,
    );
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
   * Select the next or previous DAB service (YXC Basic §6.15) — a DAB station is chosen by service,
   * not by frequency.
   *
   * @param direction next or previous
   * @returns the command response
   */
  public setDabService(direction: "next" | "previous"): Promise<unknown> {
    return this.send(`/tuner/setDabService?dir=${q(direction)}`);
  }

  /**
   * Store the tuner's current station to a preset slot (YXC Basic Rev 1.10 §6.7).
   *
   * @param num the slot, within the range getFeatures declares
   * @returns the command response
   */
  public storeTunerPreset(num: number): Promise<unknown> {
    return this.send(`/tuner/storePreset?num=${q(num)}`);
  }

  /**
   * Clear a tuner preset slot (YXC Basic Rev 1.10 §6.8).
   *
   * @param band `common` on a shared list, else `am` / `fm` / `dab`
   * @param num the slot
   * @returns the command response
   */
  public clearTunerPreset(band: string, num: number): Promise<unknown> {
    return this.send(`/tuner/clearPreset?band=${q(band)}&num=${q(num)}`);
  }

  /**
   * Store the network player's current content to a favourite slot (YXC Basic Rev 1.10 §7.11).
   *
   * @param num the slot, within the range getFeatures declares
   * @returns the command response
   */
  public storeNetPreset(num: number): Promise<unknown> {
    return this.send(`/netusb/storePreset?num=${q(num)}`);
  }

  /**
   * Clear a favourite slot (YXC Basic Rev 1.10 §7.12).
   *
   * @param num the slot
   * @returns the command response
   */
  public clearNetPreset(num: number): Promise<unknown> {
    return this.send(`/netusb/clearPreset?num=${q(num)}`);
  }

  /**
   * Search the next or previous receivable station on AM/FM (YXC Basic Rev 1.10 §6.4 `tuning`
   * `auto_up`/`auto_down`; Home Assistant's next/previous station does the same).
   *
   * @param band the band to search on (`am` / `fm`)
   * @param direction the search direction
   * @returns the command response
   */
  public searchTuner(band: string, direction: "auto_up" | "auto_down"): Promise<unknown> {
    return this.send(`/tuner/setFreq?band=${q(band)}&tuning=${q(direction)}`);
  }

  /**
   * Play a CD track by its number (YXC Basic Rev 1.10 §8.2 `track_select`).
   *
   * @param num the track, 1…512
   * @returns the command response
   */
  public selectCdTrack(num: number): Promise<unknown> {
    return this.send(`/cd/setPlayback?playback=track_select&num=${q(num)}`);
  }

  /**
   * Jump to a position of the playing track — the media server only (YXC Basic Rev 1.10 §7.4).
   *
   * @param seconds the position in seconds
   * @returns the command response
   */
  public setPlayPosition(seconds: number): Promise<unknown> {
    return this.send(`/netusb/setPlayPosition?position=${q(seconds)}`);
  }

  /**
   * Switch the clock's automatic time sync on or off (YXC Basic Rev 1.10 §9.2).
   *
   * @param enable whether the clock syncs itself
   * @returns the command response
   */
  public setClockAutoSync(enable: boolean): Promise<unknown> {
    return this.send(`/clock/setAutoSync?enable=${flag(enable)}`);
  }

  /**
   * Set the clock's time display (YXC Basic Rev 1.10 §9.4).
   *
   * @param format `12h` / `24h`
   * @returns the command response
   */
  public setClockFormat(format: "12h" | "24h"): Promise<unknown> {
    return this.send(`/clock/setClockFormat?format=${format}`);
  }

  /**
   * Change the alarm settings — only the fields given (YXC Basic Rev 1.10 §9.5, POST).
   *
   * @param settings the fields to set (`alarm_on`, `volume`, `mode`, `repeat`, `detail`)
   * @returns the command response
   */
  public setAlarmSettings(settings: Record<string, unknown>): Promise<unknown> {
    return this.send("/clock/setAlarmSettings", JSON.stringify(settings));
  }

  /**
   * Step through the stored presets (YXC Basic §6.6, API 1.17 and later).
   *
   * @param direction next or previous
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

  /**
   * Recall a zone's scene (#615). Endpoint and parameter verified against a live
   * RX-V6A (main and zone2 answer the parameter probe; `setScene` does not exist).
   *
   * @param num the scene number (1-based)
   * @param zone the zone
   * @returns the command response
   */
  public recallScene(num: number, zone: string): Promise<unknown> {
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
  public controlCursor(cursor: string, zone: string): Promise<unknown> {
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
  public controlMenu(menu: string, zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/controlMenu?menu=${q(menu)}`);
  }

  /**
   * Read a zone's audio signal info (format, sampling rate, bit depth, bitrate).
   *
   * @param zone the zone
   * @returns the getSignalInfo response
   */
  public getSignalInfo(zone: string): Promise<unknown> {
    return this.send(`/${zoneSeg(zone)}/getSignalInfo`);
  }

  /**
   * Read the names of the MusicCast playlists (the app-managed lists).
   *
   * @returns the getMcPlaylistName response
   */
  public getMcPlaylistName(): Promise<unknown> {
    return this.send("/netusb/getMcPlaylistName");
  }

  /**
   * Read the first window of the network player's play queue — eight entries, the device's cap. Nothing
   * ever asked for another window, so the index and size parameters went (review 2026-10-05, G).
   *
   * @returns the getPlayQueue response
   */
  public getPlayQueue(): Promise<unknown> {
    return this.send("/netusb/getPlayQueue?index=0&size=8");
  }
}

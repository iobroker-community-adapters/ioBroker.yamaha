import { PLAYER_CLEAR } from "../catalog/player-block";
import type { DeviceValue, StateValue } from "../types";
import type { YxcClientLike } from "./client-contract";
import type { PlayerTransport } from "./command-mapper";
import type { YxcPlayer } from "./http-client";
import { zonePrefix } from "../catalog/zones";

/** What the routing needs from its controller. */
export interface PlayerRoutingDeps {
  /** The device's zones (getFeatures). */
  zones(): readonly string[];
  /** The media blocks the device declares (`netusb`, `cd`, `tuner`). */
  media(): readonly string[];
  /**
   * Write one device value (relative id).
   *
   * @param relativeId the state id relative to the device
   * @param value the value
   */
  emit(relativeId: string, value: DeviceValue): void;
}

/**
 * A player key or mode write as its client call — or the reason it cannot be sent, which the controller logs and
 * answers with `unavailable`.
 */
export type PlayerCall = { run: (client: YxcClientLike) => Promise<unknown>; player: YxcPlayer } | { notSent: string };

/**
 * Which media source feeds which zone's "now playing" block, and which zone a recall goes to (v2.0.0 routing) —
 * out of the 2.4k-line controller (review 2026-10-05, D): the decisions here are pure, the controller keeps the
 * requests. A zone plays a media source when its input IS that source: `cd` for the disc, the network player's
 * active source for netusb. Main is flat in the tree, the other zones are under their multiroom folder; a zone
 * that LEAVES a source gets its block cleared once, so the previous program's metadata does not linger.
 */
export class YxcPlayerRouting {
  /** Each zone's currently selected input, from its status. */
  private readonly zoneInput = new Map<string, string>();
  /** Each zone's power, from its status: a zone in standby listens to nothing. */
  private readonly zonePower = new Map<string, boolean>();
  /** Which source currently feeds each zone's block. */
  private readonly zoneBlock = new Map<string, YxcPlayer>();
  /** The source the network player is on (netusb `input`, e.g. "net_radio"). */
  private netusbInput = "";
  /** Per source, the playback word of its last full play info, and that answer whole (see {@link audible}). */
  private readonly lastInfo = new Map<YxcPlayer, { playback: unknown; print: string }>();

  /**
   * @param deps the controller's zones, media blocks and value writer
   */
  public constructor(private readonly deps: PlayerRoutingDeps) {}

  /** The source the network player is on — the source a favourite or a recently played item belongs to. */
  public get networkSource(): string {
    return this.netusbInput;
  }

  /**
   * A zone's status reported its input.
   *
   * @param zone the zone
   * @param input the input it reported
   * @returns the input it had before (undefined the first time)
   */
  public noteInput(zone: string, input: string): string | undefined {
    const previous = this.zoneInput.get(zone);
    this.zoneInput.set(zone, input);
    return previous;
  }

  /**
   * A zone's status reported its power.
   *
   * @param zone the zone
   * @param on whether it is switched on
   */
  public notePower(zone: string, on: boolean): void {
    this.zonePower.set(zone, on);
  }

  /**
   * A full play info of a media source arrived.
   *
   * @param block the source
   * @param info the raw getPlayInfo answer
   */
  public notePlayInfo(block: YxcPlayer, info: unknown): void {
    // The id, not the datapoint: `player.source` shows the input's name (C40), the zones match ids.
    const active = (info as { input?: unknown } | null)?.input;
    if (block === "netusb" && typeof active === "string") {
      this.netusbInput = active;
    }
    this.lastInfo.set(block, {
      playback: (info as { playback?: unknown } | null)?.playback,
      print: JSON.stringify(info),
    });
  }

  /**
   * The sources that last reported playing while a switched-on zone listens to them — a playing source ticks its
   * play time every second (YXC Basic §10.3), so a keepalive interval without one event while it plays is a change
   * the device made without telling (review 2026-10-05, A17).
   *
   * @returns the sources
   */
  public audible(): YxcPlayer[] {
    const sources = new Set<YxcPlayer>();
    for (const [zone, block] of this.zoneBlock) {
      if (this.zonePower.get(zone) !== false && this.lastInfo.get(block)?.playback === "play") {
        sources.add(block);
      }
    }
    return [...sources];
  }

  /**
   * The last full play info of a source, whole — compared across a keepalive to see whether it changed.
   *
   * @param block the source
   * @returns the answer as text, or undefined before the first one
   */
  public printOf(block: YxcPlayer): string | undefined {
    return this.lastInfo.get(block)?.print;
  }

  /**
   * Which player source an input feeds into a zone's block: `cd` for the disc input, `netusb` when the input IS
   * the network player's active source. Anything else (HDMI, analog, tuner) plays no media block.
   *
   * @param input the zone's currently selected input
   * @returns the feeding source, or undefined when the input is no media player
   */
  public blockFor(input: string | undefined): YxcPlayer | undefined {
    const media = this.deps.media();
    if (input === "cd" && media.includes("cd")) {
      return "cd";
    }
    if (input !== undefined && input !== "" && input === this.netusbInput && media.includes("netusb")) {
      return "netusb";
    }
    return undefined;
  }

  /**
   * What a zone plays right now — derived FRESH from its input, never from the routing map: a stale map entry
   * would send a key to the source the zone just left.
   *
   * @param zone the zone
   * @returns the source, or undefined when it plays none
   */
  public blockOf(zone: string): YxcPlayer | undefined {
    return this.blockFor(this.zoneInput.get(zone));
  }

  /**
   * The zone a recall should go to: recalling a favourite does not just start it, it also switches THAT zone to
   * the source. The zone actually listening to the source is the right target, main first when several share
   * it; main is the fallback when nothing matches, which is also every single-zone device. Only a switched-on zone
   * listens: zone 2 in standby still reports the `net_radio` it was left on, and the favourite went there — into a
   * zone nobody listens to (review 2026-10-05, A45).
   *
   * @param source the input the recall belongs to (a network source, or "tuner")
   * @returns the zone to route the recall to
   */
  public recallZone(source: string): string {
    if (!source) {
      return "main";
    }
    // A zone whose power was never reported counts as on, as before.
    const listening = (zone: string): boolean =>
      this.zoneInput.get(zone) === source && this.zonePower.get(zone) !== false;
    if (listening("main")) {
      return "main";
    }
    for (const zone of this.zoneInput.keys()) {
      if (listening(zone)) {
        return zone;
      }
    }
    return "main";
  }

  /**
   * Route one source's play info into the block of every zone listening to it, clearing the block of a zone
   * that left it. Drive-own `player.cd.*` extras are device-global and written once, unprefixed.
   *
   * @param block the source the updates came from
   * @param updates the parsed flat player updates
   */
  public route(block: YxcPlayer, updates: readonly StateValue[]): void {
    for (const zone of this.deps.zones()) {
      const expected = this.blockOf(zone);
      const previous = this.zoneBlock.get(zone);
      if (previous === block && expected !== block) {
        // The zone left OUR source — clear; the new source's refresh fills its own values.
        this.zoneBlock.delete(zone);
        this.emitBlock(zone, PLAYER_CLEAR);
      }
      if (expected === block) {
        if (previous !== block) {
          this.zoneBlock.set(zone, block);
          if (previous !== undefined) {
            this.emitBlock(zone, PLAYER_CLEAR);
          }
        }
        this.emitBlock(zone, updates);
      }
    }
    for (const update of updates) {
      if (update.id.startsWith("player.cd.")) {
        this.deps.emit(update.id, update.value);
      }
    }
  }

  /**
   * Re-evaluate a zone's block after ITS input changed: clear it when the zone left a media source. Media pushes
   * alone cannot cover this — a zone leaving a still-playing source (or joining one another zone already plays)
   * changes nothing about the source itself, so no netusb/cd push ever arrives (2.0.0 review finding).
   *
   * @param zone the zone whose input just changed
   * @returns the source to read now so the block fills at once, if the zone joined one
   */
  public retarget(zone: string): YxcPlayer | undefined {
    const expected = this.blockOf(zone);
    const previous = this.zoneBlock.get(zone);
    if (previous === expected) {
      return undefined;
    }
    if (previous !== undefined) {
      this.zoneBlock.delete(zone);
      this.emitBlock(zone, PLAYER_CLEAR);
    }
    // `route`, inside the read the caller starts, records the zone's new source.
    return expected;
  }

  /**
   * Give every zone that plays no media source its cleared block — the routing only writes to listening zones,
   * so on a device that starts on HDMI the block would sit valueless until the first media playback (live 2.0.0
   * deployment check).
   */
  public clearIdle(): void {
    const media = this.deps.media();
    if (!media.includes("netusb") && !media.includes("cd")) {
      return;
    }
    for (const zone of this.deps.zones()) {
      if (!this.zoneBlock.has(zone)) {
        this.emitBlock(zone, PLAYER_CLEAR);
      }
    }
  }

  /**
   * A transport key of a zone's block as the call on the source the zone plays: the playback words through the
   * player's `setPlayback`, repeat and shuffle through its toggles.
   *
   * @param zone the zone whose key was pressed
   * @param action the transport action
   * @returns the call, or why nothing is sent
   */
  public transport(zone: string, action: PlayerTransport): PlayerCall {
    const player = this.blockOf(zone);
    if (player === undefined) {
      return { notSent: `${zone} is not playing a media source` };
    }
    const run =
      action === "repeatToggle"
        ? (client: YxcClientLike): Promise<unknown> => client.toggleRepeat(player)
        : action === "shuffleToggle"
          ? (client: YxcClientLike): Promise<unknown> => client.toggleShuffle(player)
          : (client: YxcClientLike): Promise<unknown> =>
              client.setPlayback(player, action === "prev" ? "previous" : action);
    return { run, player };
  }

  /**
   * A repeat or shuffle mode set directly: only the network player takes it, from API 1.19 on (aiomusiccast,
   * Home Assistant; audit 2026-09-29, C37) — a CD keeps its toggles.
   *
   * @param zone the zone whose mode was written
   * @param apiVersion the device's `api_version`, if known
   * @param mode the repeat or the shuffle mode
   * @param mode.repeat the repeat mode, when that was written
   * @param mode.shuffle the shuffle mode, when that was written
   * @returns the call, or why nothing is sent
   */
  public mode(
    zone: string,
    apiVersion: number | undefined,
    mode: { repeat?: "off" | "one" | "all"; shuffle?: "off" | "on" },
  ): PlayerCall {
    if (this.blockOf(zone) !== "netusb" || apiVersion === undefined || apiVersion < 1.19) {
      return { notSent: "only the network player sets it directly" };
    }
    return {
      player: "netusb",
      run: async client => {
        if (mode.repeat !== undefined) {
          await client.setNetRepeat(mode.repeat);
        }
        if (mode.shuffle !== undefined) {
          await client.setNetShuffle(mode.shuffle);
        }
      },
    };
  }

  /**
   * Write flat player updates into one zone's block (main flat, zones prefixed), skipping the device-global
   * drive extras.
   *
   * @param zone the target zone
   * @param updates the flat player updates
   */
  private emitBlock(zone: string, updates: readonly StateValue[]): void {
    const prefix = zonePrefix(zone);
    for (const update of updates) {
      if (!update.id.startsWith("player.cd.")) {
        this.deps.emit(`${prefix}${update.id}`, update.value);
      }
    }
  }
}

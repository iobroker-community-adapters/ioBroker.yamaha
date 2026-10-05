import { absoluteDeviceUrl, withAlbumArtId } from "../catalog/device-url";
import type { CommandPriority } from "../lifecycle/command-gate";
import { PLAYER_CLEAR, PLAYER_DISPLAY_STATES, PLAYER_STATION_STATE, playerStateObject } from "../catalog/player-block";
import { errText } from "../err-text";
import type { XmlControllerContext } from "./controller-context";
import { parsePlayInfo, type XmlPlayInfo } from "./protocol";
import type { XmlZone } from "./zones";

/** A source's "now playing" read. */
const PLAY_INFO_GET = "<Play_Info>GetParam</Play_Info>";

/** Every display state of a player block, the station included. */
const PLAYER_STATES = [...PLAYER_DISPLAY_STATES, PLAYER_STATION_STATE];

/**
 * The "now playing" block of every zone listening to a media source: the source's `Play_Info`
 * (2009+ one element per source, 2008 `NET_USB`/`iPod`) — artist, album, track, station, status,
 * repeat, shuffle and cover, under the same `player.*` ids YNCA and MusicCast fill. XML read none of
 * it, so the 2008 generation had no playback information at all (audit 2026-09-29, D3). A state is
 * built when a source first reports its field; a zone that leaves its source is cleared.
 */
export class XmlPlayerBlocks {
  /** Each zone's input as its last status reported it — which source its player block shows (D3). */
  private readonly zoneInput = new Map<string, string>();
  /** Per zone: input → the source element the device declares for it (`Src_Name`, D3). */
  private readonly inputSources = new Map<string, Record<string, string>>();
  /** The player-block states built so far (built as a source first reports the field). */
  private readonly built = new Set<string>();
  /** Per zone: the input whose playback the block shows right now. */
  private readonly shown = new Map<string, string>();

  /**
   * @param ctx the controller's shared context
   */
  public constructor(private readonly ctx: XmlControllerContext) {}

  /**
   * Remember which source element the zone declares behind each input (its `Input_Sel_Item`).
   *
   * @param zoneKey the zone
   * @param sources input value → source element
   */
  public setSources(zoneKey: string, sources: Record<string, string>): void {
    this.inputSources.set(zoneKey, sources);
  }

  /**
   * Remember the input a zone's status reports — it decides which source the zone's block shows.
   *
   * @param zoneKey the zone
   * @param input the zone's input
   */
  public noteInput(zoneKey: string, input: string): void {
    this.zoneInput.set(zoneKey, input);
  }

  /**
   * The input a zone's last status reported.
   *
   * @param zoneKey the zone
   * @returns the input, undefined before a status carried one
   */
  public inputOf(zoneKey: string): string | undefined {
    return this.zoneInput.get(zoneKey);
  }

  /**
   * Read what every zone's source plays and write the blocks; clear the block of a zone that left its source.
   *
   * @param zones the zones of the device
   * @param priority the gate priority — `user` for the read-back of a user's write (A58)
   */
  public async refresh(zones: readonly XmlZone[], priority: CommandPriority = "background"): Promise<void> {
    const ctx = this.ctx;
    const answers = new Map<string, XmlPlayInfo | undefined>();
    for (const zone of zones) {
      const input = this.zoneInput.get(zone.key);
      const source = input === undefined ? undefined : this.inputSources.get(zone.key)?.[input];
      const prefix = `${zone.prefix}player`;
      if (source === undefined) {
        if (this.built.has(`${prefix}.playback`)) {
          this.clear(prefix);
        }
        this.shown.delete(zone.key);
        continue;
      }
      if (!answers.has(source)) {
        try {
          answers.set(source, parsePlayInfo(await ctx.deps.client.getXml(source, PLAY_INFO_GET, priority)));
        } catch (e) {
          answers.set(source, undefined);
          ctx.deps.log.debug(`${ctx.deviceId}: ${source} Play_Info failed: ${errText(e)}`);
        }
      }
      const info = answers.get(source);
      if (info === undefined || info.playback === undefined) {
        continue;
      }
      const values: Record<string, boolean | number | string> = { source: input ?? "", ...info };
      if (typeof info.albumArt === "string") {
        values.albumArt = withAlbumArtId(absoluteDeviceUrl(info.albumArt, ctx.deps.host), info.albumArtId);
      }
      // Another player source than the block showed: what the new one does not carry goes — the artist, the play
      // mode and the cover of the media server stood under a radio station (review 2026-10-05, A50). The 2008
      // generation's three network inputs share one NET_USB element, so the input decides, not the element.
      const previous = this.shown.get(zone.key);
      this.shown.set(zone.key, String(values.source));
      if (previous !== undefined && previous !== values.source) {
        this.clear(prefix, new Set(Object.keys(values)));
      }
      for (const [state, value] of Object.entries(values)) {
        const def = PLAYER_STATES.find(entry => entry.state === state);
        if (!def) {
          continue;
        }
        const id = `${prefix}.${state}`;
        if (!this.built.has(id)) {
          await ctx.ensureChannels(id);
          await ctx.deps.upsertObject(`${ctx.deviceId}.${id}`, playerStateObject(prefix, def));
          this.built.add(id);
          ctx.markWritable(id, false);
        }
        ctx.emit(id, value);
      }
    }
  }

  /**
   * Clear a player block whose zone left its media source, or the fields the source now playing does not report —
   * the old track must not linger.
   *
   * @param prefix the block's id prefix (`player`, `multiroom.zone2.player`)
   * @param keep the fields the source now playing reports — written right after, so not cleared first
   */
  private clear(prefix: string, keep: ReadonlySet<string> = new Set()): void {
    for (const clear of PLAYER_CLEAR) {
      const field = clear.id.slice("player.".length);
      const id = `${prefix}.${field}`;
      if (this.built.has(id) && !keep.has(field)) {
        this.ctx.emit(id, clear.value);
      }
    }
  }
}

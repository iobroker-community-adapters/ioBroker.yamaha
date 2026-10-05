import { SOURCE_INPUTS, ZONE_ONLY_INPUTS } from "./catalog";

/**
 * The normalised form an INP value is looked up by: uppercase, alphanumerics only
 * ("NET RADIO" → NETRADIO, "iPod (USB)" → IPODUSB, "SIRIUS InternetRadio" → SIRIUSINTERNETRADIO).
 *
 * @param input the wire value
 * @returns the lookup key
 */
function normalizeInput(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * INP value → the player subunit it selects. Derived from the catalog's source table — ONE
 * list serves the dropdown, the presence proof and the player routing; inputs that are no
 * media player (HDMI, AV, TUNER, …) map to nothing. The hand-written table this replaces
 * routed "SiriusXM" and "SIRIUS InternetRadio" to the SIRIUS subunit (ynca-python: each has
 * its own) and carried a key (`SIRIUSIR`) no wire value ever normalised to.
 */
const INPUT_SUBUNITS: Record<string, string> = Object.fromEntries(
  SOURCE_INPUTS.filter(source => source.value !== "TUNER" && source.subunits.length > 0).map(source => [
    normalizeInput(source.value),
    source.subunits[0],
  ]),
);

/** The zone-only inputs that make a zone play whatever the main zone plays ("Main Zone Sync"). */
const FOLLOWS_MAIN: ReadonlySet<string> = new Set(ZONE_ONLY_INPUTS.map(normalizeInput));

/**
 * The player subunit an input selection feeds, or undefined when the input is no media player.
 *
 * @param input the zone's INP value (e.g. "NET RADIO", "iPod (USB)")
 * @returns the subunit (e.g. NETRADIO), or undefined
 */
export function playerSubunitForInput(input: string | undefined): string | undefined {
  if (typeof input !== "string" || input.length === 0) {
    return undefined;
  }
  return INPUT_SUBUNITS[normalizeInput(input)];
}

/**
 * Which source each zone's "now playing" block shows, and which blocks a source's values go to (v2.0.0: every zone
 * has its own player block, zones can play different sources). One small class instead of the input map, the block
 * list and the lookups spread over the controller (review 2026-10-05, D/A41).
 *
 * A zone on "Main Zone Sync" plays the main zone's source: its block shows that source's values and its player keys
 * act on it — before, the zone mapped to no source, showed an empty block and dropped every player command (A40).
 */
export class YncaPlayerRouter {
  /** The INP value each zone reports (`main`, `zone2`, …). */
  private readonly inputs = new Map<string, string>();
  /** The zones that have a player block. */
  private blocks: readonly string[] = [];

  /**
   * Set the zones that have a player block.
   *
   * @param zones the zone keys, main first
   */
  public setBlocks(zones: readonly string[]): void {
    this.blocks = [...zones];
  }

  /** @returns the zones that have a player block */
  public get blockZones(): readonly string[] {
    return this.blocks;
  }

  /**
   * The input a zone actually plays: its own, or the main zone's when it follows the main zone.
   *
   * @param zone the zone key
   * @returns the INP value, or undefined when not known yet
   */
  public heard(zone: string): string | undefined {
    const own = this.inputs.get(zone);
    if (zone !== "main" && own !== undefined && FOLLOWS_MAIN.has(normalizeInput(own))) {
      return this.inputs.get("main");
    }
    return own;
  }

  /**
   * The player subunit a zone plays.
   *
   * @param zone the zone key
   * @returns the subunit, or undefined when the zone plays no media source
   */
  public source(zone: string): string | undefined {
    return playerSubunitForInput(this.heard(zone));
  }

  /**
   * Record a zone's input.
   *
   * @param zone the zone key
   * @param input the INP value
   * @returns the zones with a block whose source changed — a main-zone switch changes every zone following it
   */
  public setInput(zone: string, input: string): string[] {
    const before = new Map(this.blocks.map(key => [key, this.source(key)]));
    this.inputs.set(zone, input);
    return this.blocks.filter(key => this.source(key) !== before.get(key));
  }

  /**
   * The zones whose block shows a source's values.
   *
   * @param subunit the player subunit
   * @returns the zone keys
   */
  public listeners(subunit: string): string[] {
    return this.blocks.filter(zone => this.source(zone) === subunit);
  }
}

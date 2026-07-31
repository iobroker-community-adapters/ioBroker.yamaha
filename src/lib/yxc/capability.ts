/** One zone from a YXC getFeatures response. */
export interface YxcZone {
  /** Zone id (`main`, `zone2`, …). */
  id: string;
  /** Functions the zone supports (power, volume, mute, …). */
  funcs: string[];
  /** Inputs the zone offers. */
  inputs: string[];
}

/** A MusicCast device's capabilities from getFeatures. */
export interface YxcCapabilities {
  /** The device's zones. */
  zones: YxcZone[];
  /** Media blocks the device offers (netusb, tuner, cd, clock). */
  media: string[];
}

const MEDIA_BLOCKS = ["netusb", "tuner", "cd", "clock"];

/**
 * Keep only the string entries of an unknown array.
 *
 * @param value the value to filter
 * @returns the string entries, or an empty array
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Parse a YXC getFeatures response into zones (with their functions and inputs)
 * and the media blocks the device offers. Robust against a malformed response.
 *
 * @param response the getFeatures response object
 * @returns the parsed capabilities
 */
export function parseYxcFeatures(response: unknown): YxcCapabilities {
  if (typeof response !== "object" || response === null) {
    return { zones: [], media: [] };
  }
  const obj = response as Record<string, unknown>;
  const zones: YxcZone[] = [];
  if (Array.isArray(obj.zone)) {
    for (const entry of obj.zone) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const zone = entry as Record<string, unknown>;
      if (typeof zone.id === "string") {
        zones.push({ id: zone.id, funcs: stringList(zone.func_list), inputs: stringList(zone.input_list) });
      }
    }
  }
  const media = MEDIA_BLOCKS.filter(block => block in obj);
  return { zones, media };
}

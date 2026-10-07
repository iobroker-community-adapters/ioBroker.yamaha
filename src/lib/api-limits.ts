// The file stays in src/ and ships from there (package.json `files`): the build compiles TypeScript only, and this path
// reaches it from src/lib and from build/lib alike.
import limits from "../../src/lib/api-limits.json";

/**
 * The limits of every counterpart the adapter calls, defined in ONE place — `api-limits.json` (fleet rule of round 100,
 * krobi 2026-10-07 10:14: API limits are defined in the adapter and checked). The inventory suite "one counterpart hangs"
 * counts every call of its run against the same file.
 */

/** One limit: at most `max` calls in `seconds`, per host or for the whole account, and where the number comes from. */
export interface ApiLimit {
  /** Calls allowed in the window. */
  max: number;
  /** The window in seconds. */
  seconds: number;
  /** Whether each host has its own window or all calls share one. */
  per: "host" | "account";
  /** A link to the documentation, a measurement with its date, or the adapter's own cap. */
  source: string;
}

/** One counterpart and its limits. */
export interface ApiCounterpart {
  /** What it is. */
  name: string;
  /** Which calls belong to it — every field given must fit. */
  match: { host?: string; port?: number; kind?: "http" | "tcp" | "udp" };
  /** Its limits. */
  limits: ApiLimit[];
}

/** Every counterpart the adapter calls. */
export const API_COUNTERPARTS: readonly ApiCounterpart[] = limits.counterparts as ApiCounterpart[];

/**
 * The spacing one limit of a counterpart sets between two calls: its window divided by the calls it allows.
 *
 * @param name the counterpart's name in `api-limits.json`
 * @param seconds the window of the limit (a counterpart can carry a per-second and a per-minute limit)
 * @returns the spacing in milliseconds
 */
export function spacingMs(name: string, seconds: number): number {
  const limit = API_COUNTERPARTS.find(c => c.name === name)?.limits.find(l => l.seconds === seconds);
  if (!limit) {
    throw new Error(`api-limits.json declares no ${seconds}-second limit for '${name}'`);
  }
  return (limit.seconds * 1000) / limit.max;
}

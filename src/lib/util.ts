/**
 * The message of an unknown thrown value — `Error.message` when it is an Error, else
 * its string form. One helper for the `e instanceof Error ? e.message : String(e)`
 * idiom the transports would otherwise repeat in every catch.
 *
 * @param e the caught value
 * @returns a human-readable message
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Cap for every HTTP response body the adapter reads from a device: MusicCast JSON, XML
 * answers, the UPnP description of the network search. Real answers are a few KB (the
 * largest observed, the RX-V6A getFeatures map, is ~5 KB). A body growing past this is
 * not a Yamaha answering — a misbehaving device or a foreign host at that address
 * streaming without end would otherwise grow the process's memory without bound.
 */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

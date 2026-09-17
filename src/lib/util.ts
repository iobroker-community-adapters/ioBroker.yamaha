/**
 * A readable message for ANY thrown value — the one helper every catch in this adapter
 * routes its caught value through, instead of repeating `e instanceof Error ? e.message :
 * String(e)`. That idiom renders a thrown plain object (a rejected `{ code: "ECONNRESET" }`,
 * an HTTP client's error object) as `[object Object]`, which says nothing about what failed;
 * the object branch below is the whole point of the helper.
 *
 * @param e the caught value
 * @returns a human-readable message
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  // Everything that is not an object has a meaningful string form and is its OWN best text —
  // a thrown string, a number, a boolean, a symbol (where `String()` is the only way: a
  // template literal throws on one), null and undefined. A separate string branch above this
  // would be dead code: `String("EPERM")` is "EPERM".
  if (typeof e !== "object" || e === null) {
    return String(e);
  }
  try {
    // `JSON.stringify` returns undefined for a value it cannot represent, and throws on a
    // circular structure — both end at the same fallback, which names at least the class.
    return JSON.stringify(e) ?? Object.prototype.toString.call(e);
  } catch {
    return Object.prototype.toString.call(e);
  }
}

/**
 * Cap for every HTTP response body the adapter reads from a device: MusicCast JSON, XML
 * answers, the UPnP description of the network search. Real answers are a few KB (the
 * largest observed, the RX-V6A getFeatures map, is ~5 KB). A body growing past this is
 * not a Yamaha answering — a misbehaving device or a foreign host at that address
 * streaming without end would otherwise grow the process's memory without bound.
 */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

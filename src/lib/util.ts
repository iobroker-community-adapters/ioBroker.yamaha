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

/** Strict UTF-8: an invalid sequence throws instead of turning into U+FFFD, so the fallback can act. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode text a device sent, as ONE unit (a whole line or a whole body — never a network chunk,
 * which may end inside a multi-byte character: "Hitradio Ö3" arrived as "Hitradio ��3", audit
 * 2026-09-24 B5/C5/D12). Strict UTF-8 first; bytes that are not valid UTF-8 are Latin-1 — the
 * charset the YNCA and XML specifications declare for the names a user gives zones, inputs and
 * scenes ("K\xFCche"). A byte sequence is never both, so the order decides nothing wrongly.
 *
 * @param bytes the received bytes of one line or body
 * @returns the text
 */
export function decodeDeviceText(bytes: Uint8Array): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  }
}

/**
 * Encode text for the wire in the charset the target function declares.
 *
 * @param text the text to send
 * @param charset `latin1` for a function declared Latin-1, otherwise UTF-8
 * @returns the bytes, or undefined when the text holds a character Latin-1 cannot carry
 */
export function encodeDeviceText(text: string, charset: "utf8" | "latin1" = "utf8"): Buffer | undefined {
  if (charset === "latin1") {
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) > 0xff) {
        return undefined;
      }
    }
    return Buffer.from(text, "latin1");
  }
  return Buffer.from(text, "utf8");
}

/**
 * The body of one HTTP answer, collected as BYTES under {@link MAX_HTTP_BODY_BYTES} and decoded
 * once at the end (see {@link decodeDeviceText}) — the three HTTP readers (MusicCast, XML, the UPnP
 * description of the search) share it instead of each concatenating decoded chunks.
 */
export class DeviceBody {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  /**
   * Add a received chunk.
   *
   * @param chunk the chunk as the stream delivered it
   * @returns false once the body has grown past the cap (the caller destroys the stream)
   */
  public add(chunk: unknown): boolean {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.size += bytes.length;
    if (this.size > MAX_HTTP_BODY_BYTES) {
      return false;
    }
    this.chunks.push(bytes);
    return true;
  }

  /** @returns the whole body as text */
  public text(): string {
    return decodeDeviceText(Buffer.concat(this.chunks));
  }
}

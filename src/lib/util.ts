/**
 * One readable line for anything a `catch` receives — never `[object Object]`, never without the reason.
 * The fleet's master form (Entwicklung/CLAUDE_PATTERNS.md § Async-Handler), under this adapter's name:
 * one level of `cause` (a `fetch` rejection's socket reason lives there), the `code` where the message
 * is empty (an AggregateError from `net.connect`), the type tag for a thrown function — and it never
 * throws itself (audit 2026-09-24, E1).
 *
 * @param e the caught value
 * @returns the text
 */
export function errorMessage(e: unknown): string {
  // It runs inside a `catch` and must not throw there: any property of a caught value can be a
  // getter that throws, or hold something other than a string.
  try {
    if (e instanceof Error) {
      // An empty message carries its reason in `code`: `http.get`/`net.connect` to `localhost`
      // reject with an AggregateError (message "", code ECONNREFUSED).
      const code = "code" in e ? e.code : undefined;
      const message: unknown = e.message;
      const name: unknown = e.name;
      const text = String(message || (typeof code === "string" ? code : name));
      // `fetch` rejects with TypeError("fetch failed", { cause }) — ENOTFOUND, ECONNREFUSED,
      // "other side closed" live only in the cause. One level, never the chain (`e.cause = e` is legal).
      const cause = e.cause;
      let reason = "";
      if (cause instanceof Error) {
        const causeCode = "code" in cause ? cause.code : undefined;
        const causeMessage: unknown = cause.message;
        reason =
          (typeof causeMessage === "string" ? causeMessage : "") || (typeof causeCode === "string" ? causeCode : "");
      } else if (cause !== undefined && cause !== null) {
        reason = errorMessage(cause);
      }
      // A wrapper that copies its cause's message would say it twice.
      return reason && !text.includes(reason) ? `${text} (${reason})` : text;
    }
    if (typeof e === "string") {
      return e;
    }
    if (typeof e === "function") {
      // A thrown function or class: `String()` would print its whole source text.
      return Object.prototype.toString.call(e);
    }
    if (e === null || e === undefined || typeof e !== "object") {
      return String(e); // number, boolean, bigint, symbol (`${symbol}` would throw)
    }
    // A thrown object ({ code: "ECONNRESET" }, an HTTP client's error object): JSON.stringify
    // yields `undefined` for what it cannot render and throws on a circular structure.
    return JSON.stringify(e) ?? Object.prototype.toString.call(e);
  } catch {
    // A getter that threw, a circular structure for JSON.stringify: the type tag.
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

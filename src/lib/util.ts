import type { IncomingMessage } from "node:http";

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

/**
 * An HTTP answer outside 2xx: something at the device's address answered — and said no (a node the model does
 * not have, a missing description, a server still booting). It is an answer, not a lost connection: the XML
 * read memory keeps a 400/404 as the model's permanent verdict, and the network search asks a booting receiver
 * again instead of judging it "no Yamaha".
 */
export class HttpStatusError extends Error {
  /**
   * @param message the error message
   * @param statusCode the HTTP status the device answered with
   */
  public constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/**
 * Read one HTTP answer of a device: the body collected as bytes under the cap and decoded once
 * ({@link DeviceBody}), the status judged — the ONE reader of the three HTTP clients (XML control, MusicCast,
 * the UPnP description of the search). Only XML used to check the status; MusicCast parsed an error page as
 * JSON and the search took a booting receiver's 503 page for "no Yamaha" (review 2026-10-05, A32/E).
 *
 * @param res the response
 * @param what what was asked, for the messages
 * @returns the body of a 2xx answer; rejects with {@link HttpStatusError} on any other status, and with an
 *   Error when the stream breaks or grows past the cap
 */
export function readDeviceResponse(res: IncomingMessage, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new DeviceBody();
    res.on("data", chunk => {
      if (!body.add(chunk)) {
        // A real answer is a few KB (a desc.xml at most ~160 KB) — past the cap this is no receiver
        // answering but a stream that would grow memory without bound.
        res.destroy(new Error(`response too large: ${what}`));
      }
    });
    // A connection dropped mid-body emits on the RESPONSE stream, not the request.
    res.on("error", reject);
    res.on("end", () => {
      const status = res.statusCode;
      if (status !== undefined && (status < 200 || status >= 300)) {
        reject(new HttpStatusError(`device refused ${what} (HTTP ${status})`, status));
        return;
      }
      resolve(body.text());
    });
  });
}

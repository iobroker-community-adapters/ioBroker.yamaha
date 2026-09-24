import { decodeDeviceText } from "../util";

/**
 * Cap the un-terminated buffer: a device that never sends CR/LF (firmware fault or a
 * corrupt stream) must not grow it without bound. 64 KiB is far above any real YNCA line.
 */
const MAX_BUFFER = 64 * 1024;

/**
 * Accumulates incoming BYTES and yields complete, decoded lines (YNCA terminates each line with
 * CR/LF). It works on bytes because a TCP chunk may end inside a multi-byte character; a line is
 * decoded only once it is whole (see `decodeDeviceText`: UTF-8, else the Latin-1 the spec declares
 * for zone/input/scene names).
 */
export class LineBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Add a received chunk and return the complete lines it makes available. The
   * trailing partial line stays buffered until its terminator arrives.
   *
   * @param chunk newly received bytes (a string is taken as its UTF-8 bytes)
   * @returns the complete, non-empty lines now available
   */
  public push(chunk: Uint8Array | string): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    const data = this.buffer.length > 0 ? Buffer.concat([this.buffer, bytes]) : bytes;
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0d || data[i] === 0x0a) {
        if (i > start) {
          lines.push(decodeDeviceText(data.subarray(start, i)));
        }
        start = i + 1;
      }
    }
    this.buffer = Buffer.from(data.subarray(start));
    // A trailing partial line past the cap means no terminator is coming — drop it
    // rather than accumulate unbounded.
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = Buffer.alloc(0);
    }
    return lines;
  }
}

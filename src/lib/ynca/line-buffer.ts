/**
 * Cap the un-terminated buffer: a device that never sends CR/LF (firmware fault or a
 * corrupt stream) must not grow it without bound. 64 KiB is far above any real YNCA line.
 */
const MAX_BUFFER = 64 * 1024;

/** Accumulates incoming text and yields complete lines (YNCA terminates each line with CR/LF). */
export class LineBuffer {
  private buffer = "";

  /**
   * Add a received chunk and return the complete lines it makes available. The
   * trailing partial line stays buffered until its terminator arrives.
   *
   * @param chunk newly received text
   * @returns the complete, non-empty lines now available
   */
  public push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = parts.pop() ?? "";
    // A trailing partial line past the cap means no terminator is coming — drop it
    // rather than accumulate unbounded.
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = "";
    }
    return parts.filter(line => line.length > 0);
  }
}

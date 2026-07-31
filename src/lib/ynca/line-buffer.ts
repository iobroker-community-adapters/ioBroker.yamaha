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
    return parts.filter(line => line.length > 0);
  }
}

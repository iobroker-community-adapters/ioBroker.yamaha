/** One log line as the diagnostics report shows it. */
export interface LogLine {
  /** When it was logged (ISO time). */
  ts: string;
  /** The level it was logged at. */
  level: "silly" | "debug" | "info" | "warn" | "error";
  /** The message. */
  msg: string;
}

/** The log levels the ring records. */
const LEVELS = ["silly", "debug", "info", "warn", "error"] as const;

/** Lines kept — about a busy hour of a three-protocol receiver at debug level, a few hundred kilobytes. */
export const LOG_RING_SIZE = 2000;

/** The logger surface the ring hooks into. */
export type HookableLog = Record<(typeof LEVELS)[number], (message: string) => void>;

/**
 * The adapter's last log lines, kept for the diagnostics report — at EVERY level, also the debug lines a
 * log set to `info` never prints: a report is usually wanted after the fact, and asking a user to switch
 * to debug and wait for the fault again is exactly the round trip the report exists to save.
 */
export class LogRing {
  private readonly lines: LogLine[] = [];

  /**
   * @param size how many lines to keep
   * @param now the clock (injectable for tests)
   */
  public constructor(
    private readonly size = LOG_RING_SIZE,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record every line the logger is given, then let it log as before. The logger's own level filter
   * stays untouched — the ring only listens.
   *
   * @param log the adapter logger
   */
  public hook(log: HookableLog): void {
    for (const level of LEVELS) {
      const original = log[level].bind(log);
      log[level] = (message: string): void => {
        this.add(level, message);
        original(message);
      };
    }
  }

  /**
   * Keep one line.
   *
   * @param level the level
   * @param message the message
   */
  public add(level: LogLine["level"], message: unknown): void {
    this.lines.push({ ts: new Date(this.now()).toISOString(), level, msg: String(message) });
    if (this.lines.length > this.size) {
      this.lines.splice(0, this.lines.length - this.size);
    }
  }

  /**
   * The lines about one device: those naming it (its id or address) and those naming no other
   * device (adapter-wide lines — discovery, the push receiver, the start).
   *
   * @param mentions the strings that name this device (its id, its address)
   * @param others the strings that name the OTHER devices
   * @returns the lines, oldest first
   */
  public about(mentions: readonly string[], others: readonly string[]): LogLine[] {
    const names = (line: LogLine, list: readonly string[]): boolean =>
      list.some(text => text.length > 0 && line.msg.includes(text));
    return this.lines.filter(line => names(line, mentions) || !names(line, others));
  }
}

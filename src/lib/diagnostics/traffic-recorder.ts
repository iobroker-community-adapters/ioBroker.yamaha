import type { Transport } from "../catalog/owner-policy";

/**
 * What a device said and was told over the last minutes, held in memory for the diagnostics report (krobi 2026-10-06,
 * plan „Diagnosebericht“): the raw traffic of each protocol and of the MusicCast events, every command and what became
 * of it, the connection history, and who served which datapoint at the last connection. A report of a device that is
 * offline right now shows what happened before it went — the live read alone shows nothing there.
 *
 * Only in memory, never on disk (D1): after a restart it starts empty. It only listens — nothing here sends, writes a
 * datapoint (Y-24) or changes what the adapter does.
 *
 * - R1: what recurs is counted, not stacked — the same line, answer or packet raises a counter and moves to the newest
 *   place (first and last time kept); the values that change every second (YNCA `ELAPSEDTIME`, MusicCast `play_time`)
 *   are left out of that comparison, or a playing source would push everything else out (govee #50: 100 of 100 log
 *   lines were LAN search answers).
 * - R2: every source has its own ring with its own byte limit.
 * - R3: an entry is kept whole or dropped whole — the pseudonymiser learns names from closing XML tags, a body cut in the
 *   middle would carry a name it never learned. An entry over {@link ENTRY_MAX_BYTES} keeps only its size.
 */

/** The four raw traffic sources. */
export type TrafficSource = "ynca" | "musiccast" | "xml" | "events";

/** Each source's byte limit (R2): at most 768 KB per receiver. */
export const TRAFFIC_LIMITS: Readonly<Record<TrafficSource, number>> = {
  ynca: 256 * 1024,
  musiccast: 256 * 1024,
  xml: 128 * 1024,
  events: 128 * 1024,
};

/** The largest single entry kept with its content (R3). */
export const ENTRY_MAX_BYTES = 64 * 1024;

/** How many commands and connection events are kept. */
export const COMMAND_RING = 30;
export const HISTORY_RING = 50;

/** One raw traffic entry. */
export interface TrafficEntry {
  /** When it was seen first (R1). */
  first: string;
  /** When it was seen last. */
  last: string;
  /** How often it was seen. */
  count: number;
  /** YNCA: the direction of the line. */
  direction?: "sent" | "received";
  /** What was asked: the YNCA line sent, the MusicCast path (with its POST body), the XML request or file. */
  request?: string;
  /** What came back — a YNCA line, a MusicCast answer or event (as the object it is), an XML body. */
  answer?: unknown;
  /** Why nothing came back. */
  error?: string;
  /** How long the device took (MusicCast, XML). */
  durationMs?: number;
  /** An event that was no JSON. */
  unreadable?: true;
  /** An entry over {@link ENTRY_MAX_BYTES}: its size only (R3). */
  omittedBytes?: number;
}

/** One protocol's try of a command. */
export interface CommandAttempt {
  /** The protocol tried. */
  transport: Transport;
  /** `sent`, `refused`, `unavailable`, `unclear` — or `offline` for a protocol that was not connected. */
  outcome: string;
  /** Why this protocol was tried after the one before (Y-04): the previous one refused, could not send or was offline. */
  because?: string;
}

/** One command the user wrote and what became of it. */
export interface CommandRecord {
  /** When it was written. */
  at: string;
  /** The datapoint. */
  id: string;
  /** The value written. */
  value: unknown;
  /** Each protocol's try, in order. */
  attempts: CommandAttempt[];
  /** A command no protocol was tried for (the device was offline). */
  note?: string;
}

/** One event of the connection history. */
export interface HistoryEvent {
  /** When it happened. */
  at: string;
  /** What happened. */
  event: string;
  [detail: string]: unknown;
}

/** Everything the recorder holds, as the report shows it. */
export interface TrafficSnapshot {
  /** The raw traffic, per source, oldest first. */
  traffic: Record<TrafficSource, TrafficEntry[]>;
  /** The last commands, oldest first. */
  commands: CommandRecord[];
  /** The connection history, oldest first. */
  connectionHistory: HistoryEvent[];
  /** The owner of each datapoint at the last connection, and when that was. */
  lastOwners: { at: string; owners: Record<string, Transport> } | null;
}

/** The values a playing source changes every second, left out of the R1 comparison. */
const YNCA_CLOCK = /^(@[A-Z0-9]+:(?:ELAPSEDTIME|TOTALTIME)=).*$/;
const PLAY_TIME = /"(play_time|total_time)":-?\d+/g;

/**
 * One source's ring: entries by their fold key, oldest first; a repeat moves to the newest place.
 */
class Ring {
  private readonly entries = new Map<string, { entry: TrafficEntry; bytes: number }>();
  private bytes = 0;

  /**
   * @param limit the byte limit
   */
  public constructor(private readonly limit: number) {}

  /**
   * Record one entry under its fold key (R1), then drop whole entries from the oldest end until it fits (R3).
   *
   * @param key what makes two entries the same
   * @param at the time
   * @param entry the content
   */
  public add(key: string, at: string, entry: Omit<TrafficEntry, "first" | "last" | "count">): void {
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key);
      this.bytes -= known.bytes;
    }
    const content = sizeOf(entry) > ENTRY_MAX_BYTES ? { ...outline(entry), omittedBytes: sizeOf(entry) } : entry;
    const kept: TrafficEntry = {
      first: known?.entry.first ?? at,
      last: at,
      count: (known?.entry.count ?? 0) + 1,
      ...content,
    };
    const bytes = sizeOf(kept);
    this.entries.set(key, { entry: kept, bytes });
    this.bytes += bytes;
    for (const [oldest, held] of this.entries) {
      if (this.bytes <= this.limit || oldest === key) {
        break;
      }
      this.entries.delete(oldest);
      this.bytes -= held.bytes;
    }
  }

  /** @returns the entries, oldest first (copies) */
  public list(): TrafficEntry[] {
    return [...this.entries.values()].map(({ entry }) => structuredClone(entry));
  }
}

/**
 * An entry's size as the report holds it.
 *
 * @param entry the entry
 * @returns its bytes
 */
function sizeOf(entry: object): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/**
 * An entry too large to keep: what it was, without its content (R3 — never half of it).
 *
 * @param entry the entry
 * @returns the entry without request body and answer
 */
function outline(
  entry: Omit<TrafficEntry, "first" | "last" | "count">,
): Omit<TrafficEntry, "first" | "last" | "count"> {
  const { answer: _answer, request, ...rest } = entry;
  // A request is a path or a short XML command; only a POST body over the limit goes too.
  return { ...rest, ...(request !== undefined && Buffer.byteLength(request, "utf8") <= 1024 ? { request } : {}) };
}

/**
 * The fold key of a MusicCast answer or event: its text without the playback clock.
 *
 * @param value the answer or event
 * @returns the text the comparison uses
 */
function clockless(value: unknown): string {
  return (JSON.stringify(value) ?? "undefined").replace(PLAY_TIME, '"$1":#');
}

/** The diagnostics trail of one device. */
export class TrafficRecorder {
  private readonly rings: Record<TrafficSource, Ring> = {
    ynca: new Ring(TRAFFIC_LIMITS.ynca),
    musiccast: new Ring(TRAFFIC_LIMITS.musiccast),
    xml: new Ring(TRAFFIC_LIMITS.xml),
    events: new Ring(TRAFFIC_LIMITS.events),
  };
  private readonly commandLog: CommandRecord[] = [];
  private readonly history: HistoryEvent[] = [];
  private owners: TrafficSnapshot["lastOwners"] = null;

  /**
   * @param now the clock (injectable for tests)
   */
  public constructor(private readonly now: () => number = Date.now) {}

  /** @returns the current time as the report shows it */
  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * A YNCA line on the wire.
   *
   * @param direction sent or received
   * @param line the line, without its terminator
   */
  public yncaLine(direction: "sent" | "received", line: string): void {
    const key = `${direction} ${line.replace(YNCA_CLOCK, "$1#")}`;
    this.rings.ynca.add(key, this.stamp(), { direction, answer: line });
  }

  /**
   * A MusicCast request and its answer or failure.
   *
   * @param command the path
   * @param body the POST body, if any
   * @param result the parsed answer, or the error
   * @param durationMs how long the device took
   */
  public musiccast(
    command: string,
    body: string | undefined,
    result: { answer: unknown } | { error: string },
    durationMs: number,
  ): void {
    const request = body === undefined ? command : `${command} ${body}`;
    const outcome = "answer" in result ? clockless(result.answer) : `error ${result.error}`;
    this.rings.musiccast.add(`${request} → ${outcome}`, this.stamp(), { request, ...result, durationMs });
  }

  /**
   * An XML request (a POST body, or `GET <path>` for the device description) and its answer or failure.
   *
   * @param request what was asked
   * @param result the body, or the error
   * @param durationMs how long the device took
   */
  public xml(request: string, result: { answer: string } | { error: string }, durationMs: number): void {
    const outcome = "answer" in result ? result.answer : `error ${result.error}`;
    this.rings.xml.add(`${request} → ${outcome}`, this.stamp(), { request, ...result, durationMs });
  }

  /**
   * A MusicCast event packet routed to this device — or one from its address that was no JSON.
   *
   * @param raw the packet text
   */
  public event(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.rings.events.add(`unreadable ${raw}`, this.stamp(), { answer: raw, unreadable: true });
      return;
    }
    this.rings.events.add(clockless(parsed), this.stamp(), { answer: parsed });
  }

  /**
   * A command and the protocols it went through (Y-04).
   *
   * @param id the datapoint
   * @param value the value written
   * @param attempts each protocol's try, in order
   * @param note why no protocol was tried
   */
  public command(id: string, value: unknown, attempts: CommandAttempt[], note?: string): void {
    this.commandLog.push({ at: this.stamp(), id, value, attempts, ...(note ? { note } : {}) });
    if (this.commandLog.length > COMMAND_RING) {
      this.commandLog.shift();
    }
  }

  /**
   * One event of the connection history.
   *
   * @param event what happened
   * @param detail what belongs to it (per-protocol reasons, the failure count, …)
   */
  public connection(event: string, detail: Record<string, unknown> = {}): void {
    this.history.push({ at: this.stamp(), event, ...detail });
    if (this.history.length > HISTORY_RING) {
      this.history.shift();
    }
  }

  /**
   * Who served which datapoint at this connection (Y4) — kept for a report of the device once it is offline.
   *
   * @param owners canonical id → its owner
   */
  public lastOwners(owners: ReadonlyMap<string, Transport>): void {
    this.owners = {
      at: this.stamp(),
      owners: Object.fromEntries([...owners].sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  /**
   * Everything recorded, as a copy — taken BEFORE a report's live read, which goes through the same clients and
   * would push the history out of the rings it is meant to stand beside.
   *
   * @returns the snapshot
   */
  public snapshot(): TrafficSnapshot {
    return {
      traffic: {
        ynca: this.rings.ynca.list(),
        musiccast: this.rings.musiccast.list(),
        xml: this.rings.xml.list(),
        events: this.rings.events.list(),
      },
      commands: structuredClone(this.commandLog),
      connectionHistory: structuredClone(this.history),
      lastOwners: this.owners && structuredClone(this.owners),
    };
  }
}

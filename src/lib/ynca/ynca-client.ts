import { connect } from "node:net";
import { localAddressOption } from "../source-address";
import { LineBuffer } from "./line-buffer";
import { decodeLine, encodeCommand, encodeGet, type YncaMessage } from "./protocol";
import { buildCapabilities, type YncaCapabilities } from "./capability";
import { CommandGateClosedError, type CommandGate } from "../lifecycle/command-gate";
import { DropLatch } from "../lifecycle/drop-latch";
import { encodeDeviceText } from "../util";
import { errText } from "../err-text";

/** The YNCA control port (TCP). */
export const YNCA_PORT = 50000;

/**
 * How long to wait for the sweep's closing marker before giving up on it. The sweep sends
 * `@SYS:VERSION=?` last and treats its answer as "the device has worked through the whole
 * batch" — the reference implementation uses the same marker (`ynca-python`
 * `subunit.py`: "Use SYS:VERSION as a sync since it is available on all receivers").
 * A fixed settle window instead of a marker silently loses functions on a busy receiver.
 */
const SWEEP_MARKER_TIMEOUT_MS = 5000;

/** Fail the initial connect after this long so a non-YNCA device falls through fast. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * How long a device may take to answer one line. A refusal carries no subunit, so it can only be
 * told apart by ORDER — the receiver answers in the order it was asked (`ynca-python` syncs on the
 * same `@SYS:VERSION` marker). Measured: the RX-V473 answered a GET 1,521 ms later, after the next
 * line had already gone out (`ynca-python/logs/RX-V473.txt`), so a time window never attributes a
 * refusal safely (audit 2026-09-24, B3). A marker answer later than this means: no verdict.
 */
const MAX_ANSWER_MS = 2000;

/** The specification's minimum spacing between two lines, kept inside a bracketed exchange. */
const LINE_SPACING_MS = 100;

/** A write value that sets a number outright — the only kind a newer write of the same function may replace. */
const ABSOLUTE_NUMBER = /^-?\d+(\.\d+)?$/;

/** The closing marker every receiver answers (see {@link MAX_ANSWER_MS}). */
const VERSION_GET = encodeGet("SYS", "VERSION");

/**
 * How old a `@SYS:VERSION=?` may be before its answer counts as lost. The receiver answers in order and within 1.5 s
 * (measured), so a line this old was never answered: keeping its entry would hand every later answer to the entry
 * before its own — every bracket "unclear", every sweep waiting out its timeout for the rest of the connection.
 */
const ANSWER_LOST_MS = 15_000;

/** One `@SYS:VERSION=?` on the wire, waiting for its answer (see {@link YncaClient.versionAnswers}). */
interface VersionWait {
  /** Called with the answer — a no-op for a plain read and for a marker that timed out. */
  settle: () => void;
  /** When the line went out. */
  sentAt: number;
}

/** What one sweep collected (see {@link YncaClient.sweep}). */
interface SweepResult {
  /** Every decoded line that arrived while the sweep ran — the answers and the closing marker's. */
  messages: YncaMessage[];
  /** Whether the device answered THIS sweep's closing marker. */
  answered: boolean;
  /** Whether the connection dropped or closed before the sweep ended. */
  lost: boolean;
}

/** What a bracketed probe learned about one function (see {@link YncaClient.probeKnown}). */
export type FunctionVerdict = "known" | "undefined" | "unclear";

/**
 * Poll a keepalive this often while connected. The receiver closes an idle YNCA
 * socket after roughly a minute, so — with no keepalive — the connection drops and
 * the supervisor reconnects on a loop. The ynca protocol keeps it open by polling
 * `@SYS:MODELNAME=?` (supported by every model); the reference lib (python `ynca`)
 * uses the same 30 s interval.
 */
const KEEPALIVE_INTERVAL_MS = 30000;

/**
 * Keepalive polls that may go unanswered before the socket is torn down. A receiver cut from
 * the mains sends no FIN: without this count the socket stays "connected" until the kernel's
 * retransmit timeout gives up — many minutes — and every command written meanwhile vanishes
 * into the send buffer. Two misses = a drop within 90 s of the last byte.
 */
const KEEPALIVE_MISSES_BEFORE_DROP = 2;

/** TCP keepalive probe delay, so the kernel itself notices a vanished peer (Node default: off). */
const TCP_KEEPALIVE_DELAY_MS = 10000;

/** Adapter-managed timers so the client leaks no native timers past onUnload. */
export interface YncaTimers {
  /** Schedule a one-shot timer; returns a handle to cancel it. */
  schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Cancel a scheduled timer. */
  cancel(handle: ioBroker.Timeout | undefined): void;
}

/** The minimal socket surface the client needs — abstracted so tests can inject a fake. */
export interface YncaSocket {
  /** Write raw data to the socket. */
  write(data: string | Uint8Array): void;
  /** Close the socket. */
  destroy(): void;
  /** Register a handler for received data chunks (bytes; a string counts as its UTF-8 bytes). */
  onData(handler: (chunk: Uint8Array | string) => void): void;
  /** Register a handler for the connect event. */
  onConnect(handler: () => void): void;
  /** Register a handler for the close event. */
  onClose(handler: () => void): void;
  /** Register a handler for socket errors. */
  onError(handler: (err: Error) => void): void;
}

/** Creates a socket connected to host:port. */
export type SocketFactory = (host: string, port: number) => YncaSocket;

/**
 * Default factory backed by node:net.
 *
 * @param host the receiver IP or hostname
 * @param port the TCP port
 * @returns a socket wrapper over a node:net connection
 */
export function defaultFactory(host: string, port: number): YncaSocket {
  // From the address the user picked, where one is picked (round 87, `source-address.ts`).
  const socket = connect({ host, port, ...localAddressOption() });
  // Guard the initial connect: a device that never answers (a MusicCast-only
  // speaker has no YNCA port) must fail fast, so the parallel connect attempt
  // (attempt-device.ts) settles on the transports that answered instead of waiting for
  // the OS connect timeout. Cleared on connect; reconnect covers later drops.
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.on("timeout", () => socket.destroy(new Error("connect timeout")));
  socket.on("connect", () => {
    socket.setTimeout(0);
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
    // Commands are one-line writes paced 100 ms apart; Nagle would hold a follow-up line
    // back for up to 40 ms waiting for the previous one's ACK.
    socket.setNoDelay(true);
  });
  return {
    write: data => {
      socket.write(data);
    },
    destroy: () => {
      socket.destroy();
    },
    onData: handler => {
      // Bytes, not text: a chunk may end inside a multi-byte character — the line buffer decodes
      // whole lines only (audit 2026-09-24, B5).
      socket.on("data", (chunk: Buffer) => handler(chunk));
    },
    onConnect: handler => {
      socket.on("connect", handler);
    },
    onClose: handler => {
      socket.on("close", handler);
    },
    onError: handler => {
      socket.on("error", handler);
    },
  };
}

/**
 * A YNCA transport client for one receiver over TCP. Only one YNCA connection per
 * receiver is allowed, so a dropped connection is fully closed before a fresh one
 * is opened; reconnect and its backoff live above this client: the multi-transport
 * handle rebuilds this transport alone while others are live, the supervisor reconnects
 * the whole set once none is.
 */
export class YncaClient {
  private socket: YncaSocket | undefined;
  private readonly lineBuffer = new LineBuffer();
  private readonly messageHandlers: Array<(message: YncaMessage) => void> = [];
  /** The drop of an established connection, kept until the handle listens (the fleet latch, review 2026-10-05, E). */
  private readonly dropLatch = new DropLatch();
  private refusalHandler: ((command: string, verdict: "restricted" | "undefined") => void) | undefined;
  /**
   * One entry per `@SYS:VERSION=?` on the wire, in wire order — the answers come in the same order,
   * so each answer settles the oldest entry (a bracket's marker, a sweep's closing marker, or a plain
   * read's placeholder). A sweep ends on ITS entry, never on another's answer (review 2026-10-05, A42).
   */
  private readonly versionAnswers: VersionWait[] = [];
  /** Woken when the connection drops or closes — a wait for an answer must not outlive it. */
  private readonly dropWaiters = new Set<() => void>();
  /**
   * When the last line outside a bracket went out — a user write after it opens with a marker. Every
   * such line counts, whatever its priority: the read-back of a user write is refused late just like a
   * background read, and its refusal landed in the next write's bracket (audit 2026-09-29, B3).
   */
  private lastPlainLineAt = Number.NEGATIVE_INFINITY;
  private unknownLineHandler: ((line: string) => void) | undefined;
  /** Raw-line listeners of a running {@link capture} — every received line, decoded or not. */
  private readonly rawTaps = new Set<(line: string) => void>();
  /** The refusal window of a bracketed exchange: open between its line and its closing marker. */
  private refusalWindow: { refusal?: "restricted" | "undefined" } | undefined;
  private reachable = false;
  private everReachable = false;
  private closed = false;
  private keepaliveTimer: ioBroker.Timeout | undefined;
  /** Keepalive polls sent since the last byte arrived — any byte counts, not just the answer. */
  private unansweredKeepalives = 0;
  private lastError: Error | undefined;

  /**
   * @param host the receiver IP or hostname
   * @param timers adapter-managed timers, so no native timer outlives onUnload
   * @param gate the device's command gate — EVERY line this client puts on the wire goes
   *   through it, so the specification's 100 ms spacing holds across user writes, the init
   *   sweep, the keepalive and browsing alike
   * @param factory socket factory (defaults to a node:net socket)
   */
  public constructor(
    private readonly host: string,
    private readonly timers: YncaTimers,
    private readonly gate: CommandGate,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  /**
   * Open the connection. Resolves on the first successful connect, rejects if the
   * first connection attempt errors before connecting.
   *
   * @returns a promise that resolves once connected
   */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.openSocket(resolve, reject);
    });
  }

  private openSocket(onFirstConnect?: () => void, onFirstError?: (err: Error) => void): void {
    const socket = this.factory(this.host, YNCA_PORT);
    this.socket = socket;
    socket.onConnect(() => {
      this.reachable = true;
      this.everReachable = true;
      // Keepalive is started by the controller AFTER the init sweep (startKeepalive),
      // not here — a 30 s poll firing into the paced sweep would break its spacing.
      onFirstConnect?.();
    });
    socket.onData(chunk => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
    socket.onError(err => {
      // Remember the cause so a later drop can report why; before the first connect
      // it also rejects the connect() promise.
      this.lastError = err;
      if (!this.reachable) {
        onFirstError?.(err);
      }
    });
  }

  private handleData(chunk: Uint8Array | string): void {
    // Every byte is proof of life: while a paced sweep or refresh keeps the gate busy, its
    // answers hold the counter at zero, so a busy socket is never mistaken for a dead one.
    this.unansweredKeepalives = 0;
    for (const line of this.lineBuffer.push(chunk)) {
      for (const tap of this.rawTaps) {
        tap(line);
      }
      const response = decodeLine(line);
      if (response.status === "ok") {
        const message: YncaMessage = { subunit: response.subunit, func: response.func, value: response.value };
        if (message.subunit === "SYS" && message.func === "VERSION") {
          this.versionAnswered();
        }
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      } else if (response.status === "restricted" || response.status === "undefined") {
        // A refusal carries no subunit, so it is judged by ORDER: only one that arrives inside a
        // bracketed exchange — after the answers to everything sent before it, before its closing
        // marker — is the verdict on that exchange's line. Anything else is a background read's
        // answer (an init sweep collects hundreds) and blames nothing (audit 2026-09-24, B3).
        if (this.refusalWindow && this.refusalWindow.refusal === undefined) {
          this.refusalWindow.refusal = response.status;
        }
      } else {
        this.unknownLineHandler?.(line);
      }
    }
  }

  /**
   * A `@SYS:VERSION=` answer arrived: it belongs to the oldest version read still on the wire. An entry older than
   * {@link ANSWER_LOST_MS} with a newer one behind it lost its answer — it is let go, so the answer reaches the entry
   * it belongs to.
   */
  private versionAnswered(): void {
    const now = Date.now();
    while (this.versionAnswers.length > 1 && now - this.versionAnswers[0].sentAt > ANSWER_LOST_MS) {
      this.versionAnswers.shift();
    }
    this.versionAnswers.shift()?.settle();
  }

  private handleClose(): void {
    this.reachable = false;
    this.stopKeepalive();
    this.wakeDropWaiters();
    // A new connection starts a new order — nothing outstanding here will ever be answered.
    this.versionAnswers.length = 0;
    if (this.closed) {
      return;
    }
    // Fully close the old socket — the receiver allows only one YNCA connection, so
    // a lingering one would refuse the fresh connection. Reconnect lives above this
    // client (multi-transport handle, then supervisor): report the drop and let it
    // re-attempt, which rebuilds/re-seeds through a fresh controller.
    this.socket?.destroy();
    this.socket = undefined;
    // Only a genuine drop (we were connected) fires onDrop; a socket that never
    // connected already rejected connect() and must not also signal a drop. If the
    // multi-transport handle has not wired onDrop yet (its start() registers it only
    // after every transport connected and the tree was built), latch the drop so it is
    // delivered the moment onDrop registers — otherwise this transport dies unnoticed.
    if (this.everReachable) {
      this.dropLatch.report(this.lastError);
    }
  }

  /**
   * Start the keepalive poll. Call once, AFTER the init sweep has finished — not on
   * connect — so the 30 s `@SYS:MODELNAME=?` poll never fires a command into the
   * paced sweep and breaks the ~100 ms spacing the receiver needs. The poll keeps
   * the otherwise-idle YNCA socket open (the ynca-spec keepalive, supported by every
   * model); it self-reschedules and is stopped on drop and on close.
   */
  public startKeepalive(): void {
    // Replace, never stack: a second call would overwrite the handle while the first timer
    // keeps re-scheduling itself — an un-cancellable 30 s poll for the rest of the process.
    this.stopKeepalive();
    this.keepaliveTimer = this.timers.schedule(() => {
      if (this.unansweredKeepalives >= KEEPALIVE_MISSES_BEFORE_DROP) {
        // Torn down, not re-armed: the socket's close travels the usual drop path, and the
        // supervisor reconnects — or keeps trying — from there.
        this.lastError = new Error(
          `keepalive unanswered ${KEEPALIVE_MISSES_BEFORE_DROP} times — the receiver went silent`,
        );
        this.socket?.destroy();
        return;
      }
      this.unansweredKeepalives++;
      this.get("SYS", "MODELNAME");
      this.startKeepalive();
    }, KEEPALIVE_INTERVAL_MS);
  }

  /** Cancel the keepalive timer, if any. */
  private stopKeepalive(): void {
    this.timers.cancel(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  /**
   * Send a PUT command. Queued as a USER command: a button press must not sit behind a
   * ~190-line init sweep.
   *
   * @param subunit target subunit (e.g. `MAIN`)
   * @param func function name (e.g. `PWR`)
   * @param value value to set
   * @param charset `latin1` for a function the specification declares Latin-1 (zone names)
   * @returns the bracket's verdict on the command — `skipped` when it could not be put on the wire at all
   */
  public send(
    subunit: string,
    func: string,
    value: string,
    charset?: "latin1",
  ): Promise<"ok" | "restricted" | "undefined" | "unclear" | "skipped"> {
    // A line break inside the value would end this command and start another one on the wire.
    if (/[\r\n]/.test(value)) {
      return Promise.resolve("skipped");
    }
    const line = encodeCommand(subunit, func, value);
    const bytes = encodeDeviceText(`${line}\r\n`, charset);
    if (!bytes) {
      return Promise.resolve("skipped");
    }
    return this.gate
      .run(
        async () => {
          const verdict = await this.bracketed(bytes, false);
          if (verdict === "restricted" || verdict === "undefined") {
            this.refusalHandler?.(line, verdict);
          }
          return verdict;
        },
        "user",
        // Only an ABSOLUTE number collapses with a waiting write to the same function (a volume slider's
        // burst — the newest value wins). A key press or a step (`Down`, `Up`, `Skip Fwd`, a pad key) is
        // relative: three presses must be three lines (audit 2026-09-29, B2).
        ABSOLUTE_NUMBER.test(value) ? `${subunit}:${func}` : undefined,
      )
      .catch((e: unknown) => {
        if (!(e instanceof CommandGateClosedError)) {
          this.lastError = e instanceof Error ? e : new Error(errText(e));
        }
        return "skipped" as const;
      });
  }

  /**
   * Ask whether the device KNOWS some functions, without changing anything: a GET of each, bracketed
   * by markers. `@UNDEFINED` inside the bracket = unknown on this model; silence or a value = known
   * (a write-only key such as `LISTCURSOR` answers a GET with nothing — RX-A810 log); a timeout or
   * `@RESTRICTED` (not now) = unclear. The pad dialect is decided by this, never by a refused key
   * press (audit 2026-09-24, B3).
   *
   * @param subunit the subunit to ask
   * @param funcs the functions to ask about
   * @returns the verdict per function (all unclear when the connection closed meanwhile)
   */
  public async probeKnown(subunit: string, funcs: readonly string[]): Promise<Record<string, FunctionVerdict>> {
    const unclear: Record<string, FunctionVerdict> = {};
    for (const func of funcs) {
      unclear[func] = "unclear";
    }
    try {
      return await this.gate.run(async () => {
        const verdicts: Record<string, FunctionVerdict> = {};
        for (const func of funcs) {
          const bytes = encodeDeviceText(`${encodeGet(subunit, func)}\r\n`);
          const verdict = bytes ? await this.bracketed(bytes, true) : "unclear";
          verdicts[func] = verdict === "undefined" ? "undefined" : verdict === "ok" ? "known" : "unclear";
        }
        return verdicts;
      }, "background");
    } catch {
      return unclear;
    }
  }

  /**
   * Put one line on the wire bracketed by markers and judge the refusal that arrives inside the
   * bracket. Runs INSIDE a gate operation, so nothing else is written meanwhile; the spacing between
   * the lines is kept by hand.
   *
   * @param bytes the encoded line
   * @param alwaysLead whether to open with a marker even without recent background traffic
   * @returns `ok` (no refusal), the refusal, or `unclear` when a marker went unanswered
   */
  private async bracketed(bytes: Buffer, alwaysLead: boolean): Promise<"ok" | "restricted" | "undefined" | "unclear"> {
    let certain = true;
    if (alwaysLead || Date.now() - this.lastPlainLineAt < MAX_ANSWER_MS) {
      // Answers to lines sent before this one may still be on their way (1.5 s measured):
      // the leading marker's answer comes after all of them.
      certain = await this.marker();
      await this.gate.delay(LINE_SPACING_MS);
    }
    const window: { refusal?: "restricted" | "undefined" } = {};
    this.refusalWindow = window;
    try {
      this.socket?.write(bytes);
      this.gate.written();
      await this.gate.delay(LINE_SPACING_MS);
      certain = (await this.marker()) && certain;
    } finally {
      if (this.refusalWindow === window) {
        this.refusalWindow = undefined;
      }
    }
    if (!certain) {
      return "unclear";
    }
    return window.refusal ?? "ok";
  }

  /**
   * Write a `@SYS:VERSION=?` marker (inside a gate operation) and wait for its answer.
   *
   * @returns true when the answer came within {@link MAX_ANSWER_MS}
   */
  private marker(): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let settled = false;
      // Stays queued after a timeout, so a late answer still settles THIS entry and the order holds.
      this.versionAnswers.push({
        settle: () => {
          if (!settled) {
            settled = true;
            resolve(true);
          }
        },
        sentAt: Date.now(),
      });
      this.socket?.write(encodeDeviceText(`${VERSION_GET}\r\n`) ?? Buffer.alloc(0));
      this.gate.written();
      void this.gate.delay(MAX_ANSWER_MS).then(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
    });
  }

  /**
   * Register the handler called when the device REFUSES a user command
   * (`@RESTRICTED`: not possible right now / not allowed; `@UNDEFINED`: this model
   * does not know the function). The controller logs it — a dead button must leave
   * a trace.
   *
   * @param handler called with the refused command line and the device's verdict
   */
  public onRefusal(handler: (command: string, verdict: "restricted" | "undefined") => void): void {
    this.refusalHandler = handler;
  }

  /**
   * Register the handler for a line the adapter cannot decode (neither a value, nor a refusal) —
   * such a line used to vanish without a trace (audit 2026-09-24, B14).
   *
   * @param handler called with the raw line
   */
  public onUnknownLine(handler: (line: string) => void): void {
    this.unknownLineHandler = handler;
  }

  /**
   * Send a GET request (background priority — reads yield to user commands).
   *
   * @param subunit target subunit
   * @param func function name
   * @param priority `user` for the read-back of a user write, which must not wait behind a refresh
   */
  public get(subunit: string, func: string, priority: "user" | "background" = "background"): void {
    void this.writeLine(encodeGet(subunit, func), priority);
  }

  /**
   * Put one line on the wire through the command gate — the single choke point that keeps
   * the specification's spacing. NEVER rejects: a closed gate is the normal teardown path,
   * and a socket write that fails reports through the socket's own error/close handlers
   * (the drop the supervisor reconnects on). A rejection here would surface as an
   * unhandled promise rejection in the fire-and-forget get() caller — and
   * js-controller stops the adapter on those.
   *
   * @param line the encoded YNCA line (without the terminator)
   * @param priority user command or background read
   * @param charset `latin1` for a function the specification declares Latin-1
   * @param onVersionAnswer for a version read: called with ITS answer (a sweep's closing marker)
   * @returns resolves once the line was written, or once it is clear it never will be
   */
  private writeLine(
    line: string,
    priority: "user" | "background",
    charset?: "latin1",
    onVersionAnswer?: () => void,
  ): Promise<void> {
    // A function the specification declares Latin-1 (zone names) is sent as Latin-1 bytes; a text it
    // cannot carry is not sent at all — the controller checks that before (audit 2026-09-24, B5/B13).
    const bytes = encodeDeviceText(`${line}\r\n`, charset);
    if (!bytes) {
      return Promise.resolve();
    }
    return this.gate
      .run(() => {
        if (line === VERSION_GET) {
          // A plain read of the version is answered like a marker: its entry keeps the order.
          this.versionAnswers.push({ settle: onVersionAnswer ?? ((): void => {}), sentAt: Date.now() });
        }
        this.lastPlainLineAt = Date.now();
        this.socket?.write(bytes);
        this.gate.written();
      }, priority)
      .catch((e: unknown) => {
        if (!(e instanceof CommandGateClosedError)) {
          this.lastError = e instanceof Error ? e : new Error(errText(e));
        }
      });
  }

  /**
   * Register a handler for decoded messages from the receiver.
   *
   * @param handler called with each ok message
   */
  public onMessage(handler: (message: YncaMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register the handler called once when an established connection drops (not on an
   * explicit close, and not for a socket that never connected). The supervisor uses
   * it to reconnect; the optional reason is the last socket error, for logging.
   *
   * @param handler called on an unexpected drop, with the last error if any
   */
  public onDrop(handler: (reason?: Error) => void): void {
    this.dropLatch.onDrop(handler);
  }

  /**
   * Run an init sweep: send a GET for each requested function and collect the responses.
   *
   * Pacing is the command gate's job — every GET goes through it, so the sweep is spaced
   * against user writes and the keepalive instead of only against itself.
   *
   * The end of the sweep is CONFIRMED, not guessed: after the last GET the sweep sends
   * `@SYS:VERSION=?` as a closing marker and waits for its answer (every receiver answers
   * it — the reference implementation syncs on the same function). A fixed settle window
   * would silently drop the functions of a busy receiver that answers a moment late, and
   * those datapoints would then never be created.
   *
   * @param gets the subunit/function pairs to query
   * @returns the assembled capabilities — the closing marker's own answer among them (`SYS:VERSION`)
   */
  public async readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities> {
    const { messages, lost } = await this.sweep(gets);
    // A drop mid-sweep or inside the marker window must not hand back a PARTIAL report as if it were
    // complete (audit 2026-09-24, B2). An unanswered marker, though, ends the wait with what came: a busy
    // device's last answers may still be on their way, and the next start's background refresh unions the
    // rest into the remembered shape (audit 2026-09-29, B13).
    if (lost) {
      throw new Error("connection lost during capability sweep");
    }
    return buildCapabilities(messages);
  }

  /**
   * Read functions for a diagnostics report: the GETs go out like a sweep (background priority, through
   * the gate), and every line the device sends meanwhile is kept VERBATIM — answers, `@UNDEFINED`/
   * `@RESTRICTED` and lines nobody decodes. Changes nothing on the device and never throws: a drop
   * or a closed gate ends the read with what came, marked incomplete. The answers also reach the
   * message handlers as usual — they are the device's real values.
   *
   * @param gets the subunit/function pairs to read
   * @returns the received lines in arrival order, and whether the read ran to its closing marker
   */
  public async capture(
    gets: ReadonlyArray<{ subunit: string; func: string }>,
  ): Promise<{ lines: string[]; complete: boolean }> {
    const lines: string[] = [];
    const { answered, lost } = await this.sweep(gets, line => lines.push(line));
    return { lines, complete: answered && !lost };
  }

  /**
   * The one sweep loop behind {@link readCapabilities} and {@link capture} (it stood twice — review 2026-10-05,
   * B7): send the GETs through the gate, then the closing marker, and collect every decoded line that arrives
   * meanwhile (and, for a diagnostics read, every raw line). A drop or a close ends it at once.
   *
   * @param gets the subunit/function pairs to read
   * @param raw called with every received line, decoded or not, while the sweep runs
   * @returns what arrived, whether the closing marker was answered, and whether the connection was lost
   */
  private async sweep(
    gets: ReadonlyArray<{ subunit: string; func: string }>,
    raw?: (line: string) => void,
  ): Promise<SweepResult> {
    const messages: YncaMessage[] = [];
    const collector = (message: YncaMessage): void => {
      messages.push(message);
    };
    this.messageHandlers.push(collector);
    if (raw) {
      this.rawTaps.add(raw);
    }
    try {
      for (const request of gets) {
        // A drop mid-sweep makes the write a silent no-op; without this check the loop would run to the end.
        if (!this.reachable) {
          return { messages, answered: false, lost: true };
        }
        await this.writeLine(encodeGet(request.subunit, request.func), "background");
      }
      if (!this.reachable) {
        return { messages, answered: false, lost: true };
      }
      const answered = await this.awaitSweepMarker();
      return { messages, answered, lost: !this.reachable };
    } finally {
      if (raw) {
        this.rawTaps.delete(raw);
      }
      const index = this.messageHandlers.indexOf(collector);
      if (index >= 0) {
        this.messageHandlers.splice(index, 1);
      }
    }
  }

  /**
   * Send the closing marker and wait for the device to answer IT — or for the timeout, so an
   * unusual firmware that stays silent costs a delay, never the whole connection. The answer is
   * told by its place in the answer order ({@link versionAnswers}): ended on the first
   * `@SYS:VERSION=` line, a sweep ended on another exchange's answer — a version read in its own
   * list, a concurrent sweep's marker — and handed back what its device had not finished answering
   * (review 2026-10-05, A42).
   *
   * @returns true when the marker was answered; false on the timeout or a drop
   */
  private async awaitSweepMarker(): Promise<boolean> {
    let settled = false;
    let settle: (answered: boolean) => void = () => {};
    const answered = new Promise<boolean>(resolve => {
      settle = (value: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
    });
    const wake = (): void => settle(false);
    this.dropWaiters.add(wake);
    try {
      await this.writeLine(VERSION_GET, "background", undefined, () => settle(true));
      return await Promise.race([answered, this.gate.delay(SWEEP_MARKER_TIMEOUT_MS).then(() => false)]);
    } finally {
      // The entry stays queued: a late answer settles it (a no-op now), so the order of the ones after it holds.
      settled = true;
      this.dropWaiters.delete(wake);
    }
  }

  /** End every wait for an answer — the connection that would carry it is gone. */
  private wakeDropWaiters(): void {
    for (const wake of [...this.dropWaiters]) {
      wake();
    }
  }

  /**
   * Close the connection permanently (no reconnect). Synchronous — safe to call from
   * onUnload. Closing the gate empties its queue and aborts its signal, so a sweep or a
   * browse walk that is still awaiting ends instead of hanging on a cancelled timer.
   */
  public close(): void {
    this.closed = true;
    this.reachable = false;
    this.stopKeepalive();
    this.wakeDropWaiters();
    this.gate.close();
    this.socket?.destroy();
    this.socket = undefined;
  }
}

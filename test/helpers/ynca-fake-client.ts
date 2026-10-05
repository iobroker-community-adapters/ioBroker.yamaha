import type { YncaCapabilities } from "../../src/lib/ynca/capability";
import type { YncaClientLike, YncaSendVerdict } from "../../src/lib/ynca/client-like";
import { CommandGate } from "../../src/lib/lifecycle/command-gate";

/** One line the fake device received or sent. */
export interface FakeMessage {
  /** The subunit. */
  subunit: string;
  /** The function. */
  func: string;
  /** The value. */
  value: string;
}

/** The one-GET-answers-many functions of the official lists (see bundleGets in the catalog). */
export const BUNDLE_FUNCS = new Set(["BASIC", "SCENENAME", "SIGINFO", "RDSINFO", "METAINFO"]);

/**
 * A real command gate for a controller under test (pacing has its own suite).
 *
 * @returns a gate on the global timers, without spacing
 */
export const testGate = (): CommandGate =>
  new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  });

/**
 * A YNCA device as the controller sees it through its client. It answers like the real client does — including the
 * answer to the sweep's closing marker `@SYS:VERSION=?`, which the real client collects into every report. The fake
 * used to leave it out, and so the controller's dead blind-sweep fallback (a probe "answered" by SYS alone) stayed
 * hidden from every test (review 2026-10-05, A1).
 */
export class FakeClient implements YncaClientLike {
  public sent: FakeMessage[] = [];
  public closed = false;
  public keepaliveStarted = false;
  public capabilities: YncaCapabilities = { model: "", subunits: {} };
  /**
   * When set, an AVAIL-only request list (the probe pass) is answered with exactly these subunits; unset, every
   * readCapabilities call returns `capabilities` (no AVAIL answers — a device that ignores the probe).
   */
  public availableSubunits?: string[];
  /**
   * When set, a LISTINFO-only request list (the browse probe, #613) is answered with list fields for exactly these
   * subunits — every other one stays silent, as a real receiver does with `@UNDEFINED`. Unset, the probe falls
   * through to `capabilities`.
   */
  public listSubunits?: string[];
  /** Every readCapabilities request list, for asserting what was actually swept. */
  public requests: Array<Array<{ subunit: string; func: string }>> = [];
  /** Every bundle GET asked (`SUBUNIT:FUNC`), in order. */
  public bundlesAsked: string[] = [];
  /** What `send` reports — the bracket's verdict on the PUT; unset, nothing (an older client). */
  public sendVerdict: YncaSendVerdict | undefined;
  /** Every GET asked outside a sweep (read-backs, the browse driver), in order. */
  public gets: Array<{ subunit: string; func: string }> = [];
  /**
   * The bracketed probe — a test replaces it; by default the device says nothing definite.
   *
   * @param _subunit the subunit asked
   * @param funcs the functions asked
   * @returns an unclear verdict for each
   */
  public probeKnown: (
    subunit: string,
    funcs: readonly string[],
  ) => Promise<Record<string, "known" | "undefined" | "unclear">> = (_subunit, funcs) =>
    Promise.resolve(Object.fromEntries(funcs.map(func => [func, "unclear" as const])));
  /** Replaced per test to capture the registered handler. */
  public onRefusal: (handler: (command: string, verdict: "restricted" | "undefined") => void) => void = () => undefined;
  /** Lines that decode to nothing — ignored by the fake. */
  public onUnknownLine: (handler: (line: string) => void) => void = () => undefined;
  private handler?: (message: FakeMessage) => void;

  /** Connected at once. */
  public async connect(): Promise<void> {}

  /**
   * A sweep: answered from {@link capabilities} like the device would, by the kind of list asked.
   *
   * @param gets the asked functions
   * @returns the report, with the closing marker's answer in it
   */
  public readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities> {
    this.requests.push(gets);
    if (this.availableSubunits && gets.length > 0 && gets.every(get => get.func === "AVAIL")) {
      const subunits: Record<string, Record<string, string>> = {};
      for (const subunit of this.availableSubunits) {
        subunits[subunit] = { AVAIL: "Ready" };
      }
      return this.withMarker({ model: "", subunits });
    }
    if (gets.length > 0 && gets.every(get => BUNDLE_FUNCS.has(get.func))) {
      // A bundle (BASIC, SCENENAME, SIGINFO, RDSINFO, METAINFO) answers with the functions the subunit has — on a
      // fake, whatever the capabilities carry for it (a real BASIC lists 15–25 of them).
      const subunits: Record<string, Record<string, string>> = {};
      for (const get of gets) {
        const subunit = this.capabilities.subunits[get.subunit];
        if (subunit) {
          subunits[get.subunit] = { ...subunit };
        }
      }
      this.bundlesAsked.push(...gets.map(get => `${get.subunit}:${get.func}`));
      return this.withMarker({ model: "", subunits });
    }
    if (this.listSubunits && gets.length > 0 && gets.every(get => get.func === "LISTINFO")) {
      const subunits: Record<string, Record<string, string>> = {};
      for (const subunit of this.listSubunits) {
        subunits[subunit] = { LISTLAYER: "1", LISTLAYERNAME: "Root", CURRLINE: "1", MAXLINE: "2" };
      }
      return this.withMarker({ model: "", subunits });
    }
    return this.withMarker(this.capabilities);
  }

  /**
   * A PUT, recorded.
   *
   * @param subunit the subunit
   * @param func the function
   * @param value the wire value
   * @returns the verdict a test set in `sendVerdict`, if any
   */
  public send(subunit: string, func: string, value: string): void | Promise<YncaSendVerdict> {
    this.sent.push({ subunit, func, value });
    return this.sendVerdict === undefined ? undefined : Promise.resolve(this.sendVerdict);
  }

  /**
   * A GET outside a sweep, recorded.
   *
   * @param subunit the subunit
   * @param func the function
   */
  public get(subunit: string, func: string): void {
    this.gets.push({ subunit, func });
  }

  /**
   * The controller's line handler.
   *
   * @param handler called with every line the device sends
   */
  public onMessage(handler: (message: FakeMessage) => void): void {
    this.handler = handler;
  }

  /** The fake never drops. */
  public onDrop(): void {}

  /** Recorded only. */
  public startKeepalive(): void {
    this.keepaliveStarted = true;
  }

  /** Recorded only. */
  public close(): void {
    this.closed = true;
  }

  /**
   * A line the device sends on its own.
   *
   * @param message the line
   */
  public emit(message: FakeMessage): void {
    this.handler?.(message);
  }

  /**
   * The report with the closing marker's answer in it — what the real client collects after every sweep, as long as
   * the device has a version to answer with.
   *
   * @param report the answers to the asked functions
   * @returns the report the real client would hand back
   */
  private withMarker(report: YncaCapabilities): Promise<YncaCapabilities> {
    const version = this.capabilities.subunits.SYS?.VERSION;
    if (version === undefined || report.subunits.SYS?.VERSION === version) {
      return Promise.resolve(report);
    }
    return Promise.resolve({
      ...report,
      subunits: { ...report.subunits, SYS: { ...report.subunits.SYS, VERSION: version } },
    });
  }
}

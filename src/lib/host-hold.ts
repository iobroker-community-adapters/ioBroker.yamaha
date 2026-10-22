import { HttpStatusError } from "./util";

/** The wait a 429 without a readable `Retry-After` holds its host for (govee's `call-gate.ts` waits the same). */
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** The longest wait a `Retry-After` may set: a device that comes back is seen within the fleet's 300 s. */
const MAX_RETRY_AFTER_MS = 300_000;
/** Server errors in a row before the host is held — one is a web server still booting, D6 plays one per request. */
const ERRORS_BEFORE_HOLD = 3;
/** The first hold of a series of server errors; each further error doubles it. */
const FIRST_HOLD_MS = 5_000;
/** The longest hold of a series of server errors — a device whose web server recovers answers within a minute. */
const MAX_HOLD_MS = 60_000;

/** What one host has answered lately. */
interface HostState {
  /** No call goes out before this time. */
  until: number;
  /** The status the hold answers with, as the host would. */
  status: number;
  /** Server errors (5xx) in a row. */
  errors: number;
  /** A call is under way while the host is in a series of errors — the next one waits for its answer. */
  probing: boolean;
}

/**
 * The HTTP calls of every protocol to one host, held when the host says so (fleet suite D21, 2026-10-22): a 429 holds
 * the host for its `Retry-After`, a series of server errors for a hold that doubles up to a minute, and while a series
 * runs only one call at a time goes out — the MusicCast and the XML gate each fired at the end of a hold and the calls
 * stayed at eight a minute under a 500 to every answer. A held call is answered here like the host would (govee
 * `call-gate.ts`): with the status it answered last, an `HttpStatusError`, so every caller keeps its handling of an
 * answer — the device counts as there, a write falls back to the next protocol (Y-04). A call nobody answered changes
 * nothing; a lost device stays the supervisor's.
 *
 * Process-wide on purpose, like the command gates (`GateRegistry`): the hold belongs to the physical device, whichever
 * code path — connection, MusicCast Link partner, network search — talks to it.
 */
export class HostHold {
  private readonly hosts = new Map<string, HostState>();

  /**
   * @param now the clock
   */
  public constructor(private readonly now: () => number = Date.now) {}

  /**
   * Send one call to a host through the hold.
   *
   * @param host the host the call goes to
   * @param what what is asked, for the message of a held call
   * @param send sends the call
   * @returns the call's answer; a held call rejects at once with {@link HttpStatusError}
   */
  public run<T>(host: string, what: string, send: () => Promise<T>): Promise<T> {
    const held = this.refusal(host, what);
    if (held) {
      return Promise.reject(held);
    }
    const state = this.hosts.get(host);
    if (state && state.errors >= ERRORS_BEFORE_HOLD) {
      state.probing = true;
    }
    return send().then(
      answer => {
        this.answered(host);
        return answer;
      },
      (e: unknown) => {
        this.failed(host, e);
        throw e;
      },
    );
  }

  /**
   * How long the host is still held — 0 when a call may go out.
   *
   * @param host the host
   * @returns the milliseconds left
   */
  public heldMs(host: string): number {
    const state = this.hosts.get(host);
    return state ? Math.max(0, state.until - this.now()) : 0;
  }

  /**
   * The answer a held call gets instead of going out.
   *
   * @param host the host
   * @param what what is asked
   * @returns the error, or undefined when the call may go out
   */
  private refusal(host: string, what: string): HttpStatusError | undefined {
    const state = this.hosts.get(host);
    if (!state) {
      return undefined;
    }
    const left = this.heldMs(host);
    if (left > 0) {
      return new HttpStatusError(
        `${what} not sent — ${host} answered HTTP ${state.status}, held for ${Math.ceil(left / 1000)} s`,
        state.status,
      );
    }
    if (state.probing) {
      return new HttpStatusError(
        `${what} not sent — ${host} answered HTTP ${state.status}, one call is under way`,
        state.status,
      );
    }
    return undefined;
  }

  /**
   * A 2xx answer: the series of errors ends (a running 429 hold stays — it names its own end).
   *
   * @param host the host
   */
  private answered(host: string): void {
    const state = this.hosts.get(host);
    if (state) {
      state.probing = false;
      state.errors = 0;
    }
  }

  /**
   * A call that failed: a 429 holds the host for its `Retry-After`, a 5xx counts into the series; any other status
   * (an XML 400 for a node the model lacks) is the device's verdict and no error of the host, and a call nobody
   * answered is not the host's word at all.
   *
   * @param host the host
   * @param e what the call failed with
   */
  private failed(host: string, e: unknown): void {
    const state = this.hosts.get(host) ?? { until: 0, status: 0, errors: 0, probing: false };
    state.probing = false;
    if (e instanceof HttpStatusError && e.statusCode === 429) {
      state.status = 429;
      state.until = Math.max(state.until, this.now() + retryAfterMs(e.retryAfter, this.now()));
    } else if (e instanceof HttpStatusError && e.statusCode >= 500) {
      state.status = e.statusCode;
      state.errors++;
      if (state.errors >= ERRORS_BEFORE_HOLD) {
        const hold = Math.min(FIRST_HOLD_MS * 2 ** (state.errors - ERRORS_BEFORE_HOLD), MAX_HOLD_MS);
        state.until = Math.max(state.until, this.now() + hold);
      }
    }
    this.hosts.set(host, state);
  }
}

/**
 * The wait a `Retry-After` names — seconds or an HTTP date (RFC 9110 §10.2.3); without a readable one the default.
 *
 * @param header the header's value
 * @param now the current time
 * @returns the wait in milliseconds, within the longest one
 */
export function retryAfterMs(header: string | undefined, now: number): number {
  const text = typeof header === "string" ? header.trim() : "";
  const ms = /^\d+$/.test(text)
    ? Number(text) * 1000
    : Number.isNaN(Date.parse(text))
      ? DEFAULT_RETRY_AFTER_MS
      : Date.parse(text) - now;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** The one hold of this process (see {@link HostHold}). */
export const HOST_HOLD = new HostHold();

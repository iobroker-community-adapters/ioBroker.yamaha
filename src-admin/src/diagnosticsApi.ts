// The admin side of the `diagnostics` message (backend: src/lib/diagnostics/diagnostics-handler.ts).
// Kept free of React and socket-client imports so it stays a pure, testable factory: the only
// dependencies are the socket's `sendTo` and its state subscription. The answer shapes are re-declared
// here as types — they MUST stay in step with the handler.

import { errText } from "../../src/lib/err-text";

/** One device as the handler lists it. */
export interface DiagnosticsDevice {
  /** The device id. */
  value: string;
  /** What the card shows. */
  label: string;
  /** Whether it is connected — an unconnected one gets a report without the live read. */
  connected: boolean;
}

/** A finished report: the file name and the JSON text. */
export interface DiagnosticsReport {
  fileName: string;
  content: string;
}

/** What the export action answers. */
export type DiagnosticsExportResult = DiagnosticsReport | { error: string };

/** A state as the admin connection hands it to a subscriber. */
export type StateHandler = (id: string, state: { val?: unknown } | null | undefined) => void;

/** The admin socket's surface the card uses. */
export interface DiagnosticsSocket {
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
  /** Watch a state: the admin connection calls the handler with the current value, then on every change. */
  subscribeState?(id: string, handler: StateHandler): Promise<void> | void;
  /** Stop watching. */
  unsubscribeState?(id: string, handler?: StateHandler): void;
}

/** Thrown when the device list could not be fetched — an empty list and a broken call never look alike. */
export class DeviceListError extends Error {}

/** Why the instance gave no answer. */
export type UnavailableReason = "notRunning" | "stopped" | "noAnswer";

/**
 * The instance could not answer: it is not running, it stopped (or restarted) while the card waited, or it
 * did not answer in time. The card turns the reason into its own words.
 */
export class InstanceUnavailableError extends Error {
  /**
   * @param reason why there is no answer
   * @param seconds how long the card waited (for `noAnswer`)
   */
  public constructor(
    public readonly reason: UnavailableReason,
    public readonly seconds = 0,
  ) {
    super(`instance unavailable: ${reason}`);
    this.name = "InstanceUnavailableError";
  }
}

/** How long the card waits for the device list — the adapter answers it from memory at once. */
export const LIST_TIMEOUT_MS = 15_000;

/**
 * How long the card waits for a report: reading a receiver over its protocols takes up to a minute (the YNCA
 * read alone 35–60 s), a busy one longer — the wait ends long before only when the instance stops.
 */
export const EXPORT_TIMEOUT_MS = 180_000;

/** How long the card waits for each answer. */
export interface DiagnosticsTimeouts {
  /** The device list. */
  listMs: number;
  /** One report. */
  exportMs: number;
}

/** The two operations the card drives. */
export interface DiagnosticsApi {
  /** Every device the instance runs, connected or not. */
  listDevices(): Promise<DiagnosticsDevice[]>;
  /** Read one device and get its report back. */
  exportReport(device: string): Promise<DiagnosticsExportResult>;
}

/**
 * Whether an export answer carries a report.
 *
 * @param r the answer
 */
export function isReport(r: DiagnosticsExportResult): r is DiagnosticsReport {
  return typeof (r as DiagnosticsReport).fileName === "string" && typeof (r as DiagnosticsReport).content === "string";
}

/**
 * Send one `diagnostics` message to the instance and wait for its answer — but not forever. The admin
 * connection's `sendTo` has no timeout of its own, so a stopped instance left the card at "Loading devices…"
 * for good, and an instance restarted during a report left its button locked (review 2026-10-05, B2). The
 * instance's `alive` state tells at once when it is not running and when it stops while the card waits; the
 * timeout catches what neither shows (an instance that runs but does not answer).
 *
 * @param socket the admin socket
 * @param namespace the instance, e.g. `yamaha.0`
 * @param data the message
 * @param timeoutMs how long to wait for the answer
 * @returns the answer; rejects with {@link InstanceUnavailableError} or the socket's own error
 */
export async function askInstance(
  socket: DiagnosticsSocket,
  namespace: string,
  data: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const aliveId = `system.adapter.${namespace}.alive`;
  let seenAlive = false;
  let giveUp: (reason: InstanceUnavailableError) => void = () => {};
  const unavailable = new Promise<never>((_resolve, reject) => {
    giveUp = reject;
  });
  const onAlive: StateHandler = (_id, state) => {
    if (state?.val === true) {
      seenAlive = true;
      return;
    }
    giveUp(new InstanceUnavailableError(seenAlive ? "stopped" : "notRunning"));
  };
  const timer = setTimeout(
    () => giveUp(new InstanceUnavailableError("noAnswer", Math.round(timeoutMs / 1000))),
    timeoutMs,
  );
  try {
    // A socket without the subscription still gets the answer or the timeout.
    void Promise.resolve(socket.subscribeState?.(aliveId, onAlive)).catch(() => undefined);
  } catch {
    // The same: no watch, the timeout stays.
  }
  try {
    return await Promise.race([socket.sendTo(namespace, "diagnostics", data), unavailable]);
  } finally {
    clearTimeout(timer);
    socket.unsubscribeState?.(aliveId, onAlive);
  }
}

/**
 * Build the API for one admin socket and instance.
 *
 * @param socket the admin socket
 * @param namespace the instance, e.g. `yamaha.0`
 * @param timeouts how long to wait for each answer
 */
export function makeDiagnosticsApi(
  socket: DiagnosticsSocket,
  namespace: string,
  timeouts: DiagnosticsTimeouts = { listMs: LIST_TIMEOUT_MS, exportMs: EXPORT_TIMEOUT_MS },
): DiagnosticsApi {
  return {
    async listDevices(): Promise<DiagnosticsDevice[]> {
      let answer: unknown;
      try {
        answer = await askInstance(socket, namespace, { action: "list" }, timeouts.listMs);
      } catch (e) {
        throw e instanceof InstanceUnavailableError ? e : new DeviceListError(errText(e));
      }
      const devices = (answer as { devices?: unknown } | null)?.devices;
      if (!Array.isArray(devices)) {
        const error = (answer as { error?: unknown } | null)?.error;
        throw new DeviceListError(typeof error === "string" ? error : "");
      }
      return devices as DiagnosticsDevice[];
    },
    async exportReport(device: string): Promise<DiagnosticsExportResult> {
      const answer = await askInstance(socket, namespace, { action: "export", device }, timeouts.exportMs);
      if (answer && typeof answer === "object" && (isReport(answer as DiagnosticsExportResult) || "error" in answer)) {
        return answer as DiagnosticsExportResult;
      }
      return { error: "" };
    },
  };
}

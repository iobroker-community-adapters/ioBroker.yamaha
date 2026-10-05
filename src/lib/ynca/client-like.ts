import type { YncaCapabilities } from "./capability";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";

/** What the device made of a PUT: the bracket's verdict, or `skipped` when the line never went out. */
export type YncaSendVerdict = "ok" | "restricted" | "undefined" | "unclear" | "skipped";

/**
 * The write outcome a PUT's verdict means — the one mapping for every YNCA write path (review 2026-10-05, A3: the
 * band-routed tuner writes, the zone-routed player writes and the pads dropped it, the handle read "unclear" and never
 * tried another protocol).
 *
 * @param verdict what the client reported (nothing from a client that cannot say)
 * @returns `sent`, `refused` (the device said no), `unavailable` (never went out) or `unclear`
 */
export async function outcomeOf(verdict: void | YncaSendVerdict | Promise<YncaSendVerdict>): Promise<WriteOutcome> {
  const said = await verdict;
  return said === "ok"
    ? "sent"
    : said === "restricted" || said === "undefined"
      ? "refused"
      : said === "skipped"
        ? "unavailable"
        : "unclear";
}

/**
 * The subset of the YNCA client the controller and its parts (shape reader, menus) use — one definition, so tests
 * can inject a fake and no part imports the controller for it.
 */
export interface YncaClientLike {
  /** Open the connection. */
  connect(): Promise<void>;
  /** Run the init sweep and return the device's capabilities. */
  readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities>;
  /** Send a PUT command. */
  send(subunit: string, func: string, value: string, charset?: "latin1"): void | Promise<YncaSendVerdict>;
  /** Send a GET request (the browse driver reads LISTINFO with it); a read-back asks at user priority. */
  get(subunit: string, func: string, priority?: "user" | "background"): void;
  /** Register a handler for pushed messages. */
  onMessage(handler: (message: { subunit: string; func: string; value: string }) => void): void;
  /** Register the socket-drop handler the supervisor reconnects on. */
  onDrop(handler: (reason?: Error) => void): void;
  /** Register the refusal handler for user commands the device rejects. */
  onRefusal(handler: (command: string, verdict: "restricted" | "undefined") => void): void;
  /** Register the handler for lines that decode to nothing. */
  onUnknownLine(handler: (line: string) => void): void;
  /** Ask, without changing anything, whether the device knows some functions. */
  probeKnown(subunit: string, funcs: readonly string[]): Promise<Record<string, "known" | "undefined" | "unclear">>;
  /** Start the keepalive poll — called after the init sweep, not on connect. */
  startKeepalive(): void;
  /** Close the connection synchronously. */
  close(): void;
}

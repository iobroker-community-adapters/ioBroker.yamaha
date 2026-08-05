/** A decoded subunit/function/value message — the canonical shape across the YNCA layer. */
export interface YncaMessage {
  /** The subunit that reported (e.g. `MAIN`, `ZONE2`, `TUN`). */
  subunit: string;
  /** The function name (e.g. `PWR`, `VOL`). */
  func: string;
  /** The reported value. */
  value: string;
}

/** A decoded YNCA response line. */
export type YncaResponse =
  ({ status: "ok" } & YncaMessage) | { status: "undefined" } | { status: "restricted" } | { status: "unknown" };

/**
 * Decode one YNCA protocol line into a structured response. Handles the bare
 * markers `@UNDEFINED` / `@RESTRICTED` (which are not of the `SUBUNIT:FUNC=VALUE`
 * shape) and splits only on the first ":" and "=", so a value keeps any later "=".
 *
 * @param line a single line received from the receiver
 * @returns the decoded response; `unknown` for anything that is not a YNCA response
 */
export function decodeLine(line: string): YncaResponse {
  if (line === "@UNDEFINED") {
    return { status: "undefined" };
  }
  if (line === "@RESTRICTED") {
    return { status: "restricted" };
  }
  if (!line.startsWith("@")) {
    return { status: "unknown" };
  }
  const colon = line.indexOf(":");
  const equals = line.indexOf("=");
  // subunit needs >= 1 char (colon >= 2), func needs >= 1 char (equals >= colon + 2).
  if (colon < 2 || equals < colon + 2) {
    return { status: "unknown" };
  }
  return {
    status: "ok",
    subunit: line.slice(1, colon),
    func: line.slice(colon + 1, equals),
    value: line.slice(equals + 1),
  };
}

/**
 * Encode a PUT command.
 *
 * @param subunit the target subunit (e.g. `MAIN`)
 * @param func the function name (e.g. `PWR`)
 * @param value the value to set
 * @returns the wire line, e.g. `@MAIN:PWR=On`
 */
export function encodeCommand(subunit: string, func: string, value: string): string {
  return `@${subunit}:${func}=${value}`;
}

/**
 * Encode a GET request (value `?`).
 *
 * @param subunit the target subunit
 * @param func the function name
 * @returns the wire line, e.g. `@SYS:MODELNAME=?`
 */
export function encodeGet(subunit: string, func: string): string {
  return encodeCommand(subunit, func, "?");
}

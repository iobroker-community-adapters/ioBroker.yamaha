import { decodeLine } from "./protocol";

/** A device's YNCA capabilities: model plus each subunit's functions and their init-sweep values. */
export interface YncaCapabilities {
  /** Model name from SYS:MODELNAME, or "" if the sweep did not report it. */
  model: string;
  /** subunit (MAIN, ZONE2, TUN, …) → function name → value seen in the init sweep. */
  subunits: Record<string, Record<string, string>>;
}

/** A decoded subunit/function/value message. */
export interface YncaFunctionValue {
  /** The subunit that reported (e.g. `MAIN`, `ZONE2`). */
  subunit: string;
  /** The function name (e.g. `PWR`, `VOL`). */
  func: string;
  /** The reported value. */
  value: string;
}

/**
 * Assemble a capability report from decoded messages: group by subunit and
 * function, take the model from SYS:MODELNAME.
 *
 * @param messages the decoded ok messages from the receiver
 * @returns the assembled capabilities
 */
export function buildCapabilities(messages: YncaFunctionValue[]): YncaCapabilities {
  const subunits: Record<string, Record<string, string>> = {};
  for (const message of messages) {
    (subunits[message.subunit] ??= {})[message.func] = message.value;
  }
  return { model: subunits.SYS?.MODELNAME ?? "", subunits };
}

/**
 * Build a capability report from the lines received during the init sweep. Only
 * `@SUBUNIT:FUNC=VALUE` responses count; `@UNDEFINED`/`@RESTRICTED` (absent
 * subunits/functions) are ignored.
 *
 * @param lines response lines received from the receiver
 * @returns the assembled capabilities
 */
export function parseCapabilities(lines: string[]): YncaCapabilities {
  const messages: YncaFunctionValue[] = [];
  for (const line of lines) {
    const response = decodeLine(line);
    if (response.status === "ok") {
      messages.push({ subunit: response.subunit, func: response.func, value: response.value });
    }
  }
  return buildCapabilities(messages);
}

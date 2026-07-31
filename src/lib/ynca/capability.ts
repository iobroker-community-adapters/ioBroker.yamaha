import { decodeLine } from "./protocol";

/** A device's YNCA capabilities: model plus each subunit's functions and their init-sweep values. */
export interface YncaCapabilities {
  /** Model name from SYS:MODELNAME, or "" if the sweep did not report it. */
  model: string;
  /** subunit (MAIN, ZONE2, TUN, …) → function name → value seen in the init sweep. */
  subunits: Record<string, Record<string, string>>;
}

/**
 * Build a capability report from the lines received during the init sweep. Only
 * `@SUBUNIT:FUNC=VALUE` responses count; `@UNDEFINED`/`@RESTRICTED` (absent
 * subunits/functions) are ignored. The model comes from SYS:MODELNAME.
 *
 * @param lines response lines received from the receiver
 * @returns the assembled capabilities
 */
export function parseCapabilities(lines: string[]): YncaCapabilities {
  const subunits: Record<string, Record<string, string>> = {};
  for (const line of lines) {
    const response = decodeLine(line);
    if (response.status !== "ok") {
      continue;
    }
    (subunits[response.subunit] ??= {})[response.func] = response.value;
  }
  return { model: subunits.SYS?.MODELNAME ?? "", subunits };
}

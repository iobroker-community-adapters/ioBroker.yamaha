import type { YncaMessage } from "./protocol";

/** A device's YNCA capabilities: model plus each subunit's functions and their init-sweep values. */
export interface YncaCapabilities {
  /** Model name from SYS:MODELNAME, or "" if the sweep did not report it. */
  model: string;
  /** subunit (MAIN, ZONE2, TUN, …) → function name → value seen in the init sweep. */
  subunits: Record<string, Record<string, string>>;
}

/**
 * Assemble a capability report from decoded messages: group by subunit and
 * function, take the model from SYS:MODELNAME.
 *
 * @param messages the decoded ok messages from the receiver
 * @returns the assembled capabilities
 */
export function buildCapabilities(messages: YncaMessage[]): YncaCapabilities {
  const subunits: Record<string, Record<string, string>> = {};
  for (const message of messages) {
    (subunits[message.subunit] ??= {})[message.func] = message.value;
  }
  return { model: subunits.SYS?.MODELNAME ?? "", subunits };
}

/**
 * Union-merge two capability maps of the SAME device identity: every function either
 * side ever reported, fresh values winning. A standby sweep answers many functions
 * with the unattributable `@RESTRICTED`, so REPLACING the stored shape with it would
 * strip abilities the device proved while awake — and a first capture in standby
 * would stay lean forever, because the identity-matched cache never re-sweeps.
 * Only call this for a matching identity; an identity change drops the memory instead.
 *
 * @param remembered the persisted subunit→function map
 * @param fresh the just-swept subunit→function map
 * @returns the union, fresh values overriding remembered ones
 */
export function mergeYncaSubunits(
  remembered: Record<string, Record<string, string>>,
  fresh: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {};
  for (const [subunit, funcs] of Object.entries(remembered)) {
    merged[subunit] = { ...funcs };
  }
  for (const [subunit, funcs] of Object.entries(fresh)) {
    merged[subunit] = { ...merged[subunit], ...funcs };
  }
  return merged;
}

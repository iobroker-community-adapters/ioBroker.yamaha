import type { Transport } from "../catalog/owner-policy";

/** Every transport, in the order the profile writes them. */
const TRANSPORTS: readonly Transport[] = ["yxc", "ynca", "xml"];

/**
 * What the adapter learned about ONE receiver's object tree. A receiver does not change what it can over
 * its life — only a firmware update or a new adapter version can — so who serves a datapoint is decided
 * once, kept in the device's capability profile, and read back on every start and every reconnect instead
 * of being computed again from whichever transports happen to answer (krobi 2026-10-02: "we do know what
 * the device can do").
 *
 * Only the datapoints more than one transport serves are listed: a datapoint one transport alone builds has
 * no choice to remember, and the profile stays far below its size limit (a few hundred entries instead of
 * every object of the device three times over).
 */
export interface LearnedTree {
  /**
   * Canonical datapoint id → the transports that serve it, the OWNER first, then the others in the order a
   * write falls back to them.
   */
  shared: Record<string, Transport[]>;
  /** The transports this receiver answered on when it was read in. */
  transports: Transport[];
  /**
   * The adapter version whose read-in COMPLETED for this device — with the receiver switched on and every
   * transport it has answering. Undefined while the read-in is open: after an installation, an adapter
   * update, or a firmware update. Only that completion may shrink the tree.
   */
  settledVersion?: string;
  /** The firmware each transport reported when it was read in — a different one opens the read-in again. */
  firmware: Partial<Record<Transport, string>>;
}

/**
 * A tree that knows nothing yet.
 *
 * @returns an empty learned tree
 */
export function emptyLearnedTree(): LearnedTree {
  return { shared: {}, transports: [], firmware: {} };
}

/**
 * Read a stored tree back (untrusted storage): every field checked, anything unknown dropped.
 *
 * @param raw the stored value
 * @returns the tree, empty when nothing usable was stored
 */
export function parseLearnedTree(raw: unknown): LearnedTree {
  const tree = emptyLearnedTree();
  if (!isPlain(raw)) {
    return tree;
  }
  if (isPlain(raw.shared)) {
    for (const [id, serving] of Object.entries(raw.shared)) {
      const transports = Array.isArray(serving) ? serving.filter(isTransport) : [];
      if (transports.length > 0) {
        tree.shared[id] = [...new Set(transports)];
      }
    }
  }
  if (Array.isArray(raw.transports)) {
    tree.transports = [...new Set(raw.transports.filter(isTransport))];
  }
  if (typeof raw.settledVersion === "string") {
    tree.settledVersion = raw.settledVersion;
  }
  if (isPlain(raw.firmware)) {
    for (const transport of TRANSPORTS) {
      const firmware = raw.firmware[transport];
      if (typeof firmware === "string" && firmware.length > 0) {
        tree.firmware[transport] = firmware;
      }
    }
  }
  return tree;
}

/**
 * Whether a tree carries anything at all — an empty one is not written into the profile.
 *
 * @param tree the tree
 * @returns true when it holds a shared datapoint, a transport, a settled version or a firmware
 */
export function hasLearned(tree: LearnedTree): boolean {
  return (
    Object.keys(tree.shared).length > 0 ||
    tree.transports.length > 0 ||
    tree.settledVersion !== undefined ||
    Object.keys(tree.firmware).length > 0
  );
}

function isTransport(value: unknown): value is Transport {
  return value === "yxc" || value === "ynca" || value === "xml";
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

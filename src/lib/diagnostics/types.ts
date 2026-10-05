import type { Transport } from "../catalog/owner-policy";
import type { LearnedTree } from "../lifecycle/learned-tree";

// The shapes a diagnostics read hands around — in a module of their own that imports nothing but types, so the
// controller contract (`controller.ts`) can name them without pulling the transports in (the type-level import
// cycle controller → multi-transport-handle → device-capture → … → controller, review 2026-10-05, X10).

/**
 * What the device answered when a diagnostics report read it — verbatim, in the shape of the
 * inventory fixtures (`test/fixtures/inventory/*.json`), so a user's report can become a fixture:
 * YNCA `SUBUNIT:FUNC` → value, MusicCast endpoint → JSON body, XML `Element/Node` → response body.
 */
export interface TransportCapture {
  /** Which protocol was read. */
  transport: Transport;
  /** When the read started (ISO time). */
  startedAt: string;
  /** How long it took. */
  durationMs: number;
  /**
   * Whether the read ran to its end without a transport failure: every question was put and got the
   * device's answer — a refusal (`response_code`, an HTTP status, `@UNDEFINED`) is an answer, a timeout or a
   * dropped connection is not. The same meaning on all three protocols (review 2026-10-05, B5).
   */
  complete: boolean;
  /** How many questions went to the device. */
  asked: number;
  /**
   * How many questions got no answer because the transport failed — what `complete: false` is about. YNCA:
   * the functions without a value of a read that did not reach its closing marker. Set by every capture.
   */
  failed?: number;
  /**
   * The answers, keyed like the inventory fixtures. MusicCast and XML keep a device's verdict in place of a
   * body (`{ response_code }`, `{ httpStatus }`) and a transport failure as `{ error }`.
   */
  answers: Record<string, unknown>;
  /** YNCA: every line the device sent while the read ran, in arrival order — refusals included. */
  lines?: string[];
  /** YNCA: functions asked that got no value (`@UNDEFINED`, write-only, or silent). */
  unanswered?: string[];
  /** XML: the device description (`desc.xml`), or null when the device has none. */
  descriptor?: string | null;
  /** The first transport failure, and whether it ended the read early — set whenever `complete` is false. */
  error?: string;
}

/** What a diagnostics report reads from a running device: who serves what, and what the device answered. */
export interface HandleCapture {
  /** The transports live right now. */
  live: Transport[];
  /** Transports the device answered before that are not connected now. */
  missing: Transport[];
  /** Canonical datapoint id → the transport that serves it. */
  owners: Record<string, Transport>;
  /** The learned tree as kept in the capability profile. */
  tree: LearnedTree;
  /** The raw reads, one per live transport that can be read. */
  captures: TransportCapture[];
}

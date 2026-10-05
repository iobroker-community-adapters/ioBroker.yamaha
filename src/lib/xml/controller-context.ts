import type { ControllerDepsBase } from "../controller";
import type { CommandPriority } from "../lifecycle/command-gate";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";
import type { XmlCommand } from "./command-mapper";
import type { BasicStatus, XmlDescriptor, XmlSystemConfig } from "./protocol";
import type { XmlZone } from "./zones";

/** The subset of the XML client the controller uses (so tests can inject a fake). */
export interface XmlClientLike {
  /** Read a zone's Basic_Status — at `user` priority for the read-back of a user's write. */
  getStatus(zone: string, priority?: CommandPriority): Promise<BasicStatus>;
  /** Read the device's declaration of itself (System > Config): model, identity, zones, sources, input names. */
  getSystemConfig(): Promise<XmlSystemConfig>;
  /** Read the raw device description (`desc.xml`); absent on older fakes → no description is read. */
  getDescriptor?(): Promise<string>;
  /** Send an inner command to a zone. */
  send(zone: string, inner: string): Promise<void>;
  /** Read an element's inner GET request and return the raw response body — at `user` priority for a read-back. */
  getXml(element: string, inner: string, priority?: CommandPriority): Promise<string>;
}

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface XmlControllerDeps extends ControllerDepsBase {
  /** The XML client for this device. */
  client: XmlClientLike;
  /** Schedule the keepalive poll; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** The device's address, for the cover a source reports as a path on the device (D3). */
  host?: string;
}

/**
 * What the parts of the XML controller (the tuner surface, the player blocks, the commands desc.xml declares)
 * share with it: the device, the deps, and the controller's own helpers — one connection, one object tree, one
 * write path. The parts were sections of one 1.8k-line class (review 2026-10-05, D).
 */
export interface XmlControllerContext {
  /** The id-safe device id (object-tree path segment). */
  readonly deviceId: string;
  /** The adapter callbacks and the client. */
  readonly deps: XmlControllerDeps;
  /**
   * Write a device-originated value — never after the connection closed.
   *
   * @param relativeId the state id relative to the device
   * @param value the value
   */
  emit(relativeId: string, value: boolean | number | string | null): void;
  /**
   * Create the channels an id still lacks above it, parents first, each once.
   *
   * @param id the state (or channel) id
   */
  ensureChannels(id: string): Promise<void>;
  /**
   * Read one element's answer once per device (or fresh on every connection), remembering only a definite one.
   *
   * @param key the probe-memory key
   * @param element the XML element to ask
   * @param inner the inner GET request
   * @param fresh ask again on every connection (a name the user can change), the memory only the fallback
   * @returns the raw response body, or "" when the device (definitely or for now) has none
   */
  probeXml(key: string, element: string, inner: string, fresh?: boolean): Promise<string>;
  /**
   * Send a command and read what it touched back at once.
   *
   * @param command the element and the inner XML to send
   * @param readBack reads what the command touched
   * @returns what became of the command
   */
  applyCommand(command: XmlCommand, readBack?: () => Promise<unknown>): Promise<WriteOutcome>;
  /**
   * Drop a write that cannot go out, with the trace every dropped write leaves: one debug line naming the device,
   * the datapoint, the value and why (#615: a dead button leaves a trace; review 2026-10-05, A56).
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @param reason why it is not sent
   * @returns `unavailable` — this transport could not send it, so the handle may try the next one (Y-04)
   */
  dropWrite(stateId: string, value: unknown, reason: string): WriteOutcome;
  /**
   * Record a state as created, and as read-only where it is not writable (the claim-with-proof gate of the
   * write path).
   *
   * @param stateId the state id
   * @param write whether it is writable
   */
  markWritable(stateId: string, write?: boolean): void;
  /** @returns the device description read on this connection (empty lists where the device declares none) */
  descriptor(): XmlDescriptor;
  /**
   * Whether the device description declares a write command for an element.
   *
   * @param element the element (`Main_Zone`, `System`)
   * @param path the command path after it
   * @returns true when declared
   */
  declares(element: string, path: string): boolean;
  /** @returns whether the device description declares a command list at all (2008–2017; the 2020 generation has none) */
  hasCommandList(): boolean;
  /**
   * Read a zone's status back and write its states.
   *
   * @param zone the zone
   * @param priority the gate priority — `user` for the read-back of a user's write
   * @returns true when the zone answered
   */
  refreshZone(zone: XmlZone, priority?: CommandPriority): Promise<boolean>;
  /**
   * Read what every zone's media source plays (the player blocks).
   *
   * @param priority the gate priority — `user` for the read-back of a user's write
   */
  refreshPlayers(priority?: CommandPriority): Promise<void>;
}

/**
 * One way a user write can take: the ids it serves, and what it makes of a write. The controller asks its routes in
 * order and the first that serves the id takes the write — instead of a chain of boolean handlers (review
 * 2026-10-05, F). Every route answers with a deliberate outcome: a forgotten `undefined` reads as "unclear" in the
 * handle, which then never tries the next protocol (Y-04; review 2026-10-05, A3).
 */
export interface XmlWriteRoute {
  /**
   * Whether this route takes the write.
   *
   * @param stateId the state id relative to the device
   * @returns true when it does
   */
  serves(stateId: string): boolean;
  /**
   * Take the write.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns what became of it
   */
  write(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome;
}

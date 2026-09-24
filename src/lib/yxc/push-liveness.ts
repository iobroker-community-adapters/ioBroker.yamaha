/**
 * Whether a device's MusicCast events actually arrive.
 *
 * "Push active" used to mean only that the shared UDP socket is bound. The device sends its events
 * to the address that registered last, so a second MusicCast client on the same host (Home
 * Assistant, the old musiccast adapter — in a Docker bridge network every container carries the
 * host's address) takes them away while our socket keeps listening; a UDP packet can also simply
 * be lost (YXC Advanced §9.2). With push believed working, a write was never read back and the
 * keepalive swept media, lists and groups only every 30 minutes (audit 2026-09-24, C1).
 *
 * The judgement rests on changes the device made without telling: a written value that the
 * read-back shows changed while no event came, or a keepalive that finds the main zone's
 * power/input/volume/mute changed with no event since the previous one — exactly the fields every
 * main-zone event carries (YXC Basic Rev 1.00 §10.3). A resting device produces neither, so it is
 * never judged. Held per device by the adapter, so the verdict survives a reconnect.
 */

/** Two changes in a row that no event announced: the events are not arriving. */
export const PUSH_MISSES_TO_DEAD = 2;

/** What is known about a device's events. */
export type PushLivenessState = "unknown" | "alive" | "dead";

/** The event verdict of one device (see the module comment). */
export class PushLiveness {
  private current: PushLivenessState = "unknown";
  private misses = 0;

  /** The current verdict. */
  public get state(): PushLivenessState {
    return this.current;
  }

  /**
   * An event of this device arrived.
   *
   * @returns true when this ends a "dead" verdict (the caller says so once)
   */
  public noteEvent(): boolean {
    const revived = this.current === "dead";
    this.current = "alive";
    this.misses = 0;
    return revived;
  }

  /**
   * The device changed a value and no event announced it.
   *
   * @returns true when this is the miss that makes the verdict "dead" (the caller says so once)
   */
  public noteMiss(): boolean {
    if (this.current === "dead") {
      return false;
    }
    this.misses++;
    if (this.misses < PUSH_MISSES_TO_DEAD) {
      return false;
    }
    this.current = "dead";
    return true;
  }
}

import type { YamahaYxcClient } from "./http-client";

/**
 * The YXC (MusicCast) client surface the adapter drives — DERIVED from the client class
 * instead of typed out a second time.
 *
 * It used to be a hand-written interface of fifty method signatures. That was measured and
 * found to be a full copy, not the intended subset: every one of those methods is really
 * called, and the class had exactly one more. So the interface carried no information the
 * class did not already have — it only had to be kept in step with it by hand, and it forced
 * every test double to spell all fifty methods out again. No other adapter in the fleet
 * types its client twice (nut2 uses its client class directly).
 *
 * The mapped type keeps what the interface was actually good for: it is the PUBLIC surface
 * only (private members are not part of `keyof`) and it is structural, so a test double can
 * satisfy it without extending the class — which a plain `= YamahaYxcClient` would not allow,
 * because a class with private fields is compared nominally.
 */
export type YxcClientLike = { [K in keyof YamahaYxcClient]: YamahaYxcClient[K] };

/**
 * The version of the adapter's DISCOVERY LOGIC — how it turns device answers into objects,
 * dropdowns and bounds. Persisted with every per-device memory (`native.probeCache`,
 * `native.yncaAvail`); a memory learned under another schema is discarded on load, so the
 * device is re-learned on its next connect with the current logic (cold path, ≤ 32 s over
 * YNCA, objects correct in the same start). A memory without the field is schema 0 — every
 * installation before 2.6.0 — and is re-learned once by the first release that carries this.
 *
 * Bump it when a release changes what discovery PRODUCES (a new declaration source, a changed
 * candidate list, a new derivation rule); leave it alone when only values, logging or the wire
 * paths change. `discovery-schema.test.ts` holds the object inventory's shape against it in both
 * directions — output changed on a released schema without a bump fails, a bump without a change
 * fails — with the stamp `test/discovery-schema.json`. (2.6.0: the adapter-VERSION trigger was
 * rejected in the advisor round — every patch release would re-sweep every device for a result
 * the schema bump already guarantees when discovery really changed. Since 2.7.0 a transport can
 * ask for a re-coordination within the session, so a late object does materialise — but that is
 * ADDITIVE; a changed discovery LOGIC still needs the cold re-learn this constant triggers.)
 */
export const DISCOVERY_SCHEMA = 1;

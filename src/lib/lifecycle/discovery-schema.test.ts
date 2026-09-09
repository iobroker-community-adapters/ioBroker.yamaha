import { createHash } from "node:crypto";
import inventory from "../../../test/objects.inventory.json";
import stamp from "../../../test/discovery-schema.json";
import pkg from "../../../package.json";
import { DISCOVERY_SCHEMA } from "./discovery-schema";

/** One inventory object, reduced to what discovery DECIDES about it. */
interface InventoryObject {
  type?: string;
  common?: { states?: unknown; min?: unknown; max?: unknown; step?: unknown };
}

/**
 * The shape of the discovery output: which state objects exist, which values they offer and
 * which bounds they carry — NOT their values, names or descriptions. Hashed over the committed
 * object inventory (`npm run test:inventory`, eight fixture devices over every transport
 * combination), sorted by id in code-point order so a Python or shell re-computation agrees.
 *
 * @param objects the object inventory
 * @returns the sha256 of the shape rows
 */
function shapeHash(objects: Record<string, InventoryObject>): string {
  const rows = Object.entries(objects)
    .filter(([, object]) => object.type === "state")
    .map(([id, object]) => [
      id,
      object.common?.states && typeof object.common.states === "object"
        ? Object.keys(object.common.states).sort()
        : null,
      object.common?.min ?? null,
      object.common?.max ?? null,
      object.common?.step ?? null,
    ])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/**
 * Semver order of two `major.minor.patch` versions.
 *
 * @param a the first version
 * @param b the second version
 * @returns negative when a < b, 0 when equal, positive when a > b
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
  }
  return 0;
}

/**
 * The rot guard: `DISCOVERY_SCHEMA` must change exactly when the discovery OUTPUT changes on a
 * released schema. The stamp `test/discovery-schema.json` records the schema, the version it
 * first ships with (`since`), the shape it was stamped on and the shape of the schema before it.
 *
 * - shape changed, schema already released (`since` ≤ package.json version) → bump the constant
 *   and rewrite the stamp (printed below);
 * - shape changed, schema not yet released → only the stamp's hash follows (no second bump within
 *   one release);
 * - shape equal to the previous schema's shape → a bump without a change is not a cache-buster;
 * - the stamp and the constant always agree.
 *
 * Blind spot, deliberately: it sees only what the eight fixtures exercise — a rule no fixture
 * reaches changes nothing here. The inventory itself is judged by the release chain (D08).
 */
test("the discovery schema changes exactly when the discovery output of a released schema changes", () => {
  const hash = shapeHash(inventory as Record<string, InventoryObject>);
  const released = compareVersions(stamp.since, pkg.version) <= 0;
  const bumped = JSON.stringify(
    { schema: DISCOVERY_SCHEMA + 1, since: "<next version>", shapeHash: hash, previousShapeHash: stamp.shapeHash },
    null,
    2,
  );
  const refreshed = JSON.stringify({ ...stamp, schema: DISCOVERY_SCHEMA, shapeHash: hash }, null, 2);
  if (stamp.schema !== DISCOVERY_SCHEMA) {
    throw new Error(
      `DISCOVERY_SCHEMA is ${DISCOVERY_SCHEMA} but test/discovery-schema.json says ${stamp.schema} — write the stamp as:\n${refreshed}`,
    );
  }
  if (hash !== stamp.shapeHash && released) {
    throw new Error(
      `the object inventory's shape changed (ids, dropdowns or bounds) but DISCOVERY_SCHEMA ${DISCOVERY_SCHEMA} already shipped with ${stamp.since} — bump it so existing installations re-learn their devices, then write test/discovery-schema.json as:\n${bumped}`,
    );
  }
  if (hash !== stamp.shapeHash) {
    throw new Error(
      `the object inventory's shape changed under the unreleased DISCOVERY_SCHEMA ${DISCOVERY_SCHEMA} — write test/discovery-schema.json as:\n${refreshed}`,
    );
  }
  if (hash === stamp.previousShapeHash) {
    throw new Error(
      `DISCOVERY_SCHEMA was bumped to ${DISCOVERY_SCHEMA} but the inventory's shape equals the previous schema's — a bump is not a cache-buster; revert it or change what discovery produces`,
    );
  }
  expect(stamp.shapeHash).toBe(hash);
});

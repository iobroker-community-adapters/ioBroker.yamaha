import { createSubunitCache, isAvailSnapshot } from "./subunit-cache";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";

describe("the YNCA subunit snapshot carries the discovery schema (2.6.0)", () => {
  test("a snapshot without a schema, or of another schema, is not a usable snapshot", () => {
    expect(isAvailSnapshot({ subunits: ["MAIN"], model: "RX-V6A", firmware: "1.80" })).toBe(false);
    expect(
      isAvailSnapshot({ schema: DISCOVERY_SCHEMA + 1, subunits: ["MAIN"], model: "RX-V6A", firmware: "1.80" }),
    ).toBe(false);
    expect(isAvailSnapshot({ schema: DISCOVERY_SCHEMA, subunits: ["MAIN"], model: "RX-V6A", firmware: "1.80" })).toBe(
      true,
    );
  });

  test("a fresh probe result is stamped with the current schema when stored", () => {
    const persisted: unknown[] = [];
    const cache = createSubunitCache(undefined, snapshot => persisted.push(snapshot));
    cache.set({ subunits: ["MAIN", "ZONE2"], model: "RX-A4A", firmware: "2.10" });
    expect(cache.get()).toEqual({
      schema: DISCOVERY_SCHEMA,
      subunits: ["MAIN", "ZONE2"],
      model: "RX-A4A",
      firmware: "2.10",
    });
    expect(persisted).toEqual([cache.get()]);
  });
});

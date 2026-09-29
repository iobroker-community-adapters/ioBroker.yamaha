import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PerDeviceCaches } from "./per-device";

describe("PerDeviceCaches (audit 2026-09-29, A28)", () => {
  test("forget drops the device from every device-keyed and every state-keyed collection", () => {
    const caches = new PerDeviceCaches();
    const records = caches.map<number>();
    const ready = caches.set();
    const bounds = caches.stateMap<number>();
    const known = caches.stateSet();
    records.set("living", 1).set("kitchen", 2);
    ready.add("living").add("kitchen");
    bounds.set("living.volume", 1).set("living2.volume", 2).set("kitchen.volume", 3);
    known.add("living.power").add("kitchen.power");
    caches.forget("living");
    expect([...records.keys()]).toEqual(["kitchen"]);
    expect([...ready]).toEqual(["kitchen"]);
    // `living2` is another device — the prefix is the id and its dot.
    expect([...bounds.keys()]).toEqual(["living2.volume", "kitchen.volume"]);
    expect([...known]).toEqual(["kitchen.power"]);
  });

  // Deleting a device once cleared four of thirteen collections by hand; the pending device-object
  // patch then recreated the deleted device as a bare orphan. A collection kept per device is made
  // through the register, so the delete forgets it without a hand-kept list.
  test("the adapter keeps no loose collection beside the register", () => {
    const source = readFileSync(join(__dirname, "../../main.ts"), "utf8");
    const loose = [...source.matchAll(/private (?:readonly )?(\w+) = new (?:Map|Set)</g)].map(match => match[1]);
    // Not per device: addresses (cleared with the record), the ids deleted this session (must
    // outlive the delete), the search warnings, the NOTIFY throttle (per address), and the searches
    // and description fetches in flight (ended on unload).
    expect(loose.sort()).toEqual([
      "fetchesInFlight",
      "knownDeviceIps",
      "notifyProbed",
      "removed",
      "searchesInFlight",
      "warnedSearch",
    ]);
  });
});

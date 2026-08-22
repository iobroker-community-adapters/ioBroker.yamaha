import { YXC_AMP_CATALOG } from "./catalog";

/**
 * Table test over the whole YXC catalog. Every entry with a `write.apply` is a
 * writable datapoint in the user's tree; the lambda calls the client directly, so
 * a wrong method or a missing zone argument is a button that does nothing (or
 * changes the wrong zone). Driving the list itself covers new entries as they land.
 */
describe("YXC_AMP_CATALOG", () => {
  /** A client that records the method name and arguments instead of talking HTTP. */
  function recordingClient(): { calls: Array<{ method: string; args: unknown[] }>; client: never } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const client = new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (method === "then") {
            return undefined;
          }
          return (...args: unknown[]) => {
            calls.push({ method, args });
            return Promise.resolve({ response_code: 0 });
          };
        },
      },
    );
    return { calls, client: client as never };
  }

  const writable = YXC_AMP_CATALOG.filter(e => e.write);

  /**
   * The writable entries the CONTROLLER sends, not the catalog: they need state the
   * catalog does not have (the device sets all three equalizer bands together, and a
   * frequency write needs the current band). Anything else that is writable in the
   * object tree but carries no `write.apply` is a datapoint the user can change and
   * that never reaches the device.
   */
  const CONTROLLER_OWNED = ["sound.equalizerLow", "sound.equalizerMid", "sound.equalizerHigh"];

  it("offers a write mapping for every writable entry the controller does not own", () => {
    for (const entry of YXC_AMP_CATALOG) {
      const expected = entry.common.write === true && !CONTROLLER_OWNED.includes(entry.state);
      expect(Boolean(entry.write), `${entry.state} write/apply mismatch`).toBe(expected);
    }
    for (const state of CONTROLLER_OWNED) {
      const entry = YXC_AMP_CATALOG.find(e => e.state === state);
      expect(entry, `${state} vanished from the catalog`).toBeDefined();
      expect(entry?.common.write, state).toBe(true);
    }
    expect(writable.length).toBeGreaterThan(5);
  });

  it("sends every writable entry to the device, addressed to the written zone", async () => {
    for (const entry of writable) {
      const { calls, client } = recordingClient();
      const sample = entry.common.type === "boolean" ? true : entry.common.type === "number" ? 5 : "straight";
      await entry.write!.apply(client, sample, "zone2");
      expect(calls, `${entry.state} sent nothing`).toHaveLength(1);
      // Dropping the zone makes every write land in the main zone — the classic
      // "zone 2 volume changes the living room" bug.
      const carriesZone = calls[0].args.includes("zone2");
      const zoneless = ["multiroom.party", "multiroom.partyEnable"];
      expect(carriesZone || zoneless.some(z => entry.state.startsWith(z)), `${entry.state} lost its zone`).toBe(true);
    }
  });

  it("reads every entry back from a status field or path", () => {
    for (const entry of YXC_AMP_CATALOG) {
      const read = entry.read as { field?: string; path?: string[] };
      expect(Boolean(read.field) || (read.path?.length ?? 0) > 0, `${entry.state} has no read source`).toBe(true);
      // fromStatus must coerce, not pass through: an undefined reaching a boolean
      // state makes js-controller reject the write.
      const coerced = entry.fromStatus(undefined);
      expect(["boolean", "number", "string"], entry.state).toContain(typeof coerced);
    }
  });

  it("keeps every state id unique", () => {
    const ids = YXC_AMP_CATALOG.map(e => e.state);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

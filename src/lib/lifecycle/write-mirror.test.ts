import { carries, merged, ObjectMirror, StateMirror } from "./write-mirror";

describe("carries — would extendObject change nothing (audit 2026-09-29, E2)", () => {
  test("a patch whose fields all sit in the stored object changes nothing", () => {
    const stored = { type: "state", common: { name: { en: "Volume", de: "Lautstärke" }, role: "level", min: 0 } };
    expect(carries(stored, { common: { name: { en: "Volume", de: "Lautstärke" } } })).toBe(true);
    expect(carries(stored, { type: "state", common: { role: "level" } })).toBe(true);
  });

  test("a field that differs, is missing, or is nulled is a change", () => {
    const stored = { common: { role: "level", states: { a: "A" } } };
    expect(carries(stored, { common: { role: "level.volume" } })).toBe(false);
    expect(carries(stored, { common: { unit: "dB" } })).toBe(false);
    expect(carries(stored, { common: { states: null } })).toBe(false);
    expect(carries(undefined, { common: {} })).toBe(false);
  });

  test("undefined in a patch is skipped, like jQuery's extend does", () => {
    expect(carries({ common: { role: "level" } }, { common: { role: "level", unit: undefined } })).toBe(true);
  });

  test("arrays are compared index by index — extend merges them that way", () => {
    expect(carries({ list: [1, 2, 3] }, { list: [1, 2] })).toBe(true);
    expect(carries({ list: [1, 2] }, { list: [1, 3] })).toBe(false);
  });
});

describe("merged — what extendObject leaves in the database", () => {
  test("merges deeply, keeps what the patch does not name, copies null", () => {
    const stored = { common: { name: "Old", states: { a: "A" }, min: 0 }, native: { x: 1 } };
    expect(merged(stored, { common: { name: "New", states: { b: "B" }, min: null } })).toEqual({
      common: { name: "New", states: { a: "A", b: "B" }, min: null },
      native: { x: 1 },
    });
    // The input stays as it was.
    expect(stored.common.name).toBe("Old");
  });

  test("a map written over null replaces it", () => {
    expect(merged({ common: { states: null } }, { common: { states: { a: "A" } } })).toEqual({
      common: { states: { a: "A" } },
    });
  });
});

describe("ObjectMirror", () => {
  test("seeded from a listing, it knows what is stored and what a write added", () => {
    const mirror = new ObjectMirror();
    mirror.seed({ "yamaha.0.dev.power": { type: "state", common: { role: "switch", write: true } } }, "yamaha.0");
    expect(mirror.carries("dev.power", { common: { role: "switch" } })).toBe(true);
    expect(mirror.carries("dev.power", { common: { role: "switch.power" } })).toBe(false);
    mirror.wrote("dev.power", { common: { role: "switch.power" } });
    expect(mirror.carries("dev.power", { common: { role: "switch.power" } })).toBe(true);
  });

  test("an unknown object is always written", () => {
    expect(new ObjectMirror().carries("dev.new", {})).toBe(false);
  });

  test("a deleted object is forgotten — with its children on a recursive delete", () => {
    const mirror = new ObjectMirror();
    mirror.seed(
      { "yamaha.0.dev": { type: "device", common: {} }, "yamaha.0.dev.power": { type: "state", common: {} } },
      "yamaha.0",
    );
    mirror.deleted("dev", true);
    expect(mirror.carries("dev", {})).toBe(false);
    expect(mirror.carries("dev.power", {})).toBe(false);
  });

  test("tells a read-only state from a writable one", () => {
    const mirror = new ObjectMirror();
    mirror.seed(
      {
        "yamaha.0.dev.info.model": { type: "state", common: { write: false } },
        "yamaha.0.dev.power": { type: "state", common: { write: true } },
      },
      "yamaha.0",
    );
    expect(mirror.isReadOnlyState("dev.info.model")).toBe(true);
    expect(mirror.isReadOnlyState("dev.power")).toBe(false);
    expect(mirror.isReadOnlyState("dev.unknown")).toBe(false);
  });
});

describe("StateMirror (audit 2026-09-29, E3)", () => {
  test("nothing mirrored yet is unknown — the database decides once", () => {
    expect(new StateMirror().judge("dev.info.model", "RX-V6A", true)).toBe("unknown");
  });

  test("the same value and ack is unchanged; another value or ack is a change", () => {
    const mirror = new StateMirror();
    mirror.seed({ "yamaha.0.dev.info.model": { val: "RX-V6A", ack: true } }, "yamaha.0");
    expect(mirror.judge("dev.info.model", "RX-V6A", true)).toBe("unchanged");
    expect(mirror.judge("dev.info.model", "RX-A2A", true)).toBe("changed");
    mirror.holds("dev.info.model", "RX-V6A", false);
    expect(mirror.judge("dev.info.model", "RX-V6A", true)).toBe("changed");
  });

  test("after the bulk read, a state it did not return has no value — its first write is a change", () => {
    const mirror = new StateMirror();
    mirror.seed({ "yamaha.0.dev.info.model": { val: "RX-V6A", ack: true } }, "yamaha.0");
    expect(mirror.judge("dev.player.netPlayer.playError", 0, true)).toBe("changed");
  });

  test("an object value never counts as unchanged", () => {
    const mirror = new StateMirror();
    mirror.holds("dev.x", { a: 1 }, true);
    expect(mirror.judge("dev.x", { a: 1 }, true)).toBe("unknown");
  });

  test("a deleted state is forgotten", () => {
    const mirror = new StateMirror();
    mirror.holds("dev.power", true, true);
    mirror.deleted("dev", true);
    expect(mirror.judge("dev.power", true, true)).toBe("unknown");
  });
});

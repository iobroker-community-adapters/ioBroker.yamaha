import { StateMirror } from "./write-mirror";

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

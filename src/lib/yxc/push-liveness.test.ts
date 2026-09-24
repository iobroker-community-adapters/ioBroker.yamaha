import { PushLiveness, PUSH_MISSES_TO_DEAD } from "./push-liveness";

describe("PushLiveness", () => {
  test("starts unknown; an event makes it alive", () => {
    const liveness = new PushLiveness();
    expect(liveness.state).toBe("unknown");
    expect(liveness.noteEvent()).toBe(false);
    expect(liveness.state).toBe("alive");
  });

  test("two misses in a row make it dead — reported once", () => {
    const liveness = new PushLiveness();
    expect(PUSH_MISSES_TO_DEAD).toBe(2);
    expect(liveness.noteMiss()).toBe(false);
    expect(liveness.state).toBe("unknown");
    expect(liveness.noteMiss()).toBe(true);
    expect(liveness.state).toBe("dead");
    expect(liveness.noteMiss()).toBe(false);
  });

  test("an event between two misses resets the count; an event after dead revives it once", () => {
    const liveness = new PushLiveness();
    liveness.noteMiss();
    liveness.noteEvent();
    expect(liveness.noteMiss()).toBe(false);
    expect(liveness.state).toBe("alive");
    liveness.noteMiss();
    expect(liveness.state).toBe("dead");
    expect(liveness.noteEvent()).toBe(true);
    expect(liveness.noteEvent()).toBe(false);
    expect(liveness.state).toBe("alive");
  });
});

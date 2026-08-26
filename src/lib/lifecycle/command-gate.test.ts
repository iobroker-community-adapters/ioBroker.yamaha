import { CommandGate, CommandGateClosedError } from "./command-gate";

/** A controllable clock + timer pair, so pacing is asserted deterministically. */
function fakeTimers(): {
  timers: { schedule(handler: () => void, ms: number): unknown; cancel(handle: unknown): void };
  now: () => number;
  advance(ms: number): void;
  pending(): number;
} {
  let clock = 0;
  let seq = 0;
  const scheduled = new Map<number, { at: number; handler: () => void }>();
  return {
    timers: {
      schedule(handler, ms) {
        const id = ++seq;
        scheduled.set(id, { at: clock + ms, handler });
        return id;
      },
      cancel(handle) {
        scheduled.delete(handle as number);
      },
    },
    now: () => clock,
    advance(ms) {
      clock += ms;
      for (const [id, entry] of [...scheduled]) {
        if (entry.at <= clock) {
          scheduled.delete(id);
          entry.handler();
        }
      }
    },
    pending: () => scheduled.size,
  };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe("CommandGate", () => {
  test("serialises: a second operation starts only after the first finished", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const first = gate.run(async () => {
      order.push("first-start");
      await new Promise<void>(resolve => (releaseFirst = resolve));
      order.push("first-end");
    });
    const second = gate.run(() => {
      order.push("second-start");
    });
    await flush();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("keeps the required spacing between two commands", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 100, timers: t.timers, now: t.now });
    const starts: number[] = [];
    const a = gate.run(() => void starts.push(t.now()));
    const b = gate.run(() => void starts.push(t.now()));
    await flush();
    // The first runs immediately, the second must wait out the spacing.
    expect(starts).toEqual([0]);
    t.advance(99);
    await flush();
    expect(starts).toEqual([0]);
    t.advance(1);
    await flush();
    expect(starts).toEqual([0, 100]);
    await Promise.all([a, b]);
  });

  test("a user command jumps ahead of queued background work", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    const order: string[] = [];
    let release: () => void = () => {};
    const blocking = gate.run(async () => {
      await new Promise<void>(resolve => (release = resolve));
    });
    const bg1 = gate.run(() => void order.push("bg1"));
    const bg2 = gate.run(() => void order.push("bg2"));
    const user = gate.run(() => void order.push("user"), "user");
    release();
    await Promise.all([blocking, bg1, bg2, user]);
    expect(order).toEqual(["user", "bg1", "bg2"]);
  });

  test("user commands keep their own order among themselves", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    const order: string[] = [];
    let release: () => void = () => {};
    const blocking = gate.run(async () => {
      await new Promise<void>(resolve => (release = resolve));
    });
    const bg = gate.run(() => void order.push("bg"));
    const u1 = gate.run(() => void order.push("u1"), "user");
    const u2 = gate.run(() => void order.push("u2"), "user");
    release();
    await Promise.all([blocking, bg, u1, u2]);
    expect(order).toEqual(["u1", "u2", "bg"]);
  });

  test("close rejects everything queued and refuses new work", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    let release: () => void = () => {};
    const blocking = gate.run(async () => {
      await new Promise<void>(resolve => (release = resolve));
    });
    let ran = false;
    const queued = gate.run(() => {
      ran = true;
    });
    gate.close();
    await expect(queued).rejects.toBeInstanceOf(CommandGateClosedError);
    expect(ran).toBe(false);
    await expect(gate.run(() => 1)).rejects.toBeInstanceOf(CommandGateClosedError);
    release();
    await blocking;
  });

  test("close aborts the signal, so callers can stop writing", () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    expect(gate.signal.aborted).toBe(false);
    expect(gate.closed).toBe(false);
    gate.close();
    expect(gate.signal.aborted).toBe(true);
    expect(gate.closed).toBe(true);
  });

  test("delay resolves early on close and leaves no timer behind", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    let done = false;
    const waiting = gate.delay(5000).then(() => {
      done = true;
    });
    expect(t.pending()).toBe(1);
    gate.close();
    await waiting;
    expect(done).toBe(true);
    // The cancelled timer must not linger — a stopped adapter leaves nothing armed.
    expect(t.pending()).toBe(0);
  });

  test("an operation that throws releases the gate for the next one", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    const failing = gate.run(() => {
      throw new Error("device said no");
    });
    await expect(failing).rejects.toThrow("device said no");
    await expect(gate.run(() => "next")).resolves.toBe("next");
  });

  test("passes the operation's result through", async () => {
    const t = fakeTimers();
    const gate = new CommandGate({ minSpacingMs: 0, timers: t.timers, now: t.now });
    await expect(gate.run(async () => ({ ok: 1 }))).resolves.toEqual({ ok: 1 });
  });
});

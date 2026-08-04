import { DeviceSupervisor } from "./device-supervisor";

/** Flush pending microtasks + one macrotask turn so awaited attempts settle. */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };
const fastBackoff = (): { nextDelay: () => number; reset: () => void } => ({ nextDelay: () => 1, reset: () => {} });

describe("DeviceSupervisor", () => {
  test("retries a device that is offline at start until a transport connects", async () => {
    let attempts = 0;
    const scheduled: Array<() => void> = [];
    const connChanges: boolean[] = [];
    const supervisor = new DeviceSupervisor({
      attempt: async () => {
        attempts++;
        return attempts >= 3 ? { onDrop: () => {}, close: () => {} } : null;
      },
      schedule: cb => {
        scheduled.push(cb);
        return scheduled.length;
      },
      cancel: () => {},
      onConnectionChange: c => connChanges.push(c),
      backoff: fastBackoff(),
      log: silentLog,
    });

    supervisor.start();
    await tick(); // attempt 1 → null → schedules a retry
    expect(attempts).toBe(1);
    scheduled.shift()?.();
    await tick(); // attempt 2 → null → schedules a retry
    scheduled.shift()?.();
    await tick(); // attempt 3 → connected

    expect(attempts).toBe(3);
    expect(connChanges[connChanges.length - 1]).toBe(true);
  });

  test("reconnects after the connection drops, reporting the state change both ways", async () => {
    let attempts = 0;
    let dropCb: () => void = () => {};
    const scheduled: Array<() => void> = [];
    const connChanges: boolean[] = [];
    const supervisor = new DeviceSupervisor({
      attempt: async () => {
        attempts++;
        return { onDrop: cb => (dropCb = cb), close: () => {} };
      },
      schedule: cb => {
        scheduled.push(cb);
        return scheduled.length;
      },
      cancel: () => {},
      onConnectionChange: c => connChanges.push(c),
      backoff: fastBackoff(),
      log: silentLog,
    });

    supervisor.start();
    await tick(); // attempt 1 → connected
    expect(connChanges[connChanges.length - 1]).toBe(true);

    dropCb(); // the connection drops
    expect(connChanges[connChanges.length - 1]).toBe(false);

    scheduled.shift()?.();
    await tick(); // reconnect → attempt 2 (re-seeds by re-attempting)
    expect(attempts).toBe(2);
    expect(connChanges[connChanges.length - 1]).toBe(true);
  });

  test("close stops the loop — a later drop schedules no reconnect", async () => {
    let attempts = 0;
    let dropCb: () => void = () => {};
    const scheduled: Array<() => void> = [];
    const supervisor = new DeviceSupervisor({
      attempt: async () => {
        attempts++;
        return { onDrop: cb => (dropCb = cb), close: () => {} };
      },
      schedule: cb => {
        scheduled.push(cb);
        return scheduled.length;
      },
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: fastBackoff(),
      log: silentLog,
    });

    supervisor.start();
    await tick();
    supervisor.close();
    dropCb(); // drop after close

    expect(scheduled).toHaveLength(0);
    expect(attempts).toBe(1);
  });

  test("an attempt that throws is treated as not connected and retried", async () => {
    let attempts = 0;
    const scheduled: Array<() => void> = [];
    const supervisor = new DeviceSupervisor({
      attempt: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("boom");
        }
        return { onDrop: () => {}, close: () => {} };
      },
      schedule: cb => {
        scheduled.push(cb);
        return scheduled.length;
      },
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: fastBackoff(),
      log: silentLog,
    });

    supervisor.start();
    await tick(); // attempt 1 throws → retry scheduled
    expect(attempts).toBe(1);
    scheduled.shift()?.();
    await tick(); // attempt 2 → connected
    expect(attempts).toBe(2);
  });
});

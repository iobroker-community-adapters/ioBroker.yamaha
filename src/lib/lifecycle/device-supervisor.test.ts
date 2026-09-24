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
      attempt: () => {
        attempts++;
        return Promise.resolve(
          attempts >= 3 ? { onDrop: () => {}, handleStateChange: () => {}, close: () => {} } : null,
        );
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
    // Every attempt reports its result — the adapter's rediscovery timer is re-armed by each
    // false, and the write behind it is deduplicated by the database, not here.
    expect(connChanges).toEqual([false, false, true]);
  });

  test("settled() resolves only once the running attempt has finished", async () => {
    let finish: (h: null) => void = () => {};
    const supervisor = new DeviceSupervisor({
      attempt: () => new Promise<null>(resolve => (finish = resolve)),
      schedule: () => 1,
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: fastBackoff(),
      log: silentLog,
    });
    // Nothing running yet: nothing to wait for.
    await expect(supervisor.settled()).resolves.toBeUndefined();
    supervisor.start();
    let done = false;
    void supervisor.settled().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    supervisor.close();
    finish(null);
    await tick();
    expect(done).toBe(true);
    // Finished and closed: settled again resolves at once.
    await expect(supervisor.settled()).resolves.toBeUndefined();
  });

  test("reconnects after the connection drops, reporting the state change both ways", async () => {
    let attempts = 0;
    let dropCb: () => void = () => {};
    const scheduled: Array<() => void> = [];
    const connChanges: boolean[] = [];
    const supervisor = new DeviceSupervisor({
      attempt: () => {
        attempts++;
        return Promise.resolve({ onDrop: cb => (dropCb = cb), handleStateChange: () => {}, close: () => {} });
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
      attempt: () => {
        attempts++;
        return Promise.resolve({ onDrop: cb => (dropCb = cb), handleStateChange: () => {}, close: () => {} });
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

  test("closes the dropped connection and ignores a second drop from the same handle", async () => {
    let dropCb: (reason?: Error) => void = () => {};
    let closes = 0;
    const scheduled: Array<() => void> = [];
    const supervisor = new DeviceSupervisor({
      attempt: () =>
        Promise.resolve({ onDrop: cb => (dropCb = cb), handleStateChange: () => {}, close: () => closes++ }),
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
    await tick(); // connected
    dropCb(); // first drop: closes the handle, schedules one retry
    dropCb(); // second drop from the same (superseded) handle: ignored
    expect(closes).toBe(1);
    expect(scheduled).toHaveLength(1);
  });

  test("an attempt that throws is treated as not connected and retried", async () => {
    let attempts = 0;
    const scheduled: Array<() => void> = [];
    const supervisor = new DeviceSupervisor({
      attempt: () => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve({ onDrop: () => {}, handleStateChange: () => {}, close: () => {} });
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

  test("routes state changes to the active connection, dropping them while offline", async () => {
    const calls: Array<[string, boolean, unknown]> = [];
    const supervisor = new DeviceSupervisor({
      attempt: () =>
        Promise.resolve({
          onDrop: () => {},
          handleStateChange: (id, ack, val) => calls.push([id, ack, val]),
          close: () => {},
        }),
      schedule: () => 0,
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: fastBackoff(),
      log: silentLog,
    });

    supervisor.handleStateChange("dev.power", false, true); // offline → dropped
    expect(calls).toHaveLength(0);

    supervisor.start();
    await tick(); // connected
    supervisor.handleStateChange("dev.power", false, true);
    expect(calls).toEqual([["dev.power", false, true]]);
  });
});

describe("DeviceSupervisor closes what runs and names the device (audit 2026-09-24, A3/A16)", () => {
  test("close() aborts the attempt in flight", async () => {
    let seen: AbortSignal | undefined;
    const supervisor = new DeviceSupervisor({
      attempt: signal => {
        seen = signal;
        return new Promise<null>(() => {});
      },
      schedule: () => 1,
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: fastBackoff(),
      log: silentLog,
    });
    supervisor.start();
    await tick();
    expect(seen?.aborted).toBe(false);
    supervisor.close();
    expect(seen?.aborted).toBe(true);
  });

  test("the attempt-failed and drop lines name the device", async () => {
    const debugs: string[] = [];
    let dropCb: (reason?: Error) => void = () => {};
    let attempts = 0;
    const supervisor = new DeviceSupervisor({
      deviceId: "Living_room",
      attempt: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({
              onDrop: (cb: (r?: Error) => void) => (dropCb = cb),
              handleStateChange: () => {},
              close: () => {},
            });
      },
      schedule: cb => {
        setImmediate(cb);
        return 1;
      },
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: fastBackoff(),
      log: { ...silentLog, debug: (message: string): void => void debugs.push(message) },
    });
    supervisor.start();
    await tick();
    await tick();
    dropCb(new Error("liveness check unanswered"));
    expect(debugs).toContain("Living_room: connection attempt failed, retrying: boom");
    expect(debugs).toContain("Living_room: connection dropped, reconnecting: liveness check unanswered");
    supervisor.close();
  });
});

describe("DeviceSupervisor teardown", () => {
  test("a retry timer that fires after close attempts nothing", async () => {
    const attempt = vi.fn(() => Promise.resolve(null));
    const timers: Array<() => void> = [];
    const supervisor = new DeviceSupervisor({
      attempt,
      schedule: cb => {
        timers.push(cb);
        return timers.length;
      },
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: { nextDelay: () => 1000, reset: () => {} },
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    supervisor.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(attempt).toHaveBeenCalledTimes(1);

    supervisor.close();
    // onUnload is synchronous: a timer whose callback was already queued still
    // arrives, and must not open a socket from a stopped instance.
    timers.forEach(cb => cb());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("a connection that arrives after close is closed, not kept", async () => {
    let release: (v: unknown) => void = () => undefined;
    const handle = { onDrop: vi.fn(), handleStateChange: vi.fn(), close: vi.fn() };
    const supervisor = new DeviceSupervisor({
      attempt: () => new Promise<typeof handle | null>(resolve => (release = resolve as (v: unknown) => void)),
      schedule: () => 1,
      cancel: () => {},
      onConnectionChange: () => {},
      backoff: { nextDelay: () => 1000, reset: () => {} },
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    supervisor.start();
    supervisor.close();
    release(handle);
    await new Promise(resolve => setTimeout(resolve, 0));
    // The transports connect asynchronously; one that lands after the unload would
    // otherwise hold its sockets and timers open for good.
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.onDrop).not.toHaveBeenCalled();
  });
});

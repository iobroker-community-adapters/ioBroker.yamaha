import { HostHold, retryAfterMs } from "./host-hold";
import { HttpStatusError } from "./util";

/**
 * Fleet suite D21 in seconds (2026-10-22): the inventory run found calls 2.6 s after a 429 with `retry-after: 60`, and
 * eight calls a minute to every host that answered 500 to everything, minute after minute. The callers here fire like
 * the adapter did in that run — a start burst, then two calls (MusicCast and XML) every 7.5 s — and the wire calls are
 * judged by the suite's own rules.
 */

const MINUTE = 60_000;

/**
 * Fire the adapter's measured schedule at a hold whose host answers every call with one status.
 *
 * @param status the status of every answer
 * @param minutes how long
 * @param retryAfter the `Retry-After` of every answer
 * @returns the times the calls reached the wire
 */
async function schedule(status: number, minutes: number, retryAfter?: string): Promise<number[]> {
  let now = 0;
  const hold = new HostHold(() => now);
  const wire: number[] = [];
  const send = (): Promise<never> => {
    wire.push(now);
    return Promise.reject(new HttpStatusError(`HTTP ${status}`, status, retryAfter));
  };
  const call = (): Promise<unknown> => hold.run("10.10.0.11", "/main/getStatus", send).catch(() => undefined);
  await Promise.all([call(), call(), call(), call()]);
  for (now = 7_500; now < minutes * MINUTE; now += 7_500) {
    await Promise.all([call(), call()]);
  }
  return wire;
}

describe("the hold of a host that answers with errors (fleet suite D21)", () => {
  test("no call reaches a host before the retry-after of its 429 has run out", async () => {
    const wire = await schedule(429, 2, "60");
    const first = wire[0];
    expect(wire.filter(t => t > first + 2_000 && t < first + 58_000)).toEqual([]);
    expect(wire.some(t => t >= first + 60_000)).toBe(true);
  });

  test("under a 500 to every answer the calls get fewer from minute to minute", async () => {
    const wire = await schedule(500, 4);
    const perMinute = [0, 1, 2, 3].map(m => wire.filter(t => t >= m * MINUTE && t < (m + 1) * MINUTE).length);
    // the suite: a host called at least twice in the second minute and as often or more in the fourth has no backoff
    expect(perMinute[1] >= 2 && perMinute[3] >= perMinute[1]).toBe(false);
    expect(perMinute[3]).toBeLessThanOrEqual(1);
  });

  test("a held call is answered like the host would — with its status, never sent", async () => {
    let now = 0;
    const hold = new HostHold(() => now);
    const send = vi.fn(() => Promise.reject(new HttpStatusError("HTTP 429", 429, "60")));
    await expect(hold.run("h", "/a", send)).rejects.toMatchObject({ statusCode: 429 });
    now = 30_000;
    await expect(hold.run("h", "/b", send)).rejects.toMatchObject({ statusCode: 429 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(hold.heldMs("h")).toBe(30_000);
    expect(hold.heldMs("other")).toBe(0);
  });

  // D6 plays one 500 to the first call of every request, and a web server that boots answers a few: neither is a series.
  test("single server errors between answers hold nothing, a 2xx ends a series", async () => {
    const hold = new HostHold(() => 0);
    const fail = (): Promise<never> => Promise.reject(new HttpStatusError("HTTP 500", 500));
    const ok = (): Promise<string> => Promise.resolve("ok");
    for (let i = 0; i < 5; i++) {
      await hold.run("h", "/a", fail).catch(() => undefined);
      await hold.run("h", "/a", fail).catch(() => undefined);
      await expect(hold.run("h", "/a", ok)).resolves.toBe("ok");
    }
    expect(hold.heldMs("h")).toBe(0);
  });

  test("a device's verdict (an XML 400 or 404) and a call nobody answered count into no series", async () => {
    const hold = new HostHold(() => 0);
    for (const e of [
      new HttpStatusError("HTTP 400", 400),
      new HttpStatusError("HTTP 404", 404),
      new Error("timeout"),
    ]) {
      for (let i = 0; i < 5; i++) {
        await hold.run("h", "/a", () => Promise.reject(e)).catch(() => undefined);
      }
    }
    expect(hold.heldMs("h")).toBe(0);
    await expect(hold.run("h", "/a", () => Promise.resolve(1))).resolves.toBe(1);
  });

  test("while a series runs, one call goes out at a time", async () => {
    let now = 0;
    const hold = new HostHold(() => now);
    const fail = (): Promise<never> => Promise.reject(new HttpStatusError("HTTP 503", 503));
    for (let i = 0; i < 3; i++) {
      await hold.run("h", "/a", fail).catch(() => undefined);
    }
    now += hold.heldMs("h");
    let answer: (value: string) => void = () => undefined;
    const probe = hold.run("h", "/a", () => new Promise<string>(resolve => (answer = resolve)));
    await expect(hold.run("h", "/b", () => Promise.resolve("b"))).rejects.toMatchObject({ statusCode: 503 });
    answer("a");
    await expect(probe).resolves.toBe("a");
    await expect(hold.run("h", "/b", () => Promise.resolve("b"))).resolves.toBe("b");
  });
});

describe("the wait a Retry-After names", () => {
  test("seconds, an HTTP date, nothing readable — and never past five minutes", () => {
    expect(retryAfterMs("60", 0)).toBe(60_000);
    expect(retryAfterMs(" 5 ", 0)).toBe(5_000);
    expect(retryAfterMs(new Date(90_000).toUTCString(), 0)).toBe(90_000);
    expect(retryAfterMs(undefined, 0)).toBe(60_000);
    expect(retryAfterMs("soon", 0)).toBe(60_000);
    expect(retryAfterMs("3600", 0)).toBe(300_000);
    expect(retryAfterMs(new Date(0).toUTCString(), 10_000)).toBe(0);
  });
});

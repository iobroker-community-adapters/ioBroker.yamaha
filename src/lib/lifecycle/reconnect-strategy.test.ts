import { ReconnectStrategy } from "./reconnect-strategy";

describe("ReconnectStrategy", () => {
  test("backs off exponentially from the base delay", () => {
    const strategy = new ReconnectStrategy(1000, 30000, 0);
    expect(strategy.nextDelay()).toBe(1000);
    expect(strategy.nextDelay()).toBe(2000);
    expect(strategy.nextDelay()).toBe(4000);
  });

  test("caps the delay at the maximum", () => {
    const strategy = new ReconnectStrategy(1000, 3000, 0);
    expect(strategy.nextDelay()).toBe(1000);
    expect(strategy.nextDelay()).toBe(2000);
    expect(strategy.nextDelay()).toBe(3000);
    expect(strategy.nextDelay()).toBe(3000);
  });

  test("reset returns to the base delay", () => {
    const strategy = new ReconnectStrategy(1000, 30000, 0);
    strategy.nextDelay();
    strategy.nextDelay();
    strategy.reset();
    expect(strategy.nextDelay()).toBe(1000);
  });
});

describe("ReconnectStrategy jitter", () => {
  test("spreads the delay so several devices do not retry in lockstep", () => {
    const strategy = new ReconnectStrategy(1000, 30000);
    const delays = Array.from({ length: 40 }, () => {
      const d = strategy.nextDelay();
      strategy.reset();
      return d;
    });
    // Never above the nominal delay, never more than the declared 20 % below it — the
    // spread goes DOWNWARD since the 2026-09-02 audit, so a cap stays a cap.
    expect(Math.max(...delays)).toBeLessThanOrEqual(1000);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(800);
    // And genuinely spread — a constant value would put every device back in lockstep.
    expect(new Set(delays).size).toBeGreaterThan(5);
  });

  test("the jitter never lifts a delay above the cap (audit 2026-09-02)", () => {
    // Before the fix the "60 s ceiling" reached 72 s: the spread was applied ABOVE the cap.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      const backoff = new ReconnectStrategy(1000, 60000);
      for (let i = 0; i < 12; i++) {
        backoff.nextDelay();
      }
      const atCeiling = backoff.nextDelay();
      expect(atCeiling).toBeLessThanOrEqual(60000);
      expect(atCeiling).toBeGreaterThanOrEqual(48000);
    } finally {
      random.mockRestore();
    }
  });

  test("two devices at the ceiling are still spread apart — the convoy breaks", () => {
    // Spreading upward from a capped value could not do this: both would sit at the cap.
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    try {
      expect(new ReconnectStrategy(60000, 60000).nextDelay()).toBe(60000);
      expect(new ReconnectStrategy(60000, 60000).nextDelay()).toBe(54000);
    } finally {
      random.mockRestore();
    }
  });
});

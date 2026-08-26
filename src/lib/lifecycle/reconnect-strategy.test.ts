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
    // Never below the nominal delay, never more than the declared 20 % above it.
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1200);
    // And genuinely spread — a constant value would put every device back in lockstep.
    expect(new Set(delays).size).toBeGreaterThan(5);
  });
});

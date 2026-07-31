import { ReconnectStrategy } from "./reconnect-strategy";

describe("ReconnectStrategy", () => {
  test("backs off exponentially from the base delay", () => {
    const strategy = new ReconnectStrategy(1000, 30000);
    expect(strategy.nextDelay()).toBe(1000);
    expect(strategy.nextDelay()).toBe(2000);
    expect(strategy.nextDelay()).toBe(4000);
  });

  test("caps the delay at the maximum", () => {
    const strategy = new ReconnectStrategy(1000, 3000);
    expect(strategy.nextDelay()).toBe(1000);
    expect(strategy.nextDelay()).toBe(2000);
    expect(strategy.nextDelay()).toBe(3000);
    expect(strategy.nextDelay()).toBe(3000);
  });

  test("reset returns to the base delay", () => {
    const strategy = new ReconnectStrategy(1000, 30000);
    strategy.nextDelay();
    strategy.nextDelay();
    strategy.reset();
    expect(strategy.nextDelay()).toBe(1000);
  });
});

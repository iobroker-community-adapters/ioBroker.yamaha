import { ReachabilityDedup } from "./reachability-dedup";

describe("ReachabilityDedup", () => {
  test("first unreachable report warns, repeats stay at debug", () => {
    const dedup = new ReachabilityDedup();
    expect(dedup.reportUnreachable()).toBe("warn");
    expect(dedup.reportUnreachable()).toBe("debug");
    expect(dedup.reportUnreachable()).toBe("debug");
  });

  test("reportReachable re-arms the warn for the next failure", () => {
    const dedup = new ReachabilityDedup();
    expect(dedup.reportUnreachable()).toBe("warn");
    dedup.reportReachable();
    expect(dedup.reportUnreachable()).toBe("warn");
  });
});

import { MAX_POLL_FAILURES, PollDropDetector } from "./poll-drop-detector";

describe("PollDropDetector", () => {
  it("reports a drop only after a run of failed polls, and only once", () => {
    const detector = new PollDropDetector();
    const reasons: Array<Error | undefined> = [];
    detector.onDrop(reason => reasons.push(reason));
    for (let i = 0; i < MAX_POLL_FAILURES - 1; i++) {
      detector.record(false);
    }
    expect(reasons).toHaveLength(0);
    detector.record(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.message).toBe(`${MAX_POLL_FAILURES} polls failed`);
    detector.record(false);
    expect(reasons).toHaveLength(1);
  });

  it("a single answered poll resets the run", () => {
    const detector = new PollDropDetector(2);
    const reasons: Array<Error | undefined> = [];
    detector.onDrop(reason => reasons.push(reason));
    detector.record(false);
    detector.record(true);
    detector.record(false);
    expect(reasons).toHaveLength(0);
  });

  it("delivers a drop that happened before the handler was registered", () => {
    // The multi-transport handle registers onDrop only after every transport connected. A
    // drop judged in that window used to be reported to nobody — and because `dropped` was
    // already set it was never reported again, so the device stayed "connected" for good.
    // The YNCA client and the handle both latch for exactly this case.
    const detector = new PollDropDetector(1);
    const reasons: Array<Error | undefined> = [];
    detector.record(false);
    detector.onDrop(reason => reasons.push(reason));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.message).toBe("1 polls failed");
    // …and only once.
    detector.record(false);
    expect(reasons).toHaveLength(1);
  });
});

describe("PollDropDetector reason (audit 2026-09-24, C29)", () => {
  it("carries the reason it is given instead of claiming a run of failed polls", () => {
    const detector = new PollDropDetector();
    const reasons: Array<string | undefined> = [];
    detector.onDrop(reason => reasons.push(reason?.message));
    detector.report("liveness check unanswered");
    expect(reasons).toEqual(["liveness check unanswered"]);
  });
});

describe("PollDropDetector.verify — one liveness question for MusicCast and XML (review 2026-10-05, E)", () => {
  it("asks once for a burst of askers and reports an unanswered question at once", async () => {
    const detector = new PollDropDetector();
    const reasons: Array<string | undefined> = [];
    detector.onDrop(reason => reasons.push(reason?.message));
    let asked = 0;
    let answer: (alive: boolean) => void = () => undefined;
    const ask = (): Promise<boolean> => {
      asked++;
      return new Promise(resolve => (answer = resolve));
    };
    const first = detector.verify(ask);
    const second = detector.verify(ask);
    answer(false);
    await Promise.all([first, second]);
    expect(asked).toBe(1);
    expect(reasons).toEqual(["liveness check unanswered"]);
  });

  it("takes a rejected question for no answer, and asks again once the first one settled", async () => {
    const detector = new PollDropDetector();
    const reasons: Array<string | undefined> = [];
    detector.onDrop(reason => reasons.push(reason?.message));
    await detector.verify(() => Promise.resolve(true));
    expect(reasons).toEqual([]);
    await detector.verify(() => Promise.reject(new Error("socket hang up")));
    expect(reasons).toEqual(["liveness check unanswered"]);
  });
});

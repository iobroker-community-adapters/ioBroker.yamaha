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

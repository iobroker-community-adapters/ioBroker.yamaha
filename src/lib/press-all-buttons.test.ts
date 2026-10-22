import type { WriteOutcome } from "./lifecycle/multi-transport-handle";
import { readTransport, startFixtures, type FixtureDevice } from "../../test/helpers/parity-harness";

/**
 * Fleet suite D9 in seconds (2026-10-22): the suite presses every button of every device at once and wants each back to
 * false within 15 s — the button falls back when its write is handled, so every press has to be handled inside the
 * window. Every inventory fixture is pressed the suite's way, protocol by protocol, through the real client and
 * controller.
 */

/** The suite's window (`test/fleet-suites.js` PRESS_WINDOW_MS). */
const PRESS_WINDOW_MS = 15_000;

describe("every button of a receiver pressed at once is handled inside the D9 window", () => {
  let devices: FixtureDevice[] = [];
  let stop: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    ({ devices, stop } = await startFixtures());
  }, 60_000);

  afterAll(async () => {
    await stop();
  });

  test("each fixture, each protocol", async () => {
    const late: string[] = [];
    for (const device of devices) {
      for (const transport of device.transports) {
        await readTransport(device, transport, undefined, {
          act: async (adapter, objects) => {
            const buttons = [...objects.values()]
              .filter(def => String(def.common.role ?? "").startsWith("button") && def.common.write !== false)
              .map(def => def.id);
            const started = Date.now();
            const outcomes: Array<WriteOutcome | void> = await Promise.all(
              buttons.map(id => adapter.handleWrite(id, true)),
            );
            const took = Date.now() - started;
            const tally = outcomes.reduce<Record<string, number>>((counts, outcome) => {
              counts[String(outcome)] = (counts[String(outcome)] ?? 0) + 1;
              return counts;
            }, {});
            console.log(`${device.id}/${transport}: ${buttons.length} buttons in ${took} ms ${JSON.stringify(tally)}`);
            // half the window: the harness shortens the pacing between lines below a second (YNCA 100 ms → 50 ms)
            if (took > PRESS_WINDOW_MS / 2) {
              late.push(`${device.id}/${transport}: ${buttons.length} buttons took ${took} ms`);
            }
          },
        });
      }
    }
    expect(late).toEqual([]);
  }, 300_000);
});

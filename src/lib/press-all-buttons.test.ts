import type { WriteOutcome } from "./lifecycle/multi-transport-handle";
import type { YxcSend } from "./yxc/http-client";
import { readTransport, startFixtures, type FixtureDevice } from "../../test/helpers/parity-harness";

/**
 * Fleet suite D9 in seconds (2026-10-22): the suite presses every button of every device at once and wants each back to
 * false within 15 s — the handle sets a button back once the device answered its press (sent or refused), so every
 * press has to have its verdict inside the window. A press the adapter drops itself reaches nothing and stays as written;
 * the suite tells it apart by pressing it alone (round 142). Every inventory fixture is pressed the suite's way, protocol by
 * protocol, through the real client and controller, and the time runs until each verdict, a menu step's after it ran.
 *
 * GV-13 in seconds (inventory run 2026-10-22: 74 buttons acked while nothing answered): with every answer held back no
 * press gets a verdict the handle confirms.
 */

/** The suite's window (`test/fleet-suites.js` PRESS_WINDOW_MS). */
const PRESS_WINDOW_MS = 15_000;

/** How long the held presses are watched for a verdict. */
const HELD_MS = 2_000;

/** The verdicts after which the handle sets the button back (`MultiTransportHandle.routeWrite`). */
const ANSWERED: ReadonlySet<WriteOutcome> = new Set<WriteOutcome>(["sent", "refused"]);

describe("every button of a receiver pressed at once", () => {
  let devices: FixtureDevice[] = [];
  let stop: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    ({ devices, stop } = await startFixtures());
  }, 60_000);

  afterAll(async () => {
    await stop();
  });

  test("has its verdict inside the D9 window — each fixture, each protocol", async () => {
    const late: string[] = [];
    for (const device of devices) {
      for (const transport of device.transports) {
        await readTransport(device, transport, undefined, {
          act: async (adapter, objects) => {
            const buttons = [...objects.values()]
              .filter(def => String(def.common.role ?? "").startsWith("button") && def.common.write !== false)
              .map(def => def.id);
            const started = Date.now();
            const outcomes = await Promise.all(buttons.map(id => adapter.handleWrite(id, true)));
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

  test("gets no verdict the handle confirms while MusicCast answers nothing (GV-13)", async () => {
    const confirmed: string[] = [];
    let pressed = 0;
    for (const device of devices.filter(d => d.transports.includes("yxc"))) {
      let held = false;
      const hold =
        (send: YxcSend): YxcSend =>
        (command, body) =>
          held ? new Promise<unknown>(() => undefined) : send(command, body);
      await readTransport(device, "yxc", undefined, {
        send: hold,
        act: async (adapter, objects) => {
          held = true;
          const buttons = [...objects.values()]
            .filter(def => String(def.common.role ?? "").startsWith("button") && def.common.write !== false)
            .map(def => def.id);
          pressed += buttons.length;
          for (const id of buttons) {
            void Promise.resolve(adapter.handleWrite(id, true)).then(outcome => {
              if (outcome !== undefined && ANSWERED.has(outcome)) {
                confirmed.push(`${device.id}.${id} ${outcome}`);
              }
            });
          }
          await new Promise(resolve => setTimeout(resolve, HELD_MS));
        },
      });
    }
    expect(pressed).toBeGreaterThan(0);
    expect(confirmed).toEqual([]);
  }, 120_000);
});

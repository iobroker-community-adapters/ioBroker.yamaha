import type { YxcSend } from "./http-client";
import { HttpStatusError } from "../util";
import { drift } from "../../../test/helpers/drift";
import { readTransport, startFixtures, type FixtureDevice } from "../../../test/helpers/parity-harness";

/**
 * Fleet suite D6/C26b in seconds (2026-10-22, Y-01): the network hook answers the first call of every request with a
 * 500, an empty 200 or drifted JSON, and a value the receiver had reported must not become empty. The inventory run
 * found the player block emptied on a 500 and power, inputs and settings emptied on drifted JSON — here every
 * MusicCast fixture is read clean and then once per wrong answer, through the real client and controller.
 */

const EMPTY = new Set<unknown>([null, ""]);

type Wrong = "500" | "empty" | "drift";

/**
 * A send that answers the first call of each request wrong, the repeat as the device does.
 *
 * @param mode the wrong answer
 * @returns the wrapper
 */
function firstAnswerWrong(mode: Wrong): (send: YxcSend) => YxcSend {
  const met = new Set<string>();
  return send => async (command, body) => {
    const key = `${body === undefined ? "GET" : "POST"} ${command.split("?")[0]}`;
    if (met.has(key)) {
      return send(command, body);
    }
    met.add(key);
    if (mode === "500") {
      throw new HttpStatusError(`device refused ${command} (HTTP 500)`, 500);
    }
    if (mode === "empty") {
      throw new SyntaxError("Unexpected end of JSON input");
    }
    return drift(await send(command, body));
  };
}

describe("a wrong MusicCast answer empties nothing the receiver reported (fleet suite D6/C26b, Y-01)", () => {
  let devices: FixtureDevice[] = [];
  let stop: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    ({ devices, stop } = await startFixtures());
  }, 60_000);

  afterAll(async () => {
    await stop();
  });

  test("a 500, an empty 200 and drifted JSON on every fixture", async () => {
    const emptied: string[] = [];
    for (const device of devices.filter(d => d.transports.includes("yxc"))) {
      const clean = await readTransport(device, "yxc");
      for (const mode of ["500", "empty", "drift"] as const) {
        // The supervisor connects again after a failed start; a request met once is answered as the device does.
        const send = firstAnswerWrong(mode);
        const wrong = new Map<string, unknown>();
        for (let attempt = 0; attempt < 20; attempt++) {
          const read = await readTransport(device, "yxc", undefined, { send, mayFail: true });
          read.values.forEach((value, id) => wrong.set(id, value));
          if (read.connected) {
            break;
          }
        }
        expect(wrong.size, `${device.id} ${mode}: never connected`).toBeGreaterThan(0);
        for (const [id, value] of clean.values) {
          if (!EMPTY.has(value) && wrong.has(id) && EMPTY.has(wrong.get(id))) {
            emptied.push(`${device.id} ${mode}: ${id}`);
          }
        }
      }
    }
    expect(emptied).toEqual([]);
  }, 300_000);
});

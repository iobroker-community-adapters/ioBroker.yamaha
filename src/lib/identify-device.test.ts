import { DEFAULT_IDENTIFY_DEPS, identifyDevice, ONE_QUESTION, type IdentifyDeps } from "./identify-device";
import { CommandGate, CommandGateClosedError } from "./lifecycle/command-gate";
import { LIVE_GATES } from "./lifecycle/gate-registry";

/**
 * Two fake questions: each answers what it is given, or refuses like a device that does not speak
 * that protocol (or is switched off).
 *
 * @param yxc the getDeviceInfo answer, or an Error
 * @param xml the System/Config answer, or an Error
 * @returns the deps
 */
function deps(yxc: unknown, xml: unknown): IdentifyDeps {
  return {
    yxcDeviceInfo: () => (yxc instanceof Error ? Promise.reject(yxc) : Promise.resolve(yxc)),
    xmlSystemConfig: () =>
      xml instanceof Error ? Promise.reject(xml) : Promise.resolve(xml as { model?: string; systemId?: string }),
  };
}

const offline = new Error("ECONNREFUSED");

describe("identifyDevice", () => {
  test("a MusicCast device tells model, serial and MAC", async () => {
    await expect(
      identifyDevice(
        "10.0.0.5",
        deps({ model_name: "WX-030", system_id: "0E897553", device_id: "00A0DED4F504" }, offline),
      ),
    ).resolves.toEqual({ model: "WX-030", identity: { serial: "0E897553", mac: "00A0DED4F504" } });
  });

  test("an XML receiver tells model and serial", async () => {
    await expect(
      identifyDevice("10.0.0.6", deps(offline, { model: "RX-V3900", systemId: "0CE4E483" })),
    ).resolves.toEqual({ model: "RX-V3900", identity: { serial: "0CE4E483" } });
  });

  test("a receiver speaking both joins the answers", async () => {
    await expect(
      identifyDevice(
        "10.0.0.7",
        deps({ model_name: "RX-V6A", device_id: "AABBCCDDEEFF" }, { model: "RX-V6A", systemId: "0B000001" }),
      ),
    ).resolves.toEqual({ model: "RX-V6A", identity: { serial: "0B000001", mac: "AABBCCDDEEFF" } });
  });

  test("a device that answers neither (off, or YNCA only) tells nothing", async () => {
    await expect(identifyDevice("10.0.0.8", deps(offline, offline))).resolves.toEqual({});
  });

  test("scrubbed or malformed numbers are no identity", async () => {
    await expect(
      identifyDevice("10.0.0.9", deps({ model_name: "WX-010", system_id: "00000000", device_id: "xyz" }, offline)),
    ).resolves.toEqual({ model: "WX-010" });
  });
});

// The device being added may already run (the search found it): the questions went out in parallel to its running
// connection's own traffic, past its command gate (review 2026-10-05, A13).
describe("identifyDevice asks through the device's command gate (Y-15)", () => {
  test("a running connection's gate holds both questions back while it is busy", async () => {
    const timers = { schedule: (): undefined => undefined, cancel: (): void => undefined };
    const ip = "192.0.2.77";
    const busy = {
      yxc: new CommandGate({ minSpacingMs: 0, timers }),
      xml: new CommandGate({ minSpacingMs: 0, timers }),
    };
    LIVE_GATES.hold("yxc", ip, busy.yxc);
    LIVE_GATES.hold("xml", ip, busy.xml);
    void busy.yxc.run(() => new Promise<void>(() => undefined)).catch(() => undefined);
    void busy.xml.run(() => new Promise<void>(() => undefined)).catch(() => undefined);
    const yxc = DEFAULT_IDENTIFY_DEPS.yxcDeviceInfo(ip);
    const xml = DEFAULT_IDENTIFY_DEPS.xmlSystemConfig(ip);
    // Queued behind the running work, they never reached the network: closing the gates ends them unsent.
    busy.yxc.close();
    busy.xml.close();
    await expect(yxc).rejects.toBeInstanceOf(CommandGateClosedError);
    await expect(xml).rejects.toBeInstanceOf(CommandGateClosedError);
  });
});

describe("the gate of a single question", () => {
  test("schedules nothing — a timer it asked for would outlive onUnload, so it fails loudly", () => {
    expect(() => ONE_QUESTION.schedule(() => undefined, 100)).toThrow("a gate for one question schedules nothing");
  });
});

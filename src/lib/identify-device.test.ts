import { identifyDevice, type IdentifyDeps } from "./identify-device";

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

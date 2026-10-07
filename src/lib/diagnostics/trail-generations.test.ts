import { readTransport, startFixtures, type FixtureDevice } from "../../../test/helpers/parity-harness";
import type { Transport } from "../catalog/owner-policy";
import { buildReportBody, type ReportInput } from "./report";
import { TrafficRecorder, type TrafficSource } from "./traffic-recorder";

// Plan „Diagnosebericht“ (krobi 2026-10-06): every generation the inventory fixtures carry — YNCA 2012+ (R-N500,
// RX-V473) and the MusicCast generation (RX-A2070, RX-V6A), XML 2008 (RX-V3900) and 2020 (RX-V6A), MusicCast API 2.08
// and 2.17 — read by the real clients through the recorded seams, as the adapter wires them: what the device said
// stands in the trail and in the report, whole and pseudonymised. YNCA 2010/11 and XML 2009–2017 have no inventory
// fixture; recorded-transports.test.ts covers them at the seam.

const SOURCE: Record<Transport, TrafficSource> = { ynca: "ynca", yxc: "musiccast", xml: "xml" };

/**
 * A report of one fixture device made of its trail.
 *
 * @param device the device
 * @param recorder its trail
 * @returns the report text
 */
function reportOf(device: FixtureDevice, recorder: TrafficRecorder): string {
  const input: ReportInput = {
    environment: {
      node: "v22",
      platform: "linux x64",
      musiccast: { status: "not installed", installed: false, instances: [] },
      musiccastClient: { pushPortBlocked: false, pushPortListening: true },
      config: {},
      devices: { running: 1, connected: 0 },
      startedAt: "x",
    },
    device: { id: device.id, ip: device.ip, connected: false, transports: {} },
    objectTree: [],
    logs: [],
    trail: recorder.snapshot(),
  };
  return JSON.stringify(buildReportBody(input).content);
}

describe("the diagnostics trail over every fixture generation", () => {
  let fixtures: { devices: FixtureDevice[]; stop: () => Promise<void> };
  const trails = new Map<string, TrafficRecorder>();

  beforeAll(async () => {
    fixtures = await startFixtures();
    for (const device of fixtures.devices) {
      const recorder = new TrafficRecorder();
      for (const transport of device.transports) {
        await readTransport(device, transport, recorder);
      }
      trails.set(device.id, recorder);
    }
  }, 120_000);

  afterAll(async () => {
    await fixtures.stop();
  });

  it("records what each protocol of each device said, in its own ring", () => {
    for (const device of fixtures.devices) {
      const traffic = trails.get(device.id)!.snapshot().traffic;
      for (const transport of ["ynca", "yxc", "xml"] as const) {
        const entries = traffic[SOURCE[transport]];
        if (device.transports.includes(transport)) {
          expect(entries.length, `${device.id}/${transport}`).toBeGreaterThan(0);
        } else {
          expect(entries, `${device.id}/${transport}`).toEqual([]);
        }
      }
      if (device.transports.includes("ynca")) {
        const directions = new Set(traffic.ynca.map(entry => entry.direction));
        expect([...directions].sort(), device.id).toEqual(["received", "sent"]);
      }
    }
  });

  it("counts a repeat instead of stacking it (R1) — no two entries of a ring are the same", () => {
    for (const device of fixtures.devices) {
      const traffic = trails.get(device.id)!.snapshot().traffic;
      for (const [source, entries] of Object.entries(traffic)) {
        const seen = entries.map(entry => JSON.stringify([entry.direction, entry.request, entry.answer, entry.error]));
        expect(new Set(seen).size, `${device.id}/${source}`).toBe(seen.length);
      }
    }
  });

  it("keeps every XML answer whole or only its size (R3) — the device description included", () => {
    for (const device of fixtures.devices.filter(d => d.transports.includes("xml"))) {
      const xml = trails.get(device.id)!.snapshot().traffic.xml;
      for (const entry of xml) {
        if (typeof entry.answer === "string" && entry.answer.length > 0) {
          expect(entry.answer.trimEnd().endsWith(">"), `${device.id} ${entry.request}`).toBe(true);
        } else {
          expect(entry.omittedBytes ?? entry.error ?? entry.answer, `${device.id} ${entry.request}`).toBeDefined();
        }
      }
      expect(
        xml.some(entry => entry.request === "GET /YamahaRemoteControl/desc.xml"),
        device.id,
      ).toBe(true);
    }
  });

  it("the report carries the trail and no address of the devices", () => {
    for (const device of fixtures.devices) {
      const content = reportOf(device, trails.get(device.id)!);
      const report = JSON.parse(content) as { trail: { traffic: Record<string, unknown[]> } };
      const recorded = trails.get(device.id)!.snapshot().traffic;
      for (const source of Object.keys(recorded) as TrafficSource[]) {
        expect(report.trail.traffic[source], `${device.id}/${source}`).toHaveLength(recorded[source].length);
      }
      expect(content, device.id).not.toContain(device.ip);
    }
  });
});

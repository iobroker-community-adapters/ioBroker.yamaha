import { describe, expect, it } from "vitest";
import type { HandleCapture } from "./types";
import { buildDiagnosticsReport, diagnosticsExport, personalIdPart, type ReportInput } from "./report";
import { TrafficRecorder } from "./traffic-recorder";

/**
 * A report input for one device; the rest as the test gives it.
 *
 * @param over what the test changes
 */
function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    adapterVersion: "3.3.0",
    now: new Date(Date.UTC(2026, 9, 5)),
    environment: {
      node: "v22",
      platform: "linux x64",
      musiccast: { status: "not installed", installed: false, instances: [] },
      musiccastClient: { pushPortBlocked: false, pushPortListening: true },
      config: {},
      devices: { running: 1, connected: 0 },
      startedAt: "x",
    },
    device: {
      id: "rx-v6a-2b3c",
      ip: "192.168.178.40",
      model: "RX-V6A",
      label: "Wohnzimmer",
      identity: { serial: "0A1B2B3C", mac: "00A0DED4F504" },
      connected: false,
      transports: { ynca: false, yxc: false, xml: false },
    },
    objectTree: [],
    logs: [],
    ...over,
  };
}

/**
 * The report as the file holds it.
 *
 * @param over what the test changes
 */
function reportText(over: Partial<ReportInput> = {}): string {
  return JSON.stringify(buildDiagnosticsReport(input(over)));
}

// Review 2026-10-05, B1 (proof tests misc/pseudo-leaks, misc/pseudo-ynca-offline): the most common report — the one
// of a device that is not connected — carried the room names in clear.
describe("diagnostics report of a device that is not connected (B1)", () => {
  const capabilityProfile = JSON.stringify({
    schema: 9,
    identity: { xml: { model: "RX-V6A", systemId: "0C1D2E3F", version: "1.8" } },
    memory: {
      yncaCapabilities: {
        model: "RX-V6A",
        firmware: "1.8",
        subunits: { MAIN: { ZONENAME: "Wohnzimmer" }, ZONE2: { ZONENAME: "Kinderzimmer" } },
      },
      yncaStaticValues: { MAIN: { ZONEBNAME: "Balkon" } },
      "xmlZoneNames:zone2": { zone: "Kinderzimmer", zoneB: "Terrasse" },
      xmlIdentity: "RX-V6A|0C1D2E3F|1.8",
    },
  });

  it("replaces the room names, serials and MACs inside the stored capability profile", () => {
    const text = reportText({ profile: { capabilityProfile } });
    for (const secret of ["Wohnzimmer", "Kinderzimmer", "Terrasse", "Balkon", "0C1D2E3F", "0A1B2B3C"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("shows the stored profile as the object it holds, not as a JSON text", () => {
    const report = buildDiagnosticsReport(input({ profile: { capabilityProfile, idScheme: 3 } }));
    const profile = report.profile as { capabilityProfile: { schema: number; memory: object }; idScheme: number };
    expect(profile.capabilityProfile.schema).toBe(9);
    expect(profile.capabilityProfile.memory).toHaveProperty("yncaCapabilities");
    expect(profile.idScheme).toBe(3);
    // A text that is no JSON stays a text.
    const broken = buildDiagnosticsReport(input({ profile: { capabilityProfile: "{not json" } }));
    expect((broken.profile as { capabilityProfile: unknown }).capabilityProfile).toBe("{not json");
  });

  it("replaces the main zone's room name of an offline YNCA receiver whose label is its model", () => {
    const profile = JSON.stringify({
      schema: 9,
      memory: {
        yncaCapabilities: {
          model: "RX-V473",
          firmware: "1.0",
          subunits: { MAIN: { ZONENAME: "Wohnzimmer", PWR: "Standby" } },
        },
      },
    });
    const text = reportText({
      device: {
        id: "rx-v473",
        ip: "192.168.178.50",
        model: "RX-V473",
        label: "RX-V473",
        connected: false,
        transports: {},
      },
      profile: { capabilityProfile: profile, label: "RX-V473" },
      objectTree: [{ id: "zoneName", type: "string", val: "Wohnzimmer" }],
    });
    expect(text).not.toContain("Wohnzimmer");
    // The model is no name: it stays readable.
    expect(text).toContain("RX-V473");
  });

  it("replaces the names the datapoints hold (zone names, Zone B, the Link group, the Bluetooth device)", () => {
    const text = reportText({
      objectTree: [
        { id: "multiroom.zone2.zoneName", type: "string", val: "Kinderzimmer" },
        { id: "multiroom.zoneB.zoneName", type: "string", val: "Terrasse" },
        { id: "multiroom.group.name", type: "string", val: "Erdgeschoss" },
        { id: "player.bluetooth.deviceName", type: "string", val: "iPhone von Anna" },
        { id: "player.artist", type: "string", val: "Die Ärzte" },
      ],
      logs: [{ ts: "t", level: "debug", msg: "rx-v6a-2b3c: zone2 name is Kinderzimmer" }],
    });
    for (const secret of ["Kinderzimmer", "Terrasse", "Erdgeschoss", "iPhone von Anna"]) {
      expect(text, secret).not.toContain(secret);
    }
    // What is playing is no name the user gave a room or a device.
    expect(text).toContain("Die Ärzte");
  });

  it("replaces the device name an SSDP announcement or a rename wrote into the log, never a bare model", () => {
    const text = reportText({
      logs: [
        { ts: "t", level: "debug", msg: "SSDP alive from 192.168.178.61: Küche announced itself" },
        { ts: "t", level: "debug", msg: "SSDP alive from 192.168.178.62: WX-030 announced itself" },
        { ts: "t", level: "debug", msg: 'rx-v6a-2b3c: device name set to "Heimkino"' },
      ],
    });
    expect(text).not.toContain("Küche");
    expect(text).not.toContain("Heimkino");
    expect(text).toContain("WX-030 announced itself");
  });
});

// Review 2026-10-05, B3: the device id and the file name were not pseudonymised.
describe("diagnostics report: device id and file name (B3)", () => {
  it("replaces an id taken from a typed room name, in the content and in the file name", () => {
    const report = diagnosticsExport(
      input({
        device: { id: "kueche", ip: "192.168.178.41", label: "Küche", connected: false, transports: {} },
        logs: [{ ts: "t", level: "info", msg: "kueche: no reachable transport" }],
      }),
    );
    expect(report.content).not.toContain("Küche");
    expect(report.content).not.toContain("kueche");
    expect(report.content).toContain("device-1: no reachable transport");
    expect(report.fileName).not.toContain("kueche");
    expect(report.fileName).toBe("yamaha_device-1_v3.3.0_2026-10-05_000000.json");
  });

  it("replaces a hostname a device was entered with — it names the user's network", () => {
    const report = diagnosticsExport(
      input({
        device: { id: "rx-v6a-2b3c", ip: "wohnzimmer-avr.fritz.box", connected: false, transports: {} },
        logs: [{ ts: "t", level: "debug", msg: "rx-v6a-2b3c: connect wohnzimmer-avr.fritz.box failed" }],
      }),
    );
    expect(report.content).not.toContain("wohnzimmer-avr.fritz.box");
  });

  it("replaces an id taken from an address — 3.x and 2.x spelling", () => {
    for (const id of ["192-168-178-41", "192_168_178_41"]) {
      const report = diagnosticsExport(
        input({
          device: { id, ip: "192.168.178.41", connected: false, transports: {} },
          logs: [{ ts: "t", level: "debug", msg: `${id}: no reachable transport` }],
        }),
      );
      expect(report.content, id).not.toContain(id);
      expect(report.content).not.toContain("192.168.178.41");
      expect(report.fileName, id).not.toContain(id);
    }
  });

  it("replaces the whole serial of a second device of the same model — the file name keeps its last four", () => {
    const report = diagnosticsExport(
      input({
        device: {
          id: "wx-010-0b11aa22",
          ip: "192.168.178.42",
          model: "WX-010",
          identity: { serial: "0B11AA22" },
          connected: false,
          transports: {},
        },
      }),
    );
    expect(report.content.toLowerCase()).not.toContain("0b11aa22");
    expect(report.fileName.toLowerCase()).not.toContain("0b11aa22");
    expect(report.fileName).toBe("yamaha_wx-010-serial-1-AA22_v3.3.0_2026-10-05_000000.json");
  });

  it("keeps an id the adapter built from the model, and from the model and the serial's last four", () => {
    expect(diagnosticsExport(input()).fileName).toBe("yamaha_rx-v6a-2b3c_v3.3.0_2026-10-05_000000.json");
    expect(personalIdPart("rx-v6a-2b3c", "RX-V6A")).toBeUndefined();
    expect(personalIdPart("rx-v473", "RX-V473")).toBeUndefined();
    expect(personalIdPart("rx-v473-2", "RX-V473")).toBeUndefined();
    expect(personalIdPart("wx-010-0b11aa22", "WX-010")).toEqual({ kind: "serial", value: "0b11aa22" });
    expect(personalIdPart("rx-v6a-kueche", "RX-V6A")).toEqual({ kind: "device", value: "rx-v6a-kueche" });
    // Without the model an id cannot be told from a typed one — it is replaced.
    expect(personalIdPart("rx-v6a-2b3c", undefined)).toEqual({ kind: "device", value: "rx-v6a-2b3c" });
  });
});

describe("diagnostics report of a connected device (B1, B3)", () => {
  it("replaces the Bluetooth device, the app's UUID, the Link group and the XML room names of the captures", () => {
    const connection: HandleCapture = {
      live: ["ynca", "yxc", "xml"],
      missing: [],
      owners: {},
      tree: { shared: {}, transports: [] } as unknown as HandleCapture["tree"],
      captures: [
        {
          transport: "ynca",
          startedAt: "",
          durationMs: 1,
          complete: true,
          asked: 2,
          answers: { "BT:DEVICENAME": "iPhone von Anna", "MAIN:ZONENAME": "Wohnzimmer" },
          lines: ["@BT:DEVICENAME=iPhone von Anna", "@MAIN:ZONENAME=Wohnzimmer"],
        },
        {
          transport: "yxc",
          startedAt: "",
          durationMs: 1,
          complete: true,
          asked: 2,
          answers: {
            "system/getDeviceInfo": {
              model_name: "RX-V6A",
              system_id: "0A1B2B3C",
              device_id: "00A0DED4F504",
              analytics_info: { uuid: "5f0c7c2e-1d1b-4c55-9f3e-2b9c1a7d8e11" },
            },
            "dist/getDistributionInfo": { group_name: "Garten", role: "client", client_list: [] },
          },
        },
        {
          transport: "xml",
          startedAt: "",
          durationMs: 1,
          complete: true,
          asked: 4,
          answers: {
            "Main_Zone/Config":
              "<YAMAHA_AV><Main_Zone><Config><Name><Zone>Wohnzimmer</Zone><Zone_B>Terrasse</Zone_B>" +
              "<Room_for_YXC>Esszimmer</Room_for_YXC></Name></Config></Main_Zone></YAMAHA_AV>",
            "Zone_2/Rename":
              "<YAMAHA_AV><Zone_2><Rename><Rename_Latin_1>Kinder &amp; Gäste</Rename_Latin_1></Rename></Zone_2></YAMAHA_AV>",
            "Bluetooth/Play_Info":
              "<YAMAHA_AV><Bluetooth><Play_Info><Device_Name>Pixel von Ben</Device_Name></Play_Info></Bluetooth></YAMAHA_AV>",
            "Main_Zone/Basic_Status":
              "<YAMAHA_AV><Main_Zone><Basic_Status><Volume><Zone_B><Lvl>Off</Lvl></Zone_B></Volume><Sleep>Off</Sleep></Basic_Status></Main_Zone></YAMAHA_AV>",
          },
          descriptor: null,
        },
      ],
    };
    const text = reportText({
      device: { ...input().device, connected: true },
      connection,
      objectTree: [{ id: "multiroom.zone2.zoneName", type: "string", val: "Kinder & Gäste" }],
    });
    for (const secret of [
      "Wohnzimmer",
      "iPhone von Anna",
      "5f0c7c2e-1d1b-4c55-9f3e-2b9c1a7d8e11",
      "Terrasse",
      "Esszimmer",
      "Garten",
      "Kinder &amp; Gäste",
      "Kinder & Gäste",
      "Pixel von Ben",
      "00A0DED4F504",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // The decoded and the raw spelling of one name are one marker.
    const report = JSON.parse(text) as {
      captures: { xml: { answers: Record<string, string> } };
      objectTree: Array<{ val: string }>;
    };
    const marker = report.objectTree[0].val;
    expect(marker).toMatch(/^name-\d+$/);
    expect(report.captures.xml.answers["Zone_2/Rename"]).toContain(`<Rename_Latin_1>${marker}</Rename_Latin_1>`);
    // A status word inside Basic_Status's own Zone_B block is no name.
    expect(report.captures.xml.answers["Main_Zone/Basic_Status"]).toContain("<Lvl>Off</Lvl>");
  });
});

// Plan „Diagnosebericht“ (krobi 2026-10-06): what happened before the report, for a device that is offline now.
describe("the diagnostics trail in the report", () => {
  /**
   * A trail with a history: the device served, a command fell back, the device went off.
   *
   * @returns the recorder
   */
  function offlineTrail(): TrafficRecorder {
    let now = Date.UTC(2026, 9, 6, 10, 0, 0);
    const rec = new TrafficRecorder(() => (now += 1000));
    rec.connection("attempt", { transports: { ynca: "connected", yxc: "connected", xml: "did not answer" } });
    rec.connection("connected");
    rec.lastOwners(
      new Map([
        ["volume", "yxc"],
        ["input", "ynca"],
      ] as const),
    );
    rec.yncaLine("received", "@ZONE2:ZONENAME=Kinderzimmer");
    rec.xml(
      '<YAMAHA_AV cmd="GET"><Main_Zone><Config>GetParam</Config></Main_Zone></YAMAHA_AV>',
      {
        answer: "<YAMAHA_AV><Main_Zone><Config><Name><Zone>Wohnzimmer</Zone></Name></Config></Main_Zone></YAMAHA_AV>",
      },
      40,
    );
    rec.musiccast(
      "/system/getLocationInfo",
      undefined,
      { answer: { response_code: 0, id: "abc123", name: "Haus Krobath" } },
      30,
    );
    rec.musiccast("/system/getNetworkStatus", undefined, { answer: { response_code: 0, ssid: "KrobiNet" } }, 30);
    rec.event('{"netusb":{"play_time":3},"device_id":"00A0DED4F504"}');
    rec.command("multiroom.zoneB.zoneName", "Terrasse", [{ transport: "ynca", outcome: "sent" }]);
    rec.command("power", false, [
      { transport: "yxc", outcome: "unavailable" },
      { transport: "ynca", outcome: "sent", because: "yxc could not send it" },
    ]);
    rec.connection("transport dropped", { transport: "yxc", reason: "3 polls failed" });
    rec.connection("transport dropped", { transport: "ynca", reason: "read ECONNRESET" });
    rec.connection("disconnected");
    rec.connection("no reachable transport", { transports: { ynca: "connect ETIMEDOUT", yxc: "connect ETIMEDOUT" } });
    // XML drops last — its reason is the drop, not the attempt before.
    rec.connection("transport dropped", { transport: "xml", reason: "3 polls failed" });
    return rec;
  }

  it("an offline device: since when, each protocol's last reason, the owners of its last connection", () => {
    const report = buildDiagnosticsReport(input({ trail: offlineTrail().snapshot() })) as {
      connection: { ownersAtLastConnection: { owners: Record<string, string> } };
      trail: {
        disconnectedSince: string;
        lastReasonPerTransport: Record<string, { reason: string }>;
        commandResults: Array<{ id: string; attempts: Array<{ because?: string }> }>;
      };
    };
    expect(report.trail.disconnectedSince).toBe("2026-10-06T10:00:13.000Z");
    expect(report.trail.lastReasonPerTransport).toMatchObject({
      ynca: { reason: "connect ETIMEDOUT" },
      yxc: { reason: "connect ETIMEDOUT" },
      xml: { reason: "transport dropped: 3 polls failed" },
    });
    expect(report.connection.ownersAtLastConnection.owners).toEqual({ input: "ynca", volume: "yxc" });
    expect(report.trail.commandResults[1].attempts[1].because).toBe("yxc could not send it");
  });

  it("replaces every name the trail carries — a YNCA line, a whole XML body, MusicCast answers, a written name", () => {
    const content = diagnosticsExport(input({ trail: offlineTrail().snapshot() })).content;
    for (const secret of ["Kinderzimmer", "Wohnzimmer", "Haus Krobath", "KrobiNet", "Terrasse", "00A0DED4F504"]) {
      expect(content, secret).not.toContain(secret);
    }
    // The XML body stands whole, its name replaced in place.
    expect(content).toMatch(/<Zone>name-\d+<\/Zone>/);
  });

  it("a device connected now has no 'disconnected since', and a report without a trail has empty lists", () => {
    const connected = buildDiagnosticsReport(
      input({ device: { ...input().device, connected: true }, trail: offlineTrail().snapshot() }),
    ) as { trail: { disconnectedSince: unknown } };
    expect(connected.trail.disconnectedSince).toBeNull();
    const none = buildDiagnosticsReport(input()) as { trail: Record<string, unknown> };
    expect(none.trail).toEqual({
      disconnectedSince: null,
      lastReasonPerTransport: {},
      connectionHistory: [],
      commandResults: [],
      traffic: { ynca: [], musiccast: [], xml: [], events: [] },
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandGateClosedError } from "../lifecycle/command-gate";
import { HttpStatusError } from "../util";
import { YxcRefusalError, YxcTransportError } from "../yxc/http-client";
import { captureXml, captureYnca, captureYxc } from "./device-capture";

/** A device of the object inventory — real, scrubbed device answers. */
interface Fixture {
  ynca?: { answers: Record<string, string> };
  yxc?: { answers: Record<string, unknown> };
  xml?: { answers: Record<string, string>; descriptor?: string | null };
}

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(__dirname, "../../../test/fixtures/inventory", `${name}.json`), "utf8"),
  ) as Fixture;
}

/**
 * A YNCA device answering from a capture: a value for what it knows, `@UNDEFINED` for the rest.
 *
 * @param answers the capture
 */
function yncaDevice(answers: Record<string, string>): {
  asked: string[];
  capture(gets: ReadonlyArray<{ subunit: string; func: string }>): Promise<{ lines: string[]; complete: boolean }>;
} {
  const asked: string[] = [];
  return {
    asked,
    capture(gets) {
      const lines = gets.map(get => {
        const key = `${get.subunit}:${get.func}`;
        asked.push(key);
        return key in answers ? `@${key}=${answers[key]}` : "@UNDEFINED";
      });
      return Promise.resolve({ lines, complete: true });
    },
  };
}

describe("captureYnca", () => {
  it("reads only the subunits that answer AVAIL, plus SYS, and keeps every line verbatim", async () => {
    const answers = fixture("rxv6a").ynca!.answers;
    const device = yncaDevice(answers);
    const capture = await captureYnca(device);
    expect(capture.transport).toBe("ynca");
    expect(capture.complete).toBe(true);
    // The fixture's own answers come back under the fixture's own keys.
    expect(capture.answers["MAIN:PWR"]).toBe(answers["MAIN:PWR"]);
    expect(capture.answers["SYS:MODELNAME"]).toBe(answers["SYS:MODELNAME"]);
    // A subunit that did not answer AVAIL is not swept.
    const present = new Set(
      Object.keys(answers)
        .filter(k => k.endsWith(":AVAIL"))
        .map(k => k.split(":")[0]),
    );
    const swept = device.asked.filter(k => !k.endsWith(":AVAIL")).map(k => k.split(":")[0]);
    expect(swept.every(subunit => subunit === "SYS" || present.has(subunit))).toBe(true);
    expect(capture.lines).toContain("@UNDEFINED");
    expect(capture.unanswered!.length).toBeGreaterThan(0);
  });

  it("reads everything when no subunit answers AVAIL", async () => {
    const device = yncaDevice({ "SYS:MODELNAME": "RX-V473", "MAIN:PWR": "On" });
    const capture = await captureYnca(device);
    expect(device.asked.some(k => k.startsWith("ZONE4:"))).toBe(true);
    expect(capture.answers).toEqual({ "SYS:MODELNAME": "RX-V473", "MAIN:PWR": "On" });
  });

  it("marks a read that the connection ended as incomplete, and never throws", async () => {
    const capture = await captureYnca({ capture: () => Promise.reject(new Error("socket gone")) });
    expect(capture.complete).toBe(false);
    expect(capture.error).toContain("socket gone");
    // Every AVAIL question of the read that threw went unanswered.
    expect(capture.failed).toBe(capture.asked);
  });

  it("is complete with no failure when both reads reach their closing marker, refusals included", async () => {
    const capture = await captureYnca(yncaDevice(fixture("rxv473").ynca!.answers));
    expect(capture.complete).toBe(true);
    expect(capture.failed).toBe(0);
    expect(capture.error).toBeUndefined();
    // `@UNDEFINED` is the device's answer, not a lost one.
    expect(capture.unanswered!.length).toBeGreaterThan(0);
  });

  // Review 2026-10-05, B5: `complete` means the same on all three captures — a read whose closing marker never
  // came back did not run to its end, and what it got no value for is counted as failed.
  it("counts the functions of a read that did not reach its end as failed", async () => {
    const batches: string[][] = [];
    const capture = await captureYnca({
      capture(gets) {
        batches.push(gets.map(get => `${get.subunit}:${get.func}`));
        // The AVAIL probe ends normally; the sweep loses the connection after two answers.
        if (batches.length === 1) {
          return Promise.resolve({ lines: ["@MAIN:AVAIL=Ready"], complete: true });
        }
        return Promise.resolve({ lines: ["@SYS:MODELNAME=RX-V473", "@MAIN:PWR=On"], complete: false });
      },
    });
    expect(capture.complete).toBe(false);
    expect(capture.error).toContain("before the device confirmed its end");
    // The probe ran to its end: its unanswered subunits are refusals, not failures. Every function of the
    // cut sweep without a value is.
    const sweep = new Set(batches[1]);
    expect(sweep.has("SYS:MODELNAME") && sweep.has("MAIN:PWR")).toBe(true);
    expect(capture.failed).toBe(sweep.size - 2);
    expect(capture.asked).toBe(batches[0].length + batches[1].length);
  });
});

describe("captureYxc", () => {
  it("reads the device-wide and per-zone endpoints, keyed like the fixtures, and asks nothing that changes", async () => {
    const answers = fixture("rxv6a").yxc!.answers;
    const paths: string[] = [];
    const capture = await captureYxc({
      read(path) {
        paths.push(path);
        const key = path.replace(/^\//, "");
        return key in answers ? Promise.resolve(answers[key]) : Promise.reject(new YxcRefusalError(path, 5));
      },
    });
    expect(paths.every(path => /\/get[A-Z]/.test(path))).toBe(true);
    expect(capture.answers["system/getFeatures"]).toEqual(answers["system/getFeatures"]);
    expect(capture.answers["zone2/getStatus"]).toEqual(answers["zone2/getStatus"]);
    // A refusal is the device's own answer.
    expect(capture.answers["cd/getPlayInfo"]).toEqual({ response_code: 5 });
    expect(capture.complete).toBe(true);
  });

  it("reads the tuner presets per declared band, or the common list", async () => {
    const asked: string[] = [];
    await captureYxc({
      read(path) {
        asked.push(path);
        return Promise.resolve(
          path === "/system/getFeatures" ? { tuner: { func_list: ["am", "fm"], preset: { type: "separate" } } } : {},
        );
      },
    });
    expect(asked).toEqual(expect.arrayContaining(["/tuner/getPresetInfo?band=am", "/tuner/getPresetInfo?band=fm"]));
    expect(asked).not.toContain("/tuner/getPresetInfo?band=dab");
  });

  it("is incomplete when nothing answered", async () => {
    const capture = await captureYxc({ read: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(capture.complete).toBe(false);
    expect(capture.answers["system/getDeviceInfo"]).toEqual({ error: "ECONNREFUSED" });
  });

  // Review 2026-10-05, B5 (proof test misc/ring-and-complete): one answer used to make the read "complete".
  it("is incomplete when the device drops after the first answer, and stops asking a device that is gone", async () => {
    let n = 0;
    const capture = await captureYxc({
      read: path =>
        n++ === 0
          ? Promise.resolve({ response_code: 0 })
          : Promise.reject(new YxcTransportError(path, new Error("ECONNRESET"))),
    });
    expect(capture.complete).toBe(false);
    // Three failures in a row: the device is gone, the rest is not asked (each would wait for its timeout).
    expect(capture.asked).toBe(4);
    expect(capture.failed).toBe(3);
    expect(capture.error).toContain("ECONNRESET");
    // 13 device-wide reads and the main zone's 3 (getFeatures failed, so no zone list) were left out.
    expect(capture.error).toContain("the device stopped answering, 16 more question(s) not asked");
  });

  it("counts a refusal, an HTTP status and a body that is no JSON as the device's answer, a closed gate as a failure", async () => {
    const capture = await captureYxc({
      read(path) {
        if (path === "/system/getNetworkStatus") {
          return Promise.reject(new YxcRefusalError(path, 3));
        }
        if (path === "/system/getLocationInfo") {
          return Promise.reject(new HttpStatusError("device refused (HTTP 404)", 404));
        }
        if (path === "/system/getNameText") {
          return Promise.reject(new SyntaxError("Unexpected token <"));
        }
        if (path === "/cd/getPlayInfo") {
          return Promise.reject(new CommandGateClosedError());
        }
        return Promise.resolve({ response_code: 0 });
      },
    });
    expect(capture.answers["system/getNetworkStatus"]).toEqual({ response_code: 3 });
    expect(capture.answers["system/getLocationInfo"]).toEqual({ httpStatus: 404 });
    expect(capture.answers["system/getNameText"]).toEqual({ invalidBody: "Unexpected token <" });
    expect(capture.answers["cd/getPlayInfo"]).toEqual({ error: "command gate closed" });
    expect(capture.failed).toBe(1);
    expect(capture.complete).toBe(false);
  });

  it("reads the main zone when getFeatures declares its zones in a shape it should not (no throw)", async () => {
    const asked: string[] = [];
    const capture = await captureYxc({
      read(path) {
        asked.push(path);
        return Promise.resolve(path === "/system/getFeatures" ? { response_code: 0, zone: { id: "main" } } : {});
      },
    });
    expect(asked).toContain("/main/getStatus");
    expect(capture.complete).toBe(true);
    expect(capture.failed).toBe(0);
  });
});

describe("captureXml", () => {
  /**
   * An XML device answering from a capture by node path, RC=2 for an unknown node.
   *
   * @param xml the capture
   */
  function xmlDevice(xml: NonNullable<Fixture["xml"]>): { asked: string[]; client: Parameters<typeof captureXml>[0] } {
    const asked: string[] = [];
    return {
      asked,
      client: {
        // A model without a description answers 404 — the real client rejects with the device's status.
        getDescriptor: () =>
          xml.descriptor
            ? Promise.resolve(xml.descriptor)
            : Promise.reject(new HttpStatusError("device refused the request (HTTP 404)", 404)),
        getXml(element, inner) {
          const node = /^<([A-Za-z0-9_]+)>/.exec(inner)?.[1] ?? "";
          asked.push(`${element}/${node}`);
          return Promise.resolve(xml.answers[`${element}/${node}`] ?? `<YAMAHA_AV rsp="GET" RC="2"></YAMAHA_AV>`);
        },
      },
    };
  }

  it("follows the device's Feature_Existence and reads what the fixture holds", async () => {
    const xml = fixture("rxv6a").xml!;
    const device = xmlDevice(xml);
    const capture = await captureXml(device.client);
    for (const key of Object.keys(xml.answers)) {
      expect(capture.answers[key], key).toBe(xml.answers[key]);
    }
    // Zone_3 is declared absent — not asked.
    expect(device.asked.some(key => key.startsWith("Zone_3/"))).toBe(false);
    expect(capture.descriptor).toBeNull();
    // A missing description (404) and the RC=2 of an unknown node are the device's answers: nothing failed.
    expect(capture.complete).toBe(true);
    expect(capture.failed).toBe(0);
  });

  it("asks a 2008 receiver for the elements of its generation and keeps its description", async () => {
    const xml = fixture("rxv3900").xml!;
    const device = xmlDevice(xml);
    const capture = await captureXml(device.client);
    expect(capture.descriptor).toContain("RX-V3900");
    expect(capture.answers["NET_USB/List_Info_2"]).toBe(xml.answers["NET_USB/List_Info_2"]);
    expect(capture.answers["Main_Zone/Basic_Status"]).toBe(xml.answers["Main_Zone/Basic_Status"]);
    // Without Feature_Existence every zone is asked, as the adapter probes them — the RX-V3900 has a Zone 3.
    expect(device.asked).toEqual(expect.arrayContaining(["Zone_2/Basic_Status", "Zone_3/Basic_Status"]));
    // The 2008 zone name, where its description declares it (`Rename,Rename_Latin_1`) — the adapter's own read.
    expect(device.asked).toEqual(expect.arrayContaining(["Main_Zone/Rename", "Zone_2/Rename", "Zone_3/Rename"]));
    expect(device.asked).not.toContain("Zone_4/Rename");
  });

  it("reads the zones and sources the device declares, through the adapter's own System/Config parser", async () => {
    const config =
      '<YAMAHA_AV rsp="GET" RC="0"><System><Config><Feature_Existence><Main_Zone>1</Main_Zone><Zone_2>0</Zone_2>' +
      "<Zone_3>1</Zone_3><Zone_4>0</Zone_4><Tuner>1</Tuner><Spotify>1</Spotify><DAB>0</DAB></Feature_Existence>" +
      "</Config></System></YAMAHA_AV>";
    const device = xmlDevice({ answers: { "System/Config": config }, descriptor: null });
    await captureXml(device.client);
    expect(device.asked).toEqual(expect.arrayContaining(["Zone_3/Basic_Status", "Spotify/Play_Info"]));
    expect(device.asked.some(key => key.startsWith("Zone_2/") || key.startsWith("DAB/"))).toBe(false);
  });

  // Review 2026-10-05, B5: one answer used to make the read "complete".
  it("is incomplete when the device stops answering, says why, and does not wait out every question", async () => {
    let n = 0;
    const capture = await captureXml({
      getDescriptor: () => Promise.reject(new HttpStatusError("device refused (HTTP 404)", 404)),
      getXml: () =>
        n++ < 2
          ? Promise.resolve('<YAMAHA_AV rsp="GET" RC="0"></YAMAHA_AV>')
          : Promise.reject(new Error("XML request timeout")),
    });
    expect(capture.complete).toBe(false);
    expect(capture.failed).toBe(3);
    expect(capture.asked).toBe(1 + 2 + 3);
    expect(capture.error).toContain("XML request timeout");
    expect(capture.descriptor).toBeNull();
  });

  it("counts a description that could not be read for a transport reason as failed", async () => {
    const capture = await captureXml({
      getDescriptor: () => Promise.reject(new Error("socket hang up")),
      getXml: () => Promise.resolve('<YAMAHA_AV rsp="GET" RC="0"></YAMAHA_AV>'),
    });
    expect(capture.descriptor).toBeNull();
    expect(capture.failed).toBe(1);
    expect(capture.complete).toBe(false);
    expect(capture.error).toBe("socket hang up");
  });
});

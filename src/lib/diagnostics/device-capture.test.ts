import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { YxcRefusalError } from "../yxc/http-client";
import { captureXml, captureYnca, captureYxc, featureExistence } from "./device-capture";

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
        getDescriptor: () => (xml.descriptor ? Promise.resolve(xml.descriptor) : Promise.reject(new Error("HTTP 404"))),
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
  });

  it("asks a 2008 receiver for the elements of its generation and keeps its description", async () => {
    const xml = fixture("rxv3900").xml!;
    const capture = await captureXml(xmlDevice(xml).client);
    expect(capture.descriptor).toContain("RX-V3900");
    expect(capture.answers["NET_USB/List_Info_2"]).toBe(xml.answers["NET_USB/List_Info_2"]);
    expect(capture.answers["Main_Zone/Basic_Status"]).toBe(xml.answers["Main_Zone/Basic_Status"]);
  });

  it("reads the present elements from Feature_Existence", () => {
    expect([
      ...featureExistence(
        "<Feature_Existence><Main_Zone>1</Main_Zone><Zone_2>0</Zone_2><Tuner>1</Tuner></Feature_Existence>",
      ),
    ]).toEqual(["Main_Zone", "Tuner"]);
    expect(featureExistence(undefined).size).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandGate } from "../lifecycle/command-gate";
import { YncaClient, type YncaSocket } from "../ynca/ynca-client";
import { XmlClient } from "../xml/xml-client";
import { YamahaYxcClient } from "../yxc/http-client";
import { recordedXmlGetter, recordedXmlPoster, recordedYncaFactory, recordedYxcSend } from "./recorded-transports";
import { ENTRY_MAX_BYTES, TrafficRecorder } from "./traffic-recorder";

// Plan „Diagnosebericht“, Y1: the generations the inventory fixtures do not carry — YNCA 2010/11 (the PC subunit) and
// XML 2009–2017 (a device description with puts, RX-V675) — recorded at the seam the adapter wires, with the real
// clients on top.

const timers = {
  schedule: (handler: () => void, ms: number): ioBroker.Timeout =>
    setTimeout(handler, ms) as unknown as ioBroker.Timeout,
  cancel: (handle: ioBroker.Timeout | undefined): void => clearTimeout(handle as unknown as NodeJS.Timeout),
};
const gate = (): CommandGate => new CommandGate({ minSpacingMs: 0, timers });

/** A socket with its methods on the prototype — the wrapper must reach them by name. */
class ClassSocket implements YncaSocket {
  public written: Buffer[] = [];
  public destroyed = false;
  private data?: (chunk: Uint8Array | string) => void;
  private connected?: () => void;
  public write(data: string | Uint8Array): void {
    this.written.push(Buffer.from(data));
  }
  public destroy(): void {
    this.destroyed = true;
  }
  public onData(handler: (chunk: Uint8Array | string) => void): void {
    this.data = handler;
  }
  public onConnect(handler: () => void): void {
    this.connected = handler;
  }
  public onClose(): void {}
  public onError(): void {}
  public connect(): void {
    this.connected?.();
  }
  public emit(chunk: Uint8Array | string): void {
    this.data?.(chunk);
  }
}

describe("recorded seams", () => {
  test("YNCA 2010/11: every line sent and received, a character split across two packets decoded once", async () => {
    const recorder = new TrafficRecorder();
    const sockets: ClassSocket[] = [];
    const client = new YncaClient(
      "10.0.0.5",
      timers,
      gate(),
      recordedYncaFactory(() => {
        const socket = new ClassSocket();
        sockets.push(socket);
        return socket;
      }, recorder),
    );
    const connected = client.connect();
    sockets[0].connect();
    await connected;
    void client.get("PC", "AVAIL");
    await new Promise(resolve => setImmediate(resolve));
    // The 2010/11 generation's network subunit answers as PC; the zone name arrives in two packets, "ü" split.
    const zone = Buffer.from("@MAIN:ZONENAME=Küche\r\n", "utf8");
    const cut = zone.indexOf(0xc3) + 1;
    sockets[0].emit("@PC:AVAIL=Not Ready\r\n");
    sockets[0].emit(zone.subarray(0, cut));
    sockets[0].emit(zone.subarray(cut));
    expect(recorder.snapshot().traffic.ynca.map(entry => [entry.direction, entry.answer])).toEqual([
      ["sent", "@PC:AVAIL=?"],
      ["received", "@PC:AVAIL=Not Ready"],
      ["received", "@MAIN:ZONENAME=Küche"],
    ]);
    client.close();
    expect(sockets[0].destroyed).toBe(true);
  });

  test("XML 2009–2017: the request and its answer; the 132 KB device description only by its size, never cut", async () => {
    const recorder = new TrafficRecorder();
    const descriptor = readFileSync(join(__dirname, "../xml/__fixtures__/desc-rx-v675.xml"), "utf8");
    const config =
      '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Config><Name><Zone>Wohnzimmer</Zone></Name></Config></Main_Zone></YAMAHA_AV>';
    const client = new XmlClient(
      "10.0.0.6",
      recordedXmlPoster(() => Promise.resolve(config), recorder),
      gate(),
      recordedXmlGetter(() => Promise.resolve(descriptor), recorder),
    );
    await client.getDescriptor();
    await client.getXml("Main_Zone", "<Config>GetParam</Config>");
    const [desc, answer] = recorder.snapshot().traffic.xml;
    expect(desc).toMatchObject({ request: "GET /YamahaRemoteControl/desc.xml" });
    expect(desc.answer).toBeUndefined();
    expect(desc.omittedBytes).toBeGreaterThan(ENTRY_MAX_BYTES);
    expect(answer.request).toContain("<Config>GetParam</Config>");
    expect(answer.answer).toBe(config);
  });

  test("MusicCast and XML: a failure is recorded with its reason and still reaches the caller", async () => {
    const recorder = new TrafficRecorder();
    const yxc = new YamahaYxcClient(
      "10.0.0.7",
      recordedYxcSend(() => Promise.reject(new Error("connect ECONNREFUSED")), recorder),
      gate(),
    );
    await expect(yxc.getDeviceInfo()).rejects.toThrow("ECONNREFUSED");
    const xml = new XmlClient(
      "10.0.0.8",
      recordedXmlPoster(() => Promise.reject(new Error("socket hang up")), recorder),
      gate(),
    );
    await expect(xml.getXml("Main_Zone", "<Basic_Status>GetParam</Basic_Status>")).rejects.toThrow("hang up");
    const { traffic } = recorder.snapshot();
    expect(traffic.musiccast).toEqual([
      expect.objectContaining({ request: "/system/getDeviceInfo", error: "connect ECONNREFUSED" }),
    ]);
    expect(traffic.xml).toEqual([expect.objectContaining({ error: "socket hang up" })]);
  });
});

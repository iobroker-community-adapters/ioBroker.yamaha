import { describe, expect, test } from "vitest";
import { CommandGate } from "../lib/lifecycle/command-gate";
import { DISCOVERY_SCHEMA } from "../lib/lifecycle/discovery-schema";
import { ProbeMemory } from "../lib/lifecycle/probe-memory";
import { XmlDeviceController } from "../lib/xml/device-controller";
import { PushLiveness } from "../lib/yxc/push-liveness";
import { YxcDeviceController, type YxcClientLike } from "../lib/yxc/device-controller";

// Y-37 (krobi 2026-10-26 21:16 "then away with it and record it so", issue #632): the cover address (player.albumArt)
// is exactly the address the receiver reports; only a path without a host (/YamahaRemoteControl/…) gets the
// receiver's IP in front, as the spec requires (YXC Basic §7.2: "If xxx/yyy/zzz.jpg is returned, the absolute path is
// http://{host}/xxx/yyy/zzz.jpg"). The adapter never appends anything — no album art id, no query.

const HOST = "192.0.2.10";

/** The recorded RX-A2070 cover: the file name carries the number, the id is reported beside it. */
const NUMBERED = { url: "/YamahaRemoteControl/AlbumART/AlbumART5419.jpg", id: 5419 };
/** The specification's example (YXC Basic Rev 1.10 §7.2): one fixed path, the id beside it. */
const FIXED = { url: "/YamahaRemoteControl/AlbumART/AlbumART.jpg", id: 18 };
/** A service's own cover — a full address the receiver reports as it is. */
const SERVICE = "http://static.airable.io/43/13/186713.png";

const gate = (): CommandGate =>
  new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  });

const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

/**
 * The cover the MusicCast controller writes for a receiver whose network player reports the given cover.
 *
 * @param url the reported `albumart_url`
 * @param id the reported `albumart_id`
 * @returns the value written to player.albumArt
 */
async function musicCastCover(url: string, id?: number): Promise<unknown> {
  const answers: Record<string, unknown> = {
    getFeatures: { zone: [{ id: "main", func_list: ["power"], input_list: ["net_radio"] }], netusb: {} },
    getStatus: { power: "on", input: "net_radio" },
    getDeviceInfo: { model_name: "RX-A2070", api_version: 2.08 },
    getPlayInfo: {
      input: "net_radio",
      playback: "play",
      albumart_url: url,
      ...(id === undefined ? {} : { albumart_id: id }),
    },
  };
  // Every client method answers its canned reply or an empty success; `forUser` is the same client.
  const client: YxcClientLike = new Proxy({} as YxcClientLike, {
    get: (_target, prop: string) =>
      prop === "forUser" ? () => client : () => Promise.resolve(answers[prop] ?? { response_code: 0 }),
  });
  const acks: Array<{ id: string; value: unknown }> = [];
  const fire: { push?: (event: unknown) => void } = {};
  const controller = new YxcDeviceController("living", {
    client,
    clientFor: () => undefined,
    partnerIps: () => [],
    pushActive: () => true,
    gate: gate(),
    probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
    pushLiveness: new PushLiveness(),
    host: HOST,
    registerPush: onPush => {
      fire.push = onPush;
      return () => undefined;
    },
    scheduleKeepalive: () => () => undefined,
    upsertObject: () => Promise.resolve(),
    setStateAck: (stateId, value) => {
      acks.push({ id: stateId, value });
    },
    reportDeviceName: () => undefined,
    log,
  });
  await controller.start();
  acks.length = 0;
  fire.push?.({ netusb: { play_info_updated: true } });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.close();
  // Positive control: the play info was read and written, so the cover below is the one this path produced.
  expect(acks.some(a => a.id === "living.player.playback")).toBe(true);
  return acks.find(a => a.id === "living.player.albumArt")?.value;
}

/**
 * The cover the XML controller writes for a receiver whose NET RADIO source reports the given cover.
 *
 * @param url the reported `Album_ART` `URL`
 * @param id the reported `Album_ART` `ID`
 * @returns the value written to player.albumArt
 */
async function xmlCover(url: string, id: number): Promise<unknown> {
  const answers: Record<string, string> = {
    "Main_Zone|<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>":
      '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Input><Input_Sel_Item>' +
      "<Item_1><Param>NET RADIO</Param><RW>RW</RW><Title></Title><Src_Name>NET_RADIO</Src_Name><Src_Number>1</Src_Number></Item_1>" +
      "</Input_Sel_Item></Input></Main_Zone></YAMAHA_AV>",
    "NET_RADIO|<Play_Info>GetParam</Play_Info>":
      '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><Play_Info><Feature_Availability>Ready</Feature_Availability>' +
      "<Playback_Info>Play</Playback_Info><Meta_Info><Station>Radio</Station><Album></Album><Song>Blue</Song></Meta_Info>" +
      `<Album_ART><URL>${url}</URL><ID>${id}</ID><Format>JPEG</Format></Album_ART></Play_Info></NET_RADIO></YAMAHA_AV>`,
  };
  const acks: Array<{ id: string; value: unknown }> = [];
  const controller = new XmlDeviceController("living", {
    gate: gate(),
    probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
    client: {
      getStatus: (zone: string) => Promise.resolve(zone === "Main_Zone" ? { power: true, input: "NET RADIO" } : {}),
      getSystemConfig: () => Promise.resolve({}),
      getDescriptor: () => Promise.resolve(""),
      send: () => Promise.resolve(),
      getXml: (zone: string, inner: string) => Promise.resolve(answers[`${zone}|${inner}`] ?? ""),
    },
    scheduleKeepalive: () => () => undefined,
    upsertObject: () => Promise.resolve(),
    setStateAck: (stateId, value) => {
      acks.push({ id: stateId, value });
    },
    log,
    host: HOST,
  });
  await controller.start();
  controller.close();
  // Positive control: the source's play info was read, so the cover below is the one this path produced.
  expect(acks.some(a => a.id === "living.player.playback")).toBe(true);
  return acks.find(a => a.id === "living.player.albumArt")?.value;
}

describe("Y-37 the cover address is the one the receiver reports", () => {
  test("MusicCast: a path gets the receiver's IP in front and nothing appended", async () => {
    expect(await musicCastCover(NUMBERED.url, NUMBERED.id)).toBe(`http://${HOST}${NUMBERED.url}`);
    expect(await musicCastCover(FIXED.url, FIXED.id)).toBe(`http://${HOST}${FIXED.url}`);
  });

  test("MusicCast: a full address stays exactly as reported", async () => {
    expect(await musicCastCover(SERVICE, 7)).toBe(SERVICE);
  });

  test("XML: a path gets the receiver's IP in front and nothing appended", async () => {
    expect(await xmlCover(NUMBERED.url, NUMBERED.id)).toBe(`http://${HOST}${NUMBERED.url}`);
    expect(await xmlCover(FIXED.url, FIXED.id)).toBe(`http://${HOST}${FIXED.url}`);
  });

  test("XML: a full address stays exactly as reported", async () => {
    expect(await xmlCover(SERVICE, 7)).toBe(SERVICE);
  });
});

import { MEDIA_STATE } from "../catalog/media-state";
import { settle, xmlHarness } from "../../../test/helpers/xml-controller";

// Review 2026-10-05, A50: switching between two player sources left the old source's fields standing — the media
// server's artist, repeat and shuffle under a radio station.

const PLAY_INFO = "<Play_Info>GetParam</Play_Info>";
const INPUTS = "Main_Zone|<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>";
const inputList =
  '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Input><Input_Sel_Item>' +
  "<Item_1><Param>SERVER</Param><RW>RW</RW><Title></Title><Src_Name>SERVER</Src_Name><Src_Number>1</Src_Number></Item_1>" +
  "<Item_2><Param>NET RADIO</Param><RW>RW</RW><Title></Title><Src_Name>NET_RADIO</Src_Name><Src_Number>1</Src_Number></Item_2>" +
  "</Input_Sel_Item></Input></Main_Zone></YAMAHA_AV>";
const server =
  '<YAMAHA_AV rsp="GET" RC="0"><SERVER><Play_Info><Playback_Info>Play</Playback_Info><Play_Mode><Repeat>All</Repeat>' +
  "<Shuffle>On</Shuffle></Play_Mode><Meta_Info><Artist>Old Artist</Artist><Album>Old Album</Album><Song>Old Song</Song>" +
  "</Meta_Info></Play_Info></SERVER></YAMAHA_AV>";
const radio =
  '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><Play_Info><Playback_Info>Play</Playback_Info><Meta_Info>' +
  "<Station>New Station</Station><Album></Album><Song>New Song</Song></Meta_Info></Play_Info></NET_RADIO></YAMAHA_AV>";

describe("a zone that switches between two player sources (review 2026-10-05, A50)", () => {
  test("the fields the new source does not carry are cleared; the ones it carries show its values", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, input: "SERVER" } });
    h.client.xmlAnswers[INPUTS] = inputList;
    h.client.xmlAnswers[`SERVER|${PLAY_INFO}`] = server;
    h.client.xmlAnswers[`NET_RADIO|${PLAY_INFO}`] = radio;
    await h.controller.start();
    h.client.statuses.Main_Zone = { power: true, input: "NET RADIO" };
    h.acks.length = 0;
    h.poll();
    await settle(10);
    const last = (id: string): unknown => [...h.acks].reverse().find(ack => ack.id === `living.player.${id}`)?.value;
    expect(last("source")).toBe("NET RADIO");
    expect(last("playback")).toBe(MEDIA_STATE.play);
    expect(last("station")).toBe("New Station");
    expect(last("track")).toBe("New Song");
    expect(last("album")).toBe("");
    expect(last("artist")).toBe("");
    expect(last("repeat")).toBe(0);
    expect(last("shuffle")).toBe(false);
    // A field the new source carries is written once with its value, never cleared to "" first.
    expect(h.acks.filter(ack => ack.id === "living.player.track")).toEqual([
      { id: "living.player.track", value: "New Song" },
    ]);
  });

  test("the same source polled again clears nothing", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, input: "SERVER" } });
    h.client.xmlAnswers[INPUTS] = inputList;
    h.client.xmlAnswers[`SERVER|${PLAY_INFO}`] = server;
    await h.controller.start();
    h.acks.length = 0;
    h.poll();
    await settle(10);
    expect(h.acks.filter(ack => ack.id === "living.player.artist")).toEqual([
      { id: "living.player.artist", value: "Old Artist" },
    ]);
  });
});

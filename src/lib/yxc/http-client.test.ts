import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { YamahaYxcClient, YXC_SUBSCRIPTION_HEADERS } from "./http-client";

/**
 * Capture the command path each method builds, to verify URL construction against the
 * `yamaha-yxc-nodejs` source it replaces — no HTTP, no hardware. The exact strings here
 * are the paths that library's `yxc_api_cmd.js` built for each method.
 */
function capture(): { client: YamahaYxcClient; last: () => string } {
  let last = "";
  const client = new YamahaYxcClient("1.2.3.4", cmd => {
    last = cmd;
    return Promise.resolve({});
  });
  return { client, last: () => last };
}

describe("YamahaYxcClient URL construction", () => {
  test("builds each command path exactly as the replaced library did", async () => {
    const { client, last } = capture();
    await client.getFeatures();
    expect(last()).toBe("/system/getFeatures");
    await client.getStatus("main");
    expect(last()).toBe("/main/getStatus");
    await client.getStatus("zone2");
    expect(last()).toBe("/zone2/getStatus");
    await client.getPlayInfo();
    expect(last()).toBe("/netusb/getPlayInfo");
    await client.getPlayInfo("cd");
    expect(last()).toBe("/cd/getPlayInfo");
    await client.getPlayInfo("tuner");
    expect(last()).toBe("/tuner/getPlayInfo");
    await client.power(true, "main");
    expect(last()).toBe("/main/setPower?power=on");
    await client.power(false, "main");
    expect(last()).toBe("/main/setPower?power=standby");
    await client.setVolumeTo(120, "zone2");
    expect(last()).toBe("/zone2/setVolume?volume=120");
    await client.mute(true, "main");
    expect(last()).toBe("/main/setMute?enable=true");
    await client.mute(false, "main");
    expect(last()).toBe("/main/setMute?enable=false");
    await client.setInput("hdmi1", "main");
    expect(last()).toBe("/main/setInput?input=hdmi1");
    await client.setSound("stereo", "main");
    expect(last()).toBe("/main/setSoundProgram?program=stereo");
    await client.setEnhancer(true, "main");
    expect(last()).toBe("/main/setEnhancer?enable=true");
    await client.setPureDirect(false, "main");
    expect(last()).toBe("/main/setPureDirect?enable=false");
    await client.setSubwooferVolumeTo(5, "main");
    expect(last()).toBe("/main/setSubwooferVolume?volume=5");
    await client.setBassTo(3, "main");
    expect(last()).toBe("/main/setToneControl?mode=manual&bass=3");
    await client.setTrebleTo(-2, "main");
    expect(last()).toBe("/main/setToneControl?mode=manual&treble=-2");
    await client.sleep(30, "main");
    expect(last()).toBe("/main/setSleep?sleep=30");
    await client.setDirect(true, "main");
    expect(last()).toBe("/main/setDirect?enable=true");
    await client.setClearVoice(false, "main");
    expect(last()).toBe("/main/setClearVoice?enable=false");
    await client.setBassExtension(true, "main");
    expect(last()).toBe("/main/setBassExtension?enable=true");
    await client.setBalance(-10, "main");
    expect(last()).toBe("/main/setBalance?value=-10");
    await client.playNet();
    expect(last()).toBe("/netusb/setPlayback?playback=play");
    await client.pauseNet();
    expect(last()).toBe("/netusb/setPlayback?playback=pause");
    await client.stopNet();
    expect(last()).toBe("/netusb/setPlayback?playback=stop");
    await client.nextNet();
    expect(last()).toBe("/netusb/setPlayback?playback=next");
    await client.prevNet();
    expect(last()).toBe("/netusb/setPlayback?playback=previous");
    await client.setCDPlayback("play");
    expect(last()).toBe("/cd/setPlayback?playback=play");
  });

  test("defaults an unspecified zone to main (getZone semantics)", async () => {
    const { client, last } = capture();
    await client.getStatus("");
    expect(last()).toBe("/main/getStatus");
  });

  test("builds the setEqualizer path with all three bands in one call", async () => {
    const { client, last } = capture();
    await client.setEqualizer(1, 2, 3, "main");
    expect(last()).toBe("/main/setEqualizer?mode=manual&low=1&mid=2&high=3");
  });

  test("builds the distribution paths, POSTing a JSON body for the info setters", async () => {
    let cmd = "";
    let body: string | undefined;
    const client = new YamahaYxcClient("1.2.3.4", (c, b) => {
      cmd = c;
      body = b;
      return Promise.resolve({});
    });
    await client.getDistributionInfo();
    expect(cmd).toBe("/dist/getDistributionInfo");
    await client.startDistribution(0);
    expect(cmd).toBe("/dist/startDistribution?num=0");
    await client.stopDistribution();
    expect(cmd).toBe("/dist/stopDistribution");
    await client.setClientInfo({ group_id: "g", zone: ["main"] });
    expect(cmd).toBe("/dist/setClientInfo");
    expect(body).toBe('{"group_id":"g","zone":["main"]}');
    await client.setServerInfo({ group_id: "g", zone: "main", type: "add", client_list: ["1.2.3.5"] });
    expect(cmd).toBe("/dist/setServerInfo");
    expect(body).toBe('{"group_id":"g","zone":"main","type":"add","client_list":["1.2.3.5"]}');
  });
});

/**
 * The real HTTP transport (no seam) against a local server — the reference test the
 * URL-only capture above cannot provide. The replaced `yamaha-yxc-nodejs` sent the
 * `X-AppName`/`X-AppPort` event-subscription headers with every request
 * (`yxc_api_cmd.js` SendReqToDevice); without them a MusicCast device never pushes
 * its UDP events, so this locks the headers onto both the GET and the POST path.
 */
describe("YamahaYxcClient real transport", () => {
  test("sends the event-subscription headers on GET and POST, as the replaced library did", async () => {
    const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      await client.getStatus("main");
      await client.setClientInfo({ group_id: "g", zone: ["main"] });
    } finally {
      server.close();
    }
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.headers["x-appname"]).toBe(YXC_SUBSCRIPTION_HEADERS["X-AppName"]);
      expect(request.headers["x-appport"]).toBe(YXC_SUBSCRIPTION_HEADERS["X-AppPort"]);
    }
  });
});

describe("YamahaYxcClient player and tuner commands", () => {
  test("builds the remaining command paths exactly as the replaced library did", async () => {
    const { client, last } = capture();
    // Each of these is a button in the object tree. A wrong path is a silent
    // no-op on the device — the state flips back and nothing happens.
    await client.toggleNetRepeat();
    expect(last()).toBe("/netusb/toggleRepeat");
    await client.toggleNetShuffle();
    expect(last()).toBe("/netusb/toggleShuffle");
    await client.toggleCDRepeat();
    expect(last()).toBe("/cd/toggleRepeat");
    await client.toggleCDShuffle();
    expect(last()).toBe("/cd/toggleShuffle");
    await client.toggleTray();
    expect(last()).toBe("/cd/toggleTray");
    await client.setBand("fm");
    expect(last()).toBe("/tuner/setBand?band=fm");
    await client.setFreq("fm", 87500);
    expect(last()).toBe("/tuner/setFreq?band=fm&num=87500");
    await client.setPartyMode(true);
    expect(last()).toBe("/system/setPartyMode?enable=true");
    await client.setPartyMode(false);
    expect(last()).toBe("/system/setPartyMode?enable=false");
    await client.recallPreset(3, "zone2");
    expect(last()).toBe("/netusb/recallPreset?zone=zone2&num=3");
    await client.recallPreset(1, "main");
    expect(last()).toBe("/netusb/recallPreset?zone=main&num=1");
  });
});

import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  isWriteCommand,
  requestTimeoutFor,
  YamahaYxcClient,
  YxcRefusalError,
  YxcTransportError,
  YXC_SUBSCRIPTION_HEADERS,
} from "./http-client";

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

  // A chunk that ends inside "Ä" turned "Die Ärzte" into "Die ��rzte" (audit 2026-09-24, C5).
  test("a multi-byte character split across two TCP chunks arrives intact", async () => {
    const body = Buffer.from(JSON.stringify({ response_code: 0, artist: "Die Ärzte – Schrei nach Liebe ♪" }), "utf8");
    const cut = body.indexOf(Buffer.from("Ä")) + 1;
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.write(body.subarray(0, cut));
      setTimeout(() => res.end(body.subarray(cut)), 20);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const info = (await new YamahaYxcClient(`127.0.0.1:${port}`).getPlayInfo()) as { artist?: string };
      expect(info.artist).toBe("Die Ärzte – Schrei nach Liebe ♪");
    } finally {
      server.close();
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
    // `tuning=direct` is mandatory for an absolute frequency — the reference library
    // (yamaha-yxc-nodejs yxc_api_cmd.js:1186) sends it, we used to drop it and the
    // device refused every frequency write.
    await client.setFreq("fm", 87500);
    expect(last()).toBe("/tuner/setFreq?band=fm&tuning=direct&num=87500");
    await client.setPartyMode(true);
    expect(last()).toBe("/system/setPartyMode?enable=true");
    await client.setPartyMode(false);
    expect(last()).toBe("/system/setPartyMode?enable=false");
    await client.recallPreset(3, "zone2");
    expect(last()).toBe("/netusb/recallPreset?zone=zone2&num=3");
    await client.recallPreset(1, "main");
    expect(last()).toBe("/netusb/recallPreset?zone=main&num=1");
    await client.getPresetInfo();
    expect(last()).toBe("/netusb/getPresetInfo");
    await client.getRecentInfo();
    expect(last()).toBe("/netusb/getRecentInfo");
    await client.recallRecentItem(2, "main");
    expect(last()).toBe("/netusb/recallRecentItem?zone=main&num=2");
    await client.getTunerPresetInfo("fm");
    expect(last()).toBe("/tuner/getPresetInfo?band=fm");
    await client.recallTunerPreset("common", 5, "main");
    expect(last()).toBe("/tuner/recallPreset?zone=main&band=common&num=5");
    await client.switchTunerPreset("next");
    expect(last()).toBe("/tuner/switchPreset?dir=next");
    await client.getClockSettings();
    expect(last()).toBe("/clock/getSettings");
  });

  // The setters of audit 2026-09-24 C8/C25, each against the URI its source writes: YXC Basic Rev 1.10
  // §4.23–4.27/§5.9/§5.13/§5.14/§5.16/§5.17, YXC Advanced §4.1–4.3/§5.6, and pyamaha's URI table
  // (as bundled in aiomusiccast) for the five no specification names.
  test("the setters added for C8/C25 reach the URI their source documents", async () => {
    const urls: string[] = [];
    const bodies: Array<string | undefined> = [];
    const client = new YamahaYxcClient("1.2.3.4", (cmd, body) => {
      urls.push(cmd);
      bodies.push(body);
      return Promise.resolve({});
    });
    await client.setDialogueLevel(2, "main");
    await client.setDialogueLift(3, "zone2");
    await client.set3dSurround(true, "main");
    await client.setToneMode("manual", "main");
    await client.setEqualizerMode("auto", "zone2");
    await client.setLinkControl("normal", "main");
    await client.setLinkAudioDelay("lip_sync", "main");
    await client.setLinkAudioQuality("compressed", "main");
    await client.setDtsDialogueControl(1, "main");
    await client.setExtraBass(false, "main");
    await client.setAdaptiveDrc(true, "main");
    await client.setSurroundDecoderType("dts_neo6_cinema", "main");
    await client.setDimmer(-1);
    await client.setSpeakerPattern(2);
    await client.setSpeakerA(true);
    await client.setSpeakerB(false);
    await client.setIrSensor(true);
    await client.setZoneBVolumeSync(false);
    await client.setGroupName("[Link] Living Room");
    expect(urls).toEqual([
      "/main/setDialogueLevel?value=2",
      "/zone2/setDialogueLift?value=3",
      "/main/set3dSurround?enable=true",
      "/main/setToneControl?mode=manual",
      "/zone2/setEqualizer?mode=auto",
      "/main/setLinkControl?control=normal",
      "/main/setLinkAudioDelay?delay=lip_sync",
      "/main/setLinkAudioQuality?mode=compressed",
      "/main/setDtsDialogueControl?num=1",
      "/main/setExtraBass?enable=false",
      "/main/setAdaptiveDrc?enable=true",
      "/main/setSurroundDecoderType?type=dts_neo6_cinema",
      "/system/setDimmer?value=-1",
      "/system/setSpeakerPattern?num=2",
      "/system/setSpeakerA?enable=true",
      "/system/setSpeakerB?enable=false",
      "/system/setIrSensor?enable=true",
      "/system/setZoneBVolumeSync?enable=false",
      "/dist/setGroupName",
    ]);
    // setGroupName is a POST with the name as JSON (YXC Advanced §5.6); every other one a GET.
    expect(bodies.at(-1)).toBe(JSON.stringify({ name: "[Link] Living Room" }));
    expect(bodies.slice(0, -1).every(body => body === undefined)).toBe(true);
  });

  test("the six read endpoints that had no URL test at all", async () => {
    // These had no assertion of any kind — and MusicCast is the transport nobody here can
    // check against hardware, so a typo would surface only at a user's device. The gap was
    // not theoretical: `setFreq` above was missing its mandatory `tuning` parameter, and the
    // one test it did have asserted the broken URL, because it had been written from the
    // implementation instead of from the reference library.
    const { client, last } = capture();
    await client.getDeviceInfo();
    expect(last()).toBe("/system/getDeviceInfo");
    // Deliberately WITHOUT `?id=`: only the whole-device form answers with the `zone_list`
    // the device name is read from. (The bundled library always passes a zone id — this is
    // our own shape, and `zoneNameFrom` depends on it.)
    await client.getNameText();
    expect(last()).toBe("/system/getNameText");
    await client.getListInfo("net_radio", 8);
    expect(last()).toBe("/netusb/getListInfo?input=net_radio&index=8&size=8");
    await client.getSignalInfo("main");
    expect(last()).toBe("/main/getSignalInfo");
    await client.getMcPlaylistName();
    expect(last()).toBe("/netusb/getMcPlaylistName");
    await client.getPlayQueue();
    expect(last()).toBe("/netusb/getPlayQueue?index=0&size=8");
  });

  test("a device refusal (response_code != 0) becomes an error, not a silent success", async () => {
    // Without this the keepalive counted a refusing device as healthy — its states froze
    // instead of the device being reconnected — and a rejected write warned nobody.
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ response_code: 5 }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      const refusal = client.getStatus("main");
      // The code carries its meaning from the specification's table (audit 2026-09-24, C23).
      await expect(refusal).rejects.toThrow("device refused /main/getStatus (response_code 5: Guarded)");
      await expect(refusal).rejects.toBeInstanceOf(YxcRefusalError);
      await expect(refusal).rejects.toMatchObject({ code: 5 });
    } finally {
      server.close();
    }
  });

  // getListInfo may take up to 30 s and blocks every other command meanwhile (YXC Basic Rev 1.10
  // §13.1.6); cut at 4 s it counted as "no answer" (audit 2026-09-24, C26).
  test("a list request gets 30 s, every other request 4 s", () => {
    expect(requestTimeoutFor("/netusb/getListInfo?input=usb&index=0&size=8")).toBe(30_000);
    expect(requestTimeoutFor("/main/getStatus")).toBe(4000);
  });

  test("a list answer that takes longer than 4 s still arrives", { timeout: 15_000 }, async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ response_code: 0, menu_layer: 0, list_info: [] }));
      }, 4300);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      await expect(client.getListInfo("usb", 0)).resolves.toMatchObject({ menu_layer: 0 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("a successful answer (response_code 0) passes through untouched", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ response_code: 0, power: "on" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      await expect(client.getStatus("main")).resolves.toEqual({ response_code: 0, power: "on" });
    } finally {
      server.close();
    }
  });

  test("percent-encodes values so a name with a space or & cannot break the request", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      await client.setSound("Hall in Munich", "main");
      await client.setInput("AV & Audio", "main");
    } finally {
      server.close();
    }
    expect(seen[0]).toContain("program=Hall%20in%20Munich");
    // The `&` must be encoded, or it would smuggle a second query parameter in.
    expect(seen[1]).toContain("input=AV%20%26%20Audio");
  });
});

describe("gate priority classification", () => {
  test("every action verb the endpoints use counts as a WRITE (user priority at the gate)", () => {
    // A verb missing here demotes its button press to background priority — the
    // press then waits behind a running sweep instead of overtaking it (the 2.0.0
    // pre-release audit caught control/switch missing).
    for (const path of [
      "/main/setPower?power=on",
      "/main/recallScene?num=1",
      "/netusb/toggleRepeat",
      "/netusb/startAutoPlay",
      "/netusb/stopAutoPlay",
      "/netusb/managePlay?type=add_track",
      "/netusb/setListControl?type=play",
      "/dist/prepareDistribution",
      "/main/controlCursor?cursor=up",
      "/main/controlMenu?menu=home",
      "/tuner/switchPreset?dir=next",
    ]) {
      expect(isWriteCommand(path), path).toBe(true);
    }
    for (const path of ["/system/getFeatures", "/main/getStatus", "/netusb/getPlayInfo"]) {
      expect(isWriteCommand(path), path).toBe(false);
    }
  });
});

describe("YamahaYxcClient transport failures (audit 2026-09-15)", () => {
  test("a connection nobody answers is a transport error, not a device refusal", async () => {
    // Bind a port, then close it: whatever the OS hands out is refused from then on.
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, "close");
    const client = new YamahaYxcClient(`127.0.0.1:${port}`);
    const failure = await client.getStatus("main").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(YxcTransportError);
    expect((failure as YxcTransportError).message).toContain("/main/getStatus");
    expect((failure as YxcTransportError).cause).toBeInstanceOf(Error);
  });

  test("a device refusal stays an ordinary error — the device answered, it just said no", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ response_code: 3 }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      const failure = await client.getStatus("main").catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(YxcTransportError);
      expect((failure as Error).message).toContain("response_code 3");
    } finally {
      server.close();
    }
  });
});

describe("YamahaYxcClient body cap (audit 2026-09-02)", () => {
  test("rejects a body that streams past the size cap instead of buffering it", async () => {
    // The largest real answer (getFeatures) is a few KB. Whatever answers on that address
    // with megabytes is not a Yamaha — and an uncapped buffer grows the process without bound.
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.write("[");
      const chunk = `${"1".repeat(64 * 1024)},`;
      for (let i = 0; i < 20; i++) {
        res.write(chunk);
      }
      res.end("1]");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const client = new YamahaYxcClient(`127.0.0.1:${port}`);
      await expect(client.getStatus("main")).rejects.toThrow(/too large/);
    } finally {
      server.close();
    }
  });
});

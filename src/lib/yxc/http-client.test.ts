import { YamahaYxcClient } from "./http-client";

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
});

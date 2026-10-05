import { YxcPlayerRouting } from "./player-routing";
import type { YxcClientLike } from "./client-contract";
import type { DeviceValue } from "../types";

/**
 * A routing over the given zones and media blocks, recording what it writes.
 *
 * @param zones the device's zones
 * @param media the device's media blocks
 * @returns the routing and its writes
 */
function routing(
  zones: string[] = ["main", "zone2"],
  media: string[] = ["netusb", "cd"],
): { routing: YxcPlayerRouting; writes: Array<{ id: string; value: DeviceValue }> } {
  const writes: Array<{ id: string; value: DeviceValue }> = [];
  return {
    routing: new YxcPlayerRouting({
      zones: () => zones,
      media: () => media,
      emit: (id, value) => void writes.push({ id, value }),
    }),
    writes,
  };
}

/**
 * A client that records the calls a player call makes.
 *
 * @returns the client and its calls
 */
function recorder(): { client: YxcClientLike; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]): Promise<unknown> => {
          calls.push({ method, args });
          return Promise.resolve({ response_code: 0 });
        },
    },
  ) as YxcClientLike;
  return { client, calls };
}

describe("YxcPlayerRouting", () => {
  test("a zone plays the disc on the cd input, the network player only on the network player's source", () => {
    const { routing: r } = routing();
    expect(r.blockFor("cd")).toBe("cd");
    expect(r.blockFor("net_radio")).toBeUndefined();
    r.notePlayInfo("netusb", { input: "net_radio" });
    expect(r.blockFor("net_radio")).toBe("netusb");
    expect(r.blockFor("hdmi1")).toBeUndefined();
    expect(r.blockFor("")).toBeUndefined();
    // A device without the block: nothing plays it.
    expect(routing(["main"], ["tuner"]).routing.blockFor("cd")).toBeUndefined();
  });

  test("the play info goes to the listening zones only; leaving the source clears the block once", () => {
    const { routing: r, writes } = routing();
    r.noteInput("main", "hdmi1");
    r.noteInput("zone2", "net_radio");
    r.notePlayInfo("netusb", { input: "net_radio" });
    r.route("netusb", [{ id: "player.artist", value: "BBC" }]);
    expect(writes).toEqual([{ id: "multiroom.zone2.player.artist", value: "BBC" }]);
    writes.length = 0;
    r.noteInput("zone2", "hdmi1");
    expect(r.retarget("zone2")).toBeUndefined();
    expect(writes).toContainEqual({ id: "multiroom.zone2.player.artist", value: "" });
    writes.length = 0;
    expect(r.retarget("zone2")).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("a zone joining a source is told to read it; the drive's own extras are written once, unprefixed", () => {
    const { routing: r, writes } = routing();
    r.noteInput("main", "cd");
    expect(r.retarget("main")).toBe("cd");
    r.route("cd", [
      { id: "player.track", value: "T1" },
      { id: "player.cd.deviceStatus", value: "ready" },
    ]);
    expect(writes).toEqual([
      { id: "player.track", value: "T1" },
      { id: "player.cd.deviceStatus", value: "ready" },
    ]);
  });

  test("the idle zones get the cleared block — only on a device with a media player", () => {
    const { routing: r, writes } = routing();
    r.noteInput("main", "cd");
    r.route("cd", []);
    r.clearIdle();
    expect(writes.some(write => write.id.startsWith("player."))).toBe(false);
    expect(writes).toContainEqual({ id: "multiroom.zone2.player.source", value: "" });
    const tunerOnly = routing(["main"], ["tuner"]);
    tunerOnly.routing.clearIdle();
    expect(tunerOnly.writes).toEqual([]);
  });

  test("a recall goes to the zone listening to its source, main first, main as the fallback", () => {
    const { routing: r } = routing(["main", "zone2", "zone3"]);
    r.noteInput("main", "hdmi1");
    r.noteInput("zone2", "hdmi1");
    r.noteInput("zone3", "net_radio");
    expect(r.recallZone("net_radio")).toBe("zone3");
    expect(r.recallZone("tuner")).toBe("main");
    expect(r.recallZone("")).toBe("main");
    r.noteInput("main", "net_radio");
    expect(r.recallZone("net_radio")).toBe("main");
  });

  // Zone 2 in standby still reports the net_radio it was left on: the favourite went into a zone nobody listens
  // to (review 2026-10-05, A45).
  test("a zone in standby listens to nothing — the recall goes to a switched-on zone, or to main", () => {
    const { routing: r } = routing(["main", "zone2", "zone3"]);
    r.noteInput("main", "hdmi1");
    r.noteInput("zone2", "net_radio");
    r.notePower("zone2", false);
    expect(r.recallZone("net_radio")).toBe("main");
    r.noteInput("zone3", "net_radio");
    r.notePower("zone3", true);
    expect(r.recallZone("net_radio")).toBe("zone3");
    r.notePower("zone2", true);
    expect(r.recallZone("net_radio")).toBe("zone2");
    r.noteInput("main", "net_radio");
    r.notePower("main", false);
    expect(r.recallZone("net_radio")).toBe("zone2");
  });

  test("a source is audible while it plays to a switched-on zone (review 2026-10-05, A17)", () => {
    const { routing: r } = routing();
    r.noteInput("main", "net_radio");
    r.notePlayInfo("netusb", { input: "net_radio", playback: "play" });
    expect(r.audible()).toEqual([]); // no zone fed yet
    r.route("netusb", []);
    expect(r.audible()).toEqual(["netusb"]);
    expect(r.printOf("netusb")).toBe(JSON.stringify({ input: "net_radio", playback: "play" }));
    r.notePower("main", false);
    expect(r.audible()).toEqual([]);
    r.notePower("main", true);
    r.notePlayInfo("netusb", { input: "net_radio", playback: "pause" });
    expect(r.audible()).toEqual([]);
  });

  test("a transport key goes to the source the zone plays; without one nothing is sent", async () => {
    const { routing: r } = routing();
    r.notePlayInfo("netusb", { input: "spotify" });
    r.noteInput("main", "spotify");
    const { client, calls } = recorder();
    for (const action of ["prev", "repeatToggle", "shuffleToggle"] as const) {
      const call = r.transport("main", action);
      expect("run" in call && call.player).toBe("netusb");
      if ("run" in call) {
        await call.run(client);
      }
    }
    expect(calls).toEqual([
      { method: "setPlayback", args: ["netusb", "previous"] },
      { method: "toggleRepeat", args: ["netusb"] },
      { method: "toggleShuffle", args: ["netusb"] },
    ]);
    expect(r.transport("zone2", "play")).toEqual({ notSent: "zone2 is not playing a media source" });
  });

  test("repeat and shuffle are set directly on the network player from API 1.19 only", async () => {
    const { routing: r } = routing();
    r.notePlayInfo("netusb", { input: "net_radio" });
    r.noteInput("main", "net_radio");
    r.noteInput("zone2", "cd");
    const { client, calls } = recorder();
    const call = r.mode("main", 2.08, { repeat: "all" });
    if ("run" in call) {
      await call.run(client);
    }
    expect(calls).toEqual([{ method: "setNetRepeat", args: ["all"] }]);
    expect("notSent" in r.mode("main", 1.17, { shuffle: "on" })).toBe(true);
    expect("notSent" in r.mode("main", undefined, { shuffle: "on" })).toBe(true);
    expect("notSent" in r.mode("zone2", 2.08, { shuffle: "on" })).toBe(true);
  });
});

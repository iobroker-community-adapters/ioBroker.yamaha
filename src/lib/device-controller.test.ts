import { YncaDeviceController } from "./device-controller";
import type { YncaClientLike } from "./device-controller";
import type { YncaCapabilities } from "./ynca/capability";
import type { ObjectDef } from "./catalog/types";
import { createSubunitCache } from "./ynca/subunit-cache";
import { CommandGate } from "./lifecycle/command-gate";
import { ProbeMemory } from "./lifecycle/probe-memory";

/** A real command gate for the controller under test (pacing has its own suite). */
const testGate = (): CommandGate =>
  new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  });

interface Msg {
  subunit: string;
  func: string;
  value: string;
}

class FakeClient implements YncaClientLike {
  public sent: Msg[] = [];
  public closed = false;
  public keepaliveStarted = false;
  public capabilities: YncaCapabilities = { model: "", subunits: {} };
  /**
   * When set, an AVAIL-only request list (the probe pass) is answered with exactly
   * these subunits; unset, every readCapabilities call returns `capabilities`
   * (adequate for the tests that predate the two-pass sweep).
   */
  public availableSubunits?: string[];
  /**
   * When set, a LISTINFO-only request list (the browse probe, #613) is answered with list
   * fields for exactly these subunits — every other one stays silent, as a real receiver
   * does with `@UNDEFINED`. Unset, the probe falls through to `capabilities`.
   */
  public listSubunits?: string[];
  /** Every readCapabilities request list, for asserting what was actually swept. */
  public requests: Array<Array<{ subunit: string; func: string }>> = [];
  private handler?: (message: Msg) => void;

  public async connect(): Promise<void> {}
  public readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities> {
    this.requests.push(gets);
    if (this.availableSubunits && gets.length > 0 && gets.every(get => get.func === "AVAIL")) {
      const subunits: Record<string, Record<string, string>> = {};
      for (const subunit of this.availableSubunits) {
        subunits[subunit] = { AVAIL: "Ready" };
      }
      return Promise.resolve({ model: "", subunits });
    }
    if (this.listSubunits && gets.length > 0 && gets.every(get => get.func === "LISTINFO")) {
      const subunits: Record<string, Record<string, string>> = {};
      for (const subunit of this.listSubunits) {
        subunits[subunit] = { LISTLAYER: "1", LISTLAYERNAME: "Root", CURRLINE: "1", MAXLINE: "2" };
      }
      return Promise.resolve({ model: "", subunits });
    }
    return Promise.resolve(this.capabilities);
  }
  public send(subunit: string, func: string, value: string): void {
    this.sent.push({ subunit, func, value });
  }
  public get(subunit: string, func: string): void {
    this.gets.push({ subunit, func });
  }
  public gets: Array<{ subunit: string; func: string }> = [];
  public onMessage(handler: (message: Msg) => void): void {
    this.handler = handler;
  }
  public onDrop(): void {}
  /** Optional like the contract — replaced per test to capture the registered handler. */
  public onRefusal?: (handler: (command: string, verdict: "restricted" | "undefined") => void) => void;
  public startKeepalive(): void {
    this.keepaliveStarted = true;
  }
  public close(): void {
    this.closed = true;
  }
  public emit(message: Msg): void {
    this.handler?.(message);
  }
}

function makeDeps(client: FakeClient): {
  created: string[];
  objects: Array<{ id: string; def: ObjectDef }>;
  acked: Array<{ id: string; value: unknown }>;
  deps: ConstructorParameters<typeof YncaDeviceController>[1];
} {
  const created: string[] = [];
  const objects: Array<{ id: string; def: ObjectDef }> = [];
  const acked: Array<{ id: string; value: unknown }> = [];
  return {
    created,
    objects,
    acked,
    deps: {
      client,
      upsertObject: (id: string, def: ObjectDef) => {
        created.push(id);
        objects.push({ id, def });
        return Promise.resolve();
      },
      setStateAck: (id: string, value: boolean | number | string) => {
        acked.push({ id, value });
      },
      log: { debug() {}, info() {}, warn() {} },
    },
  };
}

describe("YncaDeviceController", () => {
  test("start arms the keepalive once, after the sweep", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX", subunits: { MAIN: { PWR: "On" } } };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("dev", deps);
    expect(client.keepaliveStarted).toBe(false);
    await controller.start();
    expect(client.keepaliveStarted).toBe(true);
  });

  test("start creates the object tree from the swept capabilities", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX-A810", subunits: { MAIN: { PWR: "On", VOL: "-30.0" } } };
    const { created, deps } = makeDeps(client);
    const ok = await new YncaDeviceController("living", deps).start();
    expect(ok).toBe(true);
    expect(created).toContain("living.power");
    expect(created).toContain("living.volume");
  });

  test("start seeds the states with the values read during the init sweep", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX-A810", subunits: { MAIN: { PWR: "On", VOL: "-30.0", MUTE: "Off" } } };
    const { acked, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    expect(acked).toContainEqual({ id: "living.power", value: true });
    expect(acked).toContainEqual({ id: "living.volume", value: -30 });
    expect(acked).toContainEqual({ id: "living.mute", value: false });
  });

  test("start seeds info.model from SYS:MODELNAME exactly once", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX-V6A", subunits: { SYS: { MODELNAME: "RX-V6A" }, MAIN: { PWR: "On" } } };
    const { created, acked, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    expect(created).toContain("living.info.model");
    expect(acked.filter(a => a.id === "living.info.model").map(a => a.value)).toEqual(["RX-V6A"]);
  });

  test("start creates nothing and returns false when no capabilities come back", async () => {
    const client = new FakeClient();
    const { created, deps } = makeDeps(client);
    const ok = await new YncaDeviceController("living", deps).start();
    expect(ok).toBe(false);
    expect(created).toEqual([]);
  });

  test("creates a channel before its child states", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "X", subunits: { MAIN: { PWR: "On" }, ZONE2: { PWR: "On" } } };
    const { created, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    expect(created.indexOf("living.multiroom.zone2")).toBeLessThan(created.indexOf("living.multiroom.zone2.power"));
  });

  test("a device push updates the matching state with an ack", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "X", subunits: { MAIN: { PWR: "Standby" } } };
    const { acked, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    client.emit({ subunit: "MAIN", func: "PWR", value: "On" });
    expect(acked).toContainEqual({ id: "living.power", value: true });
  });

  test("a user write (ack false) is sent to the device", () => {
    const client = new FakeClient();
    new YncaDeviceController("living", makeDeps(client).deps).handleStateChange("living.power", false, true);
    expect(client.sent).toEqual([{ subunit: "MAIN", func: "PWR", value: "On" }]);
  });

  test("an acked change (device echo) is not sent back", () => {
    const client = new FakeClient();
    new YncaDeviceController("living", makeDeps(client).deps).handleStateChange("living.power", true, true);
    expect(client.sent).toEqual([]);
  });

  test("close closes the client", () => {
    const client = new FakeClient();
    const controller = new YncaDeviceController("living", makeDeps(client).deps);
    controller.close();
    expect(client.closed).toBe(true);
  });
});

describe("YncaDeviceController two-pass sweep", () => {
  test("probes AVAIL first, then sweeps only the answering subunits plus SYS", async () => {
    const client = new FakeClient();
    client.availableSubunits = ["MAIN", "TUN"];
    client.capabilities = { model: "RX", subunits: { MAIN: { PWR: "On" }, TUN: { BAND: "FM" } } };
    await new YncaDeviceController("living", makeDeps(client).deps).start();
    // Request 0 is the identity read (model + firmware) that keys every cached layer
    // and doubles as the fast path's liveness proof; then the probe, then the sweep.
    expect(client.requests).toHaveLength(3);
    expect(client.requests[0].map(get => get.func)).toEqual(["MODELNAME", "VERSION"]);
    expect(client.requests[1].every(get => get.func === "AVAIL")).toBe(true);
    // SYS answers no AVAIL and must never be probed…
    expect(client.requests[1].some(get => get.subunit === "SYS")).toBe(false);
    // …but is always part of the sweep; absent subunits (ZONE2, player sources) are not.
    const sweptSubunits = new Set(client.requests[2].map(get => get.subunit));
    expect(sweptSubunits.has("SYS")).toBe(true);
    expect(sweptSubunits.has("MAIN")).toBe(true);
    expect(sweptSubunits.has("TUN")).toBe(true);
    expect(sweptSubunits.has("ZONE2")).toBe(false);
    expect(sweptSubunits.has("SPOTIFY")).toBe(false);
  });

  test("a device that ignores AVAIL falls back to the full blind sweep (no feature loss)", async () => {
    const client = new FakeClient();
    client.availableSubunits = [];
    client.capabilities = { model: "RX", subunits: { MAIN: { PWR: "On" } } };
    await new YncaDeviceController("living", makeDeps(client).deps).start();
    const sweptSubunits = new Set(client.requests[1].map(get => get.subunit));
    // The blind sweep covers everything the catalog knows.
    expect(sweptSubunits.has("ZONE2")).toBe(true);
    expect(sweptSubunits.has("SPOTIFY")).toBe(true);
  });

  test("a valid cached probe result skips the AVAIL phase entirely", async () => {
    const client = new FakeClient();
    client.availableSubunits = ["MAIN"];
    client.capabilities = {
      model: "RX-V6A",
      subunits: { SYS: { MODELNAME: "RX-V6A", VERSION: "1.80" }, MAIN: { PWR: "On" } },
    };
    const persisted: unknown[] = [];
    const cache = createSubunitCache({ subunits: ["MAIN"], model: "RX-V6A", firmware: "1.80" }, s => persisted.push(s));
    const { deps } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps, subunitCache: cache }).start();
    // Two requests: the cheap identity check (model + firmware, ~0.2 s) and then the
    // targeted sweep. No AVAIL probe, no cache rewrite. Checking identity FIRST is what
    // keeps a stale cache from costing a wasted full sweep before the mismatch shows.
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0].map(get => get.func)).toEqual(["MODELNAME", "VERSION"]);
    expect(client.requests[1].every(get => get.func !== "AVAIL")).toBe(true);
    expect(persisted).toEqual([]);
  });

  test("a stale cache (model/firmware changed) re-probes and stores the fresh result", async () => {
    const client = new FakeClient();
    client.availableSubunits = ["MAIN", "ZONE2"];
    client.capabilities = {
      model: "RX-A4A",
      subunits: { SYS: { MODELNAME: "RX-A4A", VERSION: "2.10" }, MAIN: { PWR: "On" } },
    };
    const persisted: unknown[] = [];
    const cache = createSubunitCache({ subunits: ["MAIN"], model: "RX-V6A", firmware: "1.80" }, s => persisted.push(s));
    const { deps } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps, subunitCache: cache }).start();
    // Stale targeted sweep, then probe, then fresh targeted sweep.
    expect(client.requests).toHaveLength(3);
    expect(client.requests[1].every(get => get.func === "AVAIL")).toBe(true);
    // clear() persisted undefined, then set() persisted the fresh snapshot.
    expect(persisted).toEqual([undefined, { subunits: ["MAIN", "ZONE2"], model: "RX-A4A", firmware: "2.10" }]);
  });

  test("a disabled datapoint group is excluded from the sweep AND the objects", async () => {
    const client = new FakeClient();
    client.availableSubunits = ["MAIN", "SPOTIFY"];
    client.capabilities = {
      model: "RX",
      subunits: { MAIN: { PWR: "On" }, SPOTIFY: { PLAYBACKINFO: "Stop" } },
    };
    const { created, deps } = makeDeps(client);
    await new YncaDeviceController("living", {
      ...deps,
      isEntryEnabled: id => !id.startsWith("player."),
    }).start();
    // SPOTIFY answered AVAIL, but with the player group off none of its functions are fetched…
    // (request 0 = identity, 1 = AVAIL probe, 2 = the sweep)
    const sweptSubunits = new Set(client.requests[2].map(get => get.subunit));
    expect(sweptSubunits.has("SPOTIFY")).toBe(false);
    // …and no player object is created.
    expect(created.some(id => id.includes("player"))).toBe(false);
    expect(created).toContain("living.power");
  });
});

describe("YncaDeviceController browse surface (#613)", () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  test("creates the browse tree when a browsable subunit answered and routes its writes", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { MAIN: { PWR: "On" }, NETRADIO: { PLAYBACKINFO: "Stop" } },
    };
    client.listSubunits = ["NETRADIO"];
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    expect(created).toContain("living.player.browse");
    expect(created).toContain("living.player.browse.line1");
    expect(created).toContain("living.player.browse.path");
    // A browse write reaches the driver, not the catalog: opening the source
    // switches the input and reads the list.
    controller.handleStateChange("living.player.browse.source", false, "netRadio");
    // The driver paces itself through the gate now, so give the queue a few turns.
    for (let i = 0; i < 6; i++) {
      await flush();
    }
    expect(client.sent).toContainEqual({ subunit: "MAIN", func: "INP", value: "NET RADIO" });
    expect(client.gets).toContainEqual({ subunit: "NETRADIO", func: "LISTINFO" });
  });

  test("creates the on-screen remote and puts a cursor key on MAIN", async () => {
    // The end-to-end path that matters: the pad is NOT a catalog entry (LISTCURSOR is
    // write-only and answers no sweep, so a catalog entry would never be "present" on a
    // real device). It is created by the browsing surface, and `left` — the key the 2012
    // generation needs to step back (#613) — has to leave on the MAIN subunit, the only
    // one whose LISTCURSOR declares Left and Right.
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { MAIN: { PWR: "On" }, NETRADIO: { PLAYBACKINFO: "Stop" } },
    };
    client.listSubunits = ["NETRADIO"];
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    expect(created).toContain("living.remote.cursor");
    expect(created).toContain("living.remote.menu");
    client.sent.length = 0;
    controller.handleStateChange("living.remote.cursor", false, "left");
    controller.handleStateChange("living.remote.menu", false, "top_menu");
    for (let i = 0; i < 6; i++) {
      await flush();
    }
    expect(client.sent).toContainEqual({ subunit: "MAIN", func: "LISTCURSOR", value: "Left" });
    expect(client.sent).toContainEqual({ subunit: "MAIN", func: "LISTMENU", value: "Top Menu" });
  });

  test("no browsable subunit means no remote pad either", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX", subunits: { MAIN: { PWR: "On" } } };
    client.listSubunits = [];
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    await new YncaDeviceController("living", deps).start();
    expect(created.some(id => id.includes("remote"))).toBe(false);
  });

  test("creates no browse tree without a browsable subunit", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX", subunits: { MAIN: { PWR: "On" } } };
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    await new YncaDeviceController("living", deps).start();
    expect(created.some(id => id.includes("player.browse"))).toBe(false);
  });

  test("creates no browse tree when the playback group is switched off", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { MAIN: { PWR: "On" }, NETRADIO: { PLAYBACKINFO: "Stop" } },
    };
    client.listSubunits = ["NETRADIO"];
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    deps.isEntryEnabled = (id: string): boolean => !id.startsWith("player.");
    await new YncaDeviceController("living", deps).start();
    expect(created.some(id => id.includes("player.browse"))).toBe(false);
  });

  test("claims no menus when the sources carry no lists — the RX-V473 case (#613)", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX-V473",
      subunits: { MAIN: { PWR: "On" }, NETRADIO: { PLAYBACKINFO: "Stop" }, SERVER: { PLAYBACKINFO: "Stop" } },
    };
    client.listSubunits = []; // the device answers @UNDEFINED to every LISTINFO
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    await new YncaDeviceController("living", deps).start();
    // No states at all — that is what lets the XML transport, which PROVED it can browse,
    // own the menus instead of being displaced by a higher-ranked but empty YNCA claim.
    expect(created.some(id => id.includes("player.browse"))).toBe(false);
    expect(client.requests.some(gets => gets.every(get => get.func === "LISTINFO"))).toBe(true);
  });

  test("offers only the sources that answered, not every source the device carries", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX-A810",
      subunits: { MAIN: { PWR: "On" }, NETRADIO: { PLAYBACKINFO: "Stop" }, SERVER: { PLAYBACKINFO: "Stop" } },
    };
    // Exactly what the RX-A810 reference log shows: NETRADIO serves menus, SERVER does not.
    client.listSubunits = ["NETRADIO"];
    const { created, objects, deps } = makeDeps(client);
    deps.gate = testGate();
    await new YncaDeviceController("living", deps).start();
    expect(created).toContain("living.player.browse.source");
    const source = objects.find(o => o.id === "living.player.browse.source");
    expect(Object.keys(source?.def.common?.states ?? {})).toEqual(["netRadio"]);
  });

  test("keeps the menus while the receiver sleeps instead of probing a standby device", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { MAIN: { PWR: "Standby" }, NETRADIO: { PLAYBACKINFO: "Stop" } },
    };
    client.listSubunits = []; // a sleeping receiver answers @RESTRICTED, not list data
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    await new YncaDeviceController("living", deps).start();
    // Probing a standby device would read "cannot browse" into a refusal that only means
    // "not right now", and strip the menus off a device that serves them once it is on.
    expect(created).toContain("living.player.browse.source");
    expect(client.requests.some(gets => gets.every(get => get.func === "LISTINFO"))).toBe(false);
  });

  test("a REMEMBERED standby does not skip the proof — the power is read live (#613 via the cache)", async () => {
    // The persisted layer holds the LAST run's values, and a receiver stands in standby
    // most of the time. Deciding the menu claim on that made YNCA claim player.browse.*
    // unproven on the first restart after the user switched the receiver on — displacing
    // the XML driver that does probe. That is #613, brought back in through the cache.
    const memory = new ProbeMemory({
      yncaCapabilities: {
        model: "RX-V473",
        firmware: "1.0",
        subunits: { MAIN: { PWR: "Standby" }, NETRADIO: { PLAYBACKINFO: "Stop" } },
      },
    });
    const client = new FakeClient();
    client.capabilities = {
      model: "RX-V473",
      // The device is ON now — and it cannot serve YNCA menus (the RX-V473 case).
      subunits: { SYS: { MODELNAME: "RX-V473", VERSION: "1.0" }, MAIN: { PWR: "On", INP: "NET RADIO" } },
    };
    client.listSubunits = [];
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    await new YncaDeviceController("living", { ...deps, probeMemory: memory }).start();
    // The probe ran (the live power said "On") and found nothing — so no claim, and the
    // XML transport keeps the menus it can actually serve.
    expect(client.requests.some(gets => gets.every(get => get.func === "LISTINFO"))).toBe(true);
    expect(created.some(id => id.includes("player.browse"))).toBe(false);
  });
});

describe("YncaDeviceController fast restart (persisted capability layer)", () => {
  const flushAsync = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  test("a playback time is published as seconds AND as readable text", async () => {
    // Both forms come from the one device answer: the seconds fill the media-player slot
    // (the type detector takes nothing else), the text is what a visualisation shows.
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: {
        SYS: { MODELNAME: "RX", VERSION: "1.0" },
        MAIN: { PWR: "On", INP: "NET RADIO" },
        NETRADIO: { PLAYBACKINFO: "Play", ELAPSEDTIME: "1:23", TOTALTIME: "1:02:03" },
      },
    };
    const { acked, deps } = makeDeps(client);
    await new YncaDeviceController("living", deps).start();
    expect(acked).toContainEqual({ id: "living.player.elapsedTime", value: 83 });
    expect(acked).toContainEqual({ id: "living.player.elapsedTimeText", value: "1:23" });
    expect(acked).toContainEqual({ id: "living.player.totalTime", value: 3723 });
    expect(acked).toContainEqual({ id: "living.player.totalTimeText", value: "1:02:03" });
  });

  test("a scene renamed at the receiver reaches the running session", async () => {
    // Scene titles are no datapoints any more, so nothing but this refresh carries them
    // into a running session: the fast path built them from the memory, and a rename
    // stayed invisible until the next start — a write by the NEW title was dropped.
    const memory = new ProbeMemory({
      yncaCapabilities: {
        model: "RX",
        firmware: "1.0",
        subunits: { MAIN: { PWR: "On", SCENE1NAME: "Old name" }, SYS: { MODELNAME: "RX", VERSION: "1.0" } },
      },
    });
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { SYS: { MODELNAME: "RX", VERSION: "1.0" }, MAIN: { PWR: "On", SCENE1NAME: "Movie night" } },
    };
    const { acked, deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", { ...deps, probeMemory: memory });
    await controller.start();
    await flushAsync();
    expect(acked.filter(a => a.id === "living.scene.list").pop()?.value).toBe(
      JSON.stringify([{ num: 1, title: "Movie night" }]),
    );
    // …and the write by title resolves against the FRESH list.
    client.sent.length = 0;
    controller.handleStateChange("living.scene.recall", false, "Movie night");
    expect(client.sent).toEqual([{ subunit: "MAIN", func: "SCENE", value: "Scene 1" }]);
  });

  test("a band-routed write follows the LIVE band, not the remembered one", async () => {
    // The remembered layer says AM (that is where the tuner stood when the adapter last
    // ran); the device is on FM now. Routing the frequency by the memory put AMFREQ on
    // the wire — a wrong command, not just a stale reading.
    const memory = new ProbeMemory({
      yncaCapabilities: {
        model: "RX",
        firmware: "1.0",
        subunits: { MAIN: { PWR: "On" }, TUN: { BAND: "AM", AMFREQ: "1080", FMFREQ: "100.90" } },
      },
    });
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { SYS: { MODELNAME: "RX", VERSION: "1.0" }, MAIN: { PWR: "On" }, TUN: { BAND: "FM" } },
    };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", { ...deps, probeMemory: memory });
    await controller.start();
    controller.handleStateChange("living.tuner.frequency", false, 100900);
    expect(client.sent).toEqual([{ subunit: "TUN", func: "FMFREQ", value: "100.90" }]);
  });

  test("a player button follows the zone's LIVE input, not the remembered one", async () => {
    // Same class: the transport buttons are routed by what the zone is listening to. A
    // remembered input sent play/pause to the source the zone listened to LAST run.
    const memory = new ProbeMemory({
      yncaCapabilities: {
        model: "RX",
        firmware: "1.0",
        subunits: {
          MAIN: { PWR: "On", INP: "NET RADIO" },
          NETRADIO: { PLAYBACKINFO: "Play" },
          SPOTIFY: { PLAYBACKINFO: "Play" },
        },
      },
    });
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { SYS: { MODELNAME: "RX", VERSION: "1.0" }, MAIN: { PWR: "On", INP: "Spotify" } },
    };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", { ...deps, probeMemory: memory });
    await controller.start();
    controller.handleStateChange("living.player.playback", false, 2);
    expect(client.sent).toEqual([{ subunit: "SPOTIFY", func: "PLAYBACK", value: "Pause" }]);
  });

  test("the second connect builds the tree from the memory and refreshes values behind the ready line", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: {
        SYS: { MODELNAME: "RX", VERSION: "1.0", INPNAMEHDMI1: "Kodi" },
        MAIN: { PWR: "On", SCENE1NAME: "Movie" },
      },
    };
    const memory = new ProbeMemory();
    const { deps } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps, probeMemory: memory }).start();
    const firstSweep = client.requests[client.requests.length - 1];
    expect(firstSweep.some(get => get.func === "INPNAMEHDMI1")).toBe(true);

    // Second connect (same device, memory kept — a reconnect or, persisted, a restart):
    // start() itself asks ONLY the identity (the liveness proof). The tree stands from
    // the remembered shape; stale values are NOT seeded — the states hold them anyway.
    client.requests.length = 0;
    const { created, acked, deps: deps2 } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps2, probeMemory: memory }).start();
    // The only request the READY LINE waited for is the identity read plus the handful of
    // values the start DECIDES from; no AVAIL probe, no blocking sweep.
    expect(client.requests[0].map(get => get.func)).toEqual(["MODELNAME", "VERSION"]);
    expect(client.requests.some(gets => gets.every(get => get.func === "AVAIL"))).toBe(false);
    // The remembered layer is a SHAPE — its values are the last run's. Power, the zone
    // inputs and the tuner band decide something (menu claim, write routing), so they are
    // read live before use instead of taken from the memory.
    expect(client.requests[1].map(get => `${get.subunit}:${get.func}`)).toEqual(["MAIN:PWR", "MAIN:INP"]);
    expect(created).toContain("living.advanced.inputNames.hdmi1");
    expect(created).toContain("living.power");
    // Stale values are not seeded — the states hold last-known values anyway. The
    // scene list is the one deliberate exception: it is derived presentation, not a
    // stale device value.
    expect(acked.filter(a => a.id !== "living.scene.list")).toEqual([]);
    // The full question round then runs BEHIND the ready line as a value refresh —
    // statics included, so a rename at the device heals in seconds, not on a restart.
    await flushAsync();
    expect(client.requests).toHaveLength(3);
    const background = client.requests[2];
    expect(background.some(get => get.func === "PWR")).toBe(true);
    expect(background.some(get => get.func === "INPNAMEHDMI1")).toBe(true);
  });

  test("a different device behind the address voids the memory and sweeps fresh", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX-A",
      subunits: { SYS: { MODELNAME: "RX-A", VERSION: "1.0" }, MAIN: { PWR: "On" } },
    };
    const memory = new ProbeMemory();
    const { deps } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps, probeMemory: memory }).start();

    // The device at this IP is swapped (different model): the cached layer must not build
    // the OLD device's tree — the identity mismatch forces the full sweep.
    client.capabilities = {
      model: "RX-B",
      subunits: { SYS: { MODELNAME: "RX-B", VERSION: "2.0" }, MAIN: { PWR: "On" } },
    };
    client.requests.length = 0;
    const { deps: deps2 } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps2, probeMemory: memory }).start();
    // More than the identity request ran: the sweep went to the device again.
    expect(client.requests.length).toBeGreaterThan(1);
    const stored = memory.remembered<{ model: string }>("yncaCapabilities");
    expect(stored?.model).toBe("RX-B");
  });
});

describe("YncaDeviceController write gating + refusal logging (#615 class)", () => {
  test("a write only goes out with a function THIS device reported (dialect choice)", async () => {
    const client = new FakeClient();
    // A classic receiver: bass reported under SPBASS.
    client.capabilities = { model: "RX-V473", subunits: { MAIN: { PWR: "On", SPBASS: "3.0" } } };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    client.sent.length = 0;
    controller.handleStateChange("living.sound.bass", false, 2);
    expect(client.sent).toEqual([{ subunit: "MAIN", func: "SPBASS", value: "2.0" }]);
    // A state whose function the device never reported is not written at all.
    client.sent.length = 0;
    controller.handleStateChange("living.sound.treble", false, 1);
    expect(client.sent).toEqual([]);
  });

  test("a device refusal is logged as a warning with the refused command", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "RX-V473", subunits: { MAIN: { PWR: "On" } } };
    const { deps } = makeDeps(client);
    const warnings: string[] = [];
    deps.log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m) };
    let refuse: ((command: string, verdict: "restricted" | "undefined") => void) | undefined;
    client.onRefusal = (handler): void => {
      refuse = handler;
    };
    await new YncaDeviceController("living", deps).start();
    refuse?.("@MAIN:SCENE=Scene 1", "restricted");
    expect(warnings).toEqual(['living: device refused "@MAIN:SCENE=Scene 1" (@RESTRICTED)']);
  });
});

describe("YncaDeviceController scenes v2.0.0 (titles in the dropdown, one list, title writes)", () => {
  function sceneSetup(): {
    controller: YncaDeviceController;
    client: FakeClient;
    objects: Array<{ id: string; def: ObjectDef }>;
    acked: Array<{ id: string; value: unknown }>;
  } {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX-V473",
      subunits: { MAIN: { PWR: "On", SCENE1NAME: "BD/DVD", SCENE2NAME: "TV" } },
    };
    const { objects, acked, deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    return { controller, client, objects, acked };
  }

  test("the recall dropdown carries the device's scene names; scene.list holds them as JSON", async () => {
    const s = sceneSetup();
    await s.controller.start();
    const recall = s.objects.find(o => o.id === "living.scene.recall");
    expect(recall?.def.common.states).toEqual({ 1: "BD/DVD", 2: "TV" });
    const list = s.acked.find(a => a.id === "living.scene.list");
    expect(JSON.parse(String(list?.value))).toEqual([
      { num: 1, title: "BD/DVD" },
      { num: 2, title: "TV" },
    ]);
    // The per-name datapoints are gone.
    expect(s.objects.some(o => o.id.startsWith("living.scene.name"))).toBe(false);
  });

  test("writing a scene TITLE recalls its number; an unknown title sends nothing", async () => {
    const s = sceneSetup();
    await s.controller.start();
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.scene.recall", false, "tv");
    expect(s.client.sent).toEqual([{ subunit: "MAIN", func: "SCENE", value: "Scene 2" }]);
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.scene.recall", false, "Gaming");
    expect(s.client.sent).toEqual([]);
  });
});

describe("YncaDeviceController unified tuner v2.0.0 (band-routed writes)", () => {
  async function tunerSetup(
    subunits: YncaCapabilities["subunits"],
  ): Promise<{ controller: YncaDeviceController; client: FakeClient }> {
    const client = new FakeClient();
    client.capabilities = { model: "RX-V473", subunits };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    client.sent.length = 0;
    return { controller, client };
  }

  test("a frequency write goes to the active band's wire function on a classic TUN device", async () => {
    const s = await tunerSetup({ MAIN: { PWR: "On" }, TUN: { BAND: "AM", AMFREQ: "1440", FMFREQ: "98.10" } });
    // AM: whole kHz on AMFREQ.
    s.controller.handleStateChange("living.tuner.frequency", false, 1440);
    expect(s.client.sent).toEqual([{ subunit: "TUN", func: "AMFREQ", value: "1440" }]);
    // The device switches to FM (pushed BAND update) — the SAME state now writes
    // FMFREQ in the MHz wire form with two decimals (#612 format rule).
    s.client.emit({ subunit: "TUN", func: "BAND", value: "FM" });
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.tuner.frequency", false, 98100);
    expect(s.client.sent).toEqual([{ subunit: "TUN", func: "FMFREQ", value: "98.10" }]);
  });

  test("on a DAB device the FM frequency writes DAB:FMFREQ; in DAB band the write is dropped", async () => {
    const s = await tunerSetup({ MAIN: { PWR: "On" }, DAB: { BAND: "FM", FMFREQ: "98.10" } });
    s.controller.handleStateChange("living.tuner.frequency", false, 98100);
    expect(s.client.sent).toEqual([{ subunit: "DAB", func: "FMFREQ", value: "98.10" }]);
    // DAB tunes by service — there is no frequency command to send.
    s.client.emit({ subunit: "DAB", func: "BAND", value: "DAB" });
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.tuner.frequency", false, 227360);
    expect(s.client.sent).toEqual([]);
  });

  test("a band write goes to the subunit that owns that band", async () => {
    const classic = await tunerSetup({ MAIN: { PWR: "On" }, TUN: { BAND: "AM", AMFREQ: "1440" } });
    classic.controller.handleStateChange("living.tuner.band", false, "AM");
    expect(classic.client.sent).toEqual([{ subunit: "TUN", func: "BAND", value: "AM" }]);
    classic.client.sent.length = 0;
    classic.controller.handleStateChange("living.tuner.band", false, "FM");
    expect(classic.client.sent).toEqual([{ subunit: "TUN", func: "BAND", value: "FM" }]);

    // On a DAB device the FM half lives on DAB — that is where its FM frequency and presets are.
    const dab = await tunerSetup({ MAIN: { PWR: "On" }, DAB: { BAND: "DAB", FMFREQ: "98.10" } });
    dab.controller.handleStateChange("living.tuner.band", false, "FM");
    expect(dab.client.sent).toEqual([{ subunit: "DAB", func: "BAND", value: "FM" }]);
    dab.client.sent.length = 0;
    // A band this device does not have is dropped instead of going onto the wire.
    dab.controller.handleStateChange("living.tuner.band", false, "AM");
    expect(dab.client.sent).toEqual([]);
  });

  test("a device answering BOTH tuner subunits keeps all three bands and routes each correctly", async () => {
    // No reference log shows a device answering TUN and DAB at once; if one ever does, the
    // object tree used to keep whichever definition was written last and AM disappeared.
    const s = await tunerSetup({
      MAIN: { PWR: "On" },
      TUN: { BAND: "AM", AMFREQ: "1440" },
      DAB: { BAND: "DAB", FMFREQ: "98.10" },
    });
    s.controller.handleStateChange("living.tuner.band", false, "AM");
    expect(s.client.sent).toEqual([{ subunit: "TUN", func: "BAND", value: "AM" }]);
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.tuner.band", false, "DAB");
    expect(s.client.sent).toEqual([{ subunit: "DAB", func: "BAND", value: "DAB" }]);
  });

  test("on a DAB device the preset recall picks DABPRESET or FMPRESET by the active band", async () => {
    const s = await tunerSetup({
      MAIN: { PWR: "On" },
      DAB: { BAND: "DAB", DABPRESET: "No Preset", FMPRESET: "No Preset" },
    });
    s.controller.handleStateChange("living.tuner.preset", false, 5);
    expect(s.client.sent).toEqual([{ subunit: "DAB", func: "DABPRESET", value: "5" }]);
    s.client.emit({ subunit: "DAB", func: "BAND", value: "FM" });
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.tuner.preset", false, 4);
    expect(s.client.sent).toEqual([{ subunit: "DAB", func: "FMPRESET", value: "4" }]);
  });
});

describe("YncaDeviceController unified player v2.0.0 (input-routed block)", () => {
  async function playerSetup(subunits: YncaCapabilities["subunits"]): Promise<{
    controller: YncaDeviceController;
    client: FakeClient;
    objects: Array<{ id: string; def: ObjectDef }>;
    acked: Array<{ id: string; value: unknown }>;
  }> {
    const client = new FakeClient();
    client.capabilities = { model: "RX-A810", subunits };
    const { objects, acked, deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    return { controller, client, objects, acked };
  }

  test("a source's values land in the block of the zone LISTENING to it — and only there", async () => {
    const s = await playerSetup({
      MAIN: { PWR: "On", INP: "NET RADIO" },
      NETRADIO: { PLAYBACKINFO: "Play", STATION: "Radio X" },
      USB: { PLAYBACKINFO: "Stop", SONG: "Old Song" },
    });
    // The seed routed only the LISTENING source's values into the flat block.
    expect(s.acked).toContainEqual({ id: "living.player.station", value: "Radio X" });
    expect(s.acked).not.toContainEqual({ id: "living.player.track", value: "Old Song" });
    // A live push from the idle source is dropped; from the active one it lands.
    s.acked.length = 0;
    s.client.emit({ subunit: "USB", func: "SONG", value: "Other" });
    s.client.emit({ subunit: "NETRADIO", func: "STATION", value: "Radio Y" });
    expect(s.acked).toEqual([{ id: "living.player.station", value: "Radio Y" }]);
  });

  test("an input switch clears the block, shows the source and asks the new source for its state", async () => {
    const s = await playerSetup({
      MAIN: { PWR: "On", INP: "NET RADIO" },
      NETRADIO: { PLAYBACKINFO: "Play", STATION: "Radio X" },
      USB: { PLAYBACKINFO: "Stop", SONG: "Old Song" },
    });
    s.acked.length = 0;
    s.client.gets.length = 0;
    s.client.emit({ subunit: "MAIN", func: "INP", value: "USB" });
    expect(s.acked).toContainEqual({ id: "living.player.station", value: "" });
    expect(s.acked).toContainEqual({ id: "living.player.source", value: "USB" });
    expect(s.client.gets).toContainEqual({ subunit: "USB", func: "PLAYBACKINFO" });
    // Switching to a non-player input clears again and empties the source display.
    s.acked.length = 0;
    s.client.emit({ subunit: "MAIN", func: "INP", value: "HDMI1" });
    expect(s.acked).toContainEqual({ id: "living.player.playback", value: 1 });
    expect(s.acked).toContainEqual({ id: "living.player.source", value: "" });
  });

  test("a transport write goes to the subunit the zone is listening to — claim with proof", async () => {
    const s = await playerSetup({
      MAIN: { PWR: "On", INP: "USB" },
      USB: { PLAYBACKINFO: "Play" },
    });
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.player.playback", false, 2);
    s.controller.handleStateChange("living.player.next", false, true);
    expect(s.client.sent).toEqual([
      { subunit: "USB", func: "PLAYBACK", value: "Pause" },
      { subunit: "USB", func: "PLAYBACK", value: "Skip Fwd" },
    ]);
    // Not listening to a player source → the write is dropped, nothing goes on the wire.
    s.client.emit({ subunit: "MAIN", func: "INP", value: "HDMI1" });
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.player.playback", false, 0);
    expect(s.client.sent).toEqual([]);
  });

  test("a present zone gets its own player mirror and its own input routing", async () => {
    const s = await playerSetup({
      MAIN: { PWR: "On", INP: "HDMI1" },
      ZONE2: { PWR: "On", INP: "NET RADIO" },
      NETRADIO: { PLAYBACKINFO: "Play", STATION: "Radio X" },
    });
    // The zone mirror exists; a zone-less device would not get one.
    expect(s.objects.some(o => o.id === "living.multiroom.zone2.player.playback")).toBe(true);
    // The value went to zone2's block, NOT to main (main listens to HDMI).
    expect(s.acked).toContainEqual({ id: "living.multiroom.zone2.player.station", value: "Radio X" });
    expect(s.acked).not.toContainEqual({ id: "living.player.station", value: "Radio X" });
    // A zone-prefixed transport write routes over zone2's source.
    s.client.sent.length = 0;
    s.controller.handleStateChange("living.multiroom.zone2.player.playback", false, 1);
    expect(s.client.sent).toEqual([{ subunit: "NETRADIO", func: "PLAYBACK", value: "Stop" }]);
  });
});

describe("YncaDeviceController player review fixes (2.0.0 pre-release audit)", () => {
  async function auditSetup(subunits: YncaCapabilities["subunits"]): Promise<{
    controller: YncaDeviceController;
    client: FakeClient;
    acked: Array<{ id: string; value: unknown }>;
  }> {
    const client = new FakeClient();
    client.capabilities = { model: "RX-A810", subunits };
    const { acked, deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    return { controller, client, acked };
  }

  test("bluetooth STATUS states are device-global — they land even while no zone plays that source", async () => {
    const s = await auditSetup({
      MAIN: { PWR: "On", INP: "HDMI1" },
      BT: { PLAYBACKINFO: "Stop", CONNECTINFO: "Disconnected", DEVICENAME: "" },
    });
    s.acked.length = 0;
    // A phone pairs in the background while the receiver plays HDMI — the pairing
    // status must not be dropped by the zone routing (it is not a block value).
    s.client.emit({ subunit: "BT", func: "CONNECTINFO", value: "Connected" });
    s.client.emit({ subunit: "BT", func: "DEVICENAME", value: "Pixel" });
    expect(s.acked).toContainEqual({ id: "living.player.bluetooth.connected", value: true });
    expect(s.acked).toContainEqual({ id: "living.player.bluetooth.deviceName", value: "Pixel" });
  });

  test("the source display is seeded at start — a device already playing must not show it empty", async () => {
    const s = await auditSetup({
      MAIN: { PWR: "On", INP: "NET RADIO" },
      ZONE2: { PWR: "On", INP: "HDMI1" },
      NETRADIO: { PLAYBACKINFO: "Play" },
    });
    expect(s.acked).toContainEqual({ id: "living.player.source", value: "NET RADIO" });
    expect(s.acked).toContainEqual({ id: "living.multiroom.zone2.player.source", value: "" });
    // The idle zone's block is seeded with its cleared shape (only the states the
    // device has), while the playing zone keeps its routed values.
    expect(s.acked).toContainEqual({ id: "living.multiroom.zone2.player.playback", value: 1 });
    expect(s.acked).not.toContainEqual({ id: "living.player.playback", value: 1 });
  });
});

describe("YncaDeviceController test-audit hardening (2.0.1)", () => {
  test("a frequency write on a device WITHOUT a tuner sends nothing (claim with proof)", async () => {
    const client = new FakeClient();
    client.capabilities = { model: "WXA-50", subunits: { MAIN: { PWR: "On", INP: "HDMI1" } } };
    const { deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    client.sent.length = 0;
    controller.handleStateChange("living.tuner.frequency", false, 98100);
    controller.handleStateChange("living.tuner.preset", false, 3);
    expect(client.sent).toEqual([]);
  });

  const INPUT_CASES: Array<[string, string]> = [
    ["NET RADIO", "NETRADIO"],
    ["Bluetooth", "BT"],
    ["AirPlay", "AIRPLAY"],
    ["iPod (USB)", "IPODUSB"],
    ["Spotify", "SPOTIFY"],
    ["SERVER", "SERVER"],
  ];

  test.each(INPUT_CASES)("the INP value %s routes the player block to subunit %s", async (input, subunit) => {
    // The normalization (uppercase, strip non-alphanumerics) exists exactly for the
    // hard names — a regex regression must fail here, not only on trivial inputs.
    const client = new FakeClient();
    client.capabilities = {
      model: "RX-A810",
      subunits: { MAIN: { PWR: "On", INP: "HDMI1" }, [subunit]: { PLAYBACKINFO: "Stop" } },
    };
    const { acked, deps } = makeDeps(client);
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    acked.length = 0;
    client.emit({ subunit: "MAIN", func: "INP", value: input });
    client.emit({ subunit, func: "PLAYBACKINFO", value: "Play" });
    expect(acked).toContainEqual({ id: "living.player.source", value: input });
    expect(acked).toContainEqual({ id: "living.player.playback", value: 0 });
  });
});

describe("YncaDeviceController capability persistence (standby must not shrink it)", () => {
  test("a background refresh while the device stands by keeps every proven ability in the memory", async () => {
    const richSubunits = {
      SYS: { MODELNAME: "RX", VERSION: "1.0" },
      MAIN: { PWR: "On", VOL: "-30.0" },
      NETRADIO: { PLAYBACKINFO: "Play", STATION: "Radio X" },
    };
    let stored: Record<string, unknown> = {};
    const memory = new ProbeMemory(
      { yncaCapabilities: { model: "RX", firmware: "1.0", subunits: richSubunits } },
      entries => {
        stored = entries;
      },
    );
    const client = new FakeClient();
    // The live identity matches the memory (fast path) — but the refresh runs while
    // the device stands by: the media subunit answers nothing at all.
    client.capabilities = {
      model: "RX",
      subunits: { SYS: { MODELNAME: "RX", VERSION: "1.0" }, MAIN: { PWR: "Standby", VOL: "-50.5" } },
    };
    const { deps } = makeDeps(client);
    (deps as { probeMemory?: ProbeMemory }).probeMemory = memory;
    const controller = new YncaDeviceController("living", deps);
    await controller.start();
    await new Promise(resolve => setImmediate(resolve));
    const caps = stored.yncaCapabilities as { subunits: Record<string, Record<string, string>> };
    // The proven media ability survives the standby refresh; fresh values win.
    expect(caps.subunits.NETRADIO).toEqual({ PLAYBACKINFO: "Play", STATION: "Radio X" });
    expect(caps.subunits.MAIN.PWR).toBe("Standby");
  });
});

import { YncaDeviceController } from "./device-controller";
import type { YncaClientLike } from "./device-controller";
import type { YncaCapabilities } from "./ynca/capability";
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
  /** Every readCapabilities request list, for asserting what was actually swept. */
  public requests: Array<Array<{ subunit: string; func: string }>> = [];
  private handler?: (message: Msg) => void;

  public async connect(): Promise<void> {}
  public async readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities> {
    this.requests.push(gets);
    if (this.availableSubunits && gets.length > 0 && gets.every(get => get.func === "AVAIL")) {
      const subunits: Record<string, Record<string, string>> = {};
      for (const subunit of this.availableSubunits) {
        subunits[subunit] = { AVAIL: "Ready" };
      }
      return { model: "", subunits };
    }
    return this.capabilities;
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
  acked: Array<{ id: string; value: unknown }>;
  deps: ConstructorParameters<typeof YncaDeviceController>[1];
} {
  const created: string[] = [];
  const acked: Array<{ id: string; value: unknown }> = [];
  return {
    created,
    acked,
    deps: {
      client,
      upsertObject: async (id: string) => {
        created.push(id);
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
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0].every(get => get.func === "AVAIL")).toBe(true);
    // SYS answers no AVAIL and must never be probed…
    expect(client.requests[0].some(get => get.subunit === "SYS")).toBe(false);
    // …but is always part of the sweep; absent subunits (ZONE2, player sources) are not.
    const sweptSubunits = new Set(client.requests[1].map(get => get.subunit));
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
    const sweptSubunits = new Set(client.requests[1].map(get => get.subunit));
    expect(sweptSubunits.has("SPOTIFY")).toBe(false);
    // …and no player object is created.
    expect(created.some(id => id.includes("player"))).toBe(false);
    expect(created).toContain("living.power");
  });
});

describe("YncaDeviceController browse surface (#613)", () => {
  const instantDelay = (): Promise<void> => Promise.resolve();
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  test("creates the browse tree when a browsable subunit answered and routes its writes", async () => {
    const client = new FakeClient();
    client.capabilities = {
      model: "RX",
      subunits: { MAIN: { PWR: "On" }, NETRADIO: { PLAYBACKINFO: "Stop" } },
    };
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
    const { created, deps } = makeDeps(client);
    deps.gate = testGate();
    deps.isEntryEnabled = (id: string): boolean => !id.startsWith("player.");
    await new YncaDeviceController("living", deps).start();
    expect(created.some(id => id.includes("player.browse"))).toBe(false);
  });
});

describe("YncaDeviceController static-value memory", () => {
  test("re-asks the constant names only on the first connect", async () => {
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
    expect(firstSweep.some(get => get.func === "SCENE1NAME")).toBe(true);

    // Second connect (same device, memory kept by the caller): the names are not asked
    // again — 35 of ~187 paced reads, i.e. ~3.5 s off every reconnect.
    client.requests.length = 0;
    const { created, acked, deps: deps2 } = makeDeps(client);
    await new YncaDeviceController("living", { ...deps2, probeMemory: memory }).start();
    const secondSweep = client.requests[client.requests.length - 1];
    expect(secondSweep.some(get => get.func === "INPNAMEHDMI1")).toBe(false);
    expect(secondSweep.some(get => get.func === "SCENE1NAME")).toBe(false);
    // …but the objects and values are still there, exactly as if the device had answered.
    expect(created).toContain("living.advanced.inputNames.hdmi1");
    expect(acked).toContainEqual({ id: "living.advanced.inputNames.hdmi1", value: "Kodi" });
    expect(acked).toContainEqual({ id: "living.scene.name1", value: "Movie" });
  });
});

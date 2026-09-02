import { XmlDeviceController } from "./device-controller";
import type { XmlClientLike } from "./device-controller";
import { XmlHttpError, type BasicStatus } from "./protocol";
import { CommandGate } from "../lifecycle/command-gate";
import { ProbeMemory } from "../lifecycle/probe-memory";

/** A real command gate for the controller under test (pacing has its own suite). */
const testGate = (): CommandGate =>
  new CommandGate({
    minSpacingMs: 0,
    timers: { schedule: (h, ms) => setTimeout(h, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
  });

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

class FakeClient implements XmlClientLike {
  public calls: Array<{ method: string; zone: string; inner?: string }> = [];
  /** Canned GET answers keyed `<element>|<inner>`; unmatched requests answer "" (declares none). */
  public xmlAnswers: Record<string, string> = {};
  /** Canned GET failures keyed like xmlAnswers — the probe sees a rejection (transient or a 400). */
  public xmlErrors: Record<string, Error> = {};
  public constructor(public statuses: Record<string, BasicStatus>) {}
  public getStatus(zone: string): Promise<BasicStatus> {
    this.calls.push({ method: "getStatus", zone });
    return Promise.resolve(this.statuses[zone] ?? {});
  }
  public modelName: string | undefined = undefined;
  public getModelName(): Promise<string | undefined> {
    this.calls.push({ method: "getModelName", zone: "" });
    return Promise.resolve(this.modelName);
  }
  public send(zone: string, inner: string): Promise<void> {
    this.calls.push({ method: "send", zone, inner });
    return Promise.resolve();
  }
  /**
   * Probes (browse List_Info, scenes, inputs, tuner) — an empty body means "declares none".
   *
   * @param zone Zone element the probe is wrapped in
   * @param inner Inner XML of the probe
   */
  public getXml(zone: string, inner: string): Promise<string> {
    this.calls.push({ method: "getXml", zone, inner });
    const failure = this.xmlErrors[`${zone}|${inner}`];
    if (failure) {
      return Promise.reject(failure);
    }
    return Promise.resolve(this.xmlAnswers[`${zone}|${inner}`] ?? "");
  }
}

/**
 * A device-style Scene_Sel_Item declaration (the RX-V6A capture shape).
 *
 * @param scenes Scene numbers and titles to declare
 */
const sceneDeclaration = (scenes: Array<{ num: number; title: string }>): string =>
  `<YAMAHA_AV rsp="GET" RC="0"><Scene><Scene_Sel_Item>${scenes
    .map(
      s =>
        `<Item_${s.num}><Param>Scene ${s.num}</Param><RW>W</RW><Title>${s.title}</Title><Icon><On>${s.num}</On></Icon></Item_${s.num}>`,
    )
    .join("")}</Scene_Sel_Item></Scene></YAMAHA_AV>`;

function setup(
  statuses: Record<string, BasicStatus>,
  pollIntervalMs?: number,
): {
  controller: XmlDeviceController;
  client: FakeClient;
  objects: string[];
  defs: Map<string, { common?: { name?: unknown } }>;
  acks: Array<{ id: string; value: unknown }>;
  fire: { keepalive?: () => void; keepaliveMs?: number };
  cancelled: () => boolean;
} {
  const client = new FakeClient(statuses);
  const objects: string[] = [];
  const defs = new Map<string, { common?: { name?: unknown } }>();
  const acks: Array<{ id: string; value: unknown }> = [];
  const fire: { keepalive?: () => void; keepaliveMs?: number } = {};
  let cancelled = false;
  const controller = new XmlDeviceController(
    "living",
    {
      client,
      scheduleKeepalive: (handler, ms) => {
        fire.keepalive = handler;
        fire.keepaliveMs = ms;
        return () => {
          cancelled = true;
        };
      },
      upsertObject: (id, def) => {
        objects.push(id);
        defs.set(id, def);
        return Promise.resolve();
      },
      setStateAck: (id, value) => {
        acks.push({ id, value });
      },
      log: silentLog,
    },
    pollIntervalMs,
  );
  return { controller, client, objects, defs, acks, fire, cancelled: () => cancelled };
}

describe("XmlDeviceController", () => {
  test("polls at the configured interval", async () => {
    const s = setup({ Main_Zone: { power: true } }, 15000);
    await s.controller.start();
    expect(s.fire.keepaliveMs).toBe(15000);
  });

  test("defaults to a 60 s poll interval", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    expect(s.fire.keepaliveMs).toBe(60000);
  });

  test("reports the model from System/Config into the adapter-created info.model", async () => {
    const s = setup({ Main_Zone: { power: true } });
    s.client.modelName = "RX-V1900";
    await s.controller.start();
    // The object itself is created once by the adapter (ensureDeviceHeader) for every
    // device, offline ones included — the transport only fills in the value.
    expect(s.acks).toContainEqual({ id: "living.info.model", value: "RX-V1900" });
  });

  test("builds the amp tree for the main zone and seeds its state", async () => {
    const s = setup({ Main_Zone: { power: true, volume: -30, mute: false, input: "HDMI1" } });
    expect(await s.controller.start()).toBe(true);
    expect(s.objects).toEqual(expect.arrayContaining(["living.power", "living.volume", "living.mute", "living.input"]));
    expect(s.acks).toContainEqual({ id: "living.power", value: true });
    expect(s.acks).toContainEqual({ id: "living.volume", value: -30 });
  });

  test("adds a further zone as a channel when it responds", async () => {
    const s = setup({ Main_Zone: { power: true }, Zone_2: { power: false } });
    await s.controller.start();
    expect(s.objects).toContain("living.multiroom.zone2");
    expect(s.objects).toContain("living.multiroom.zone2.power");
  });

  test("returns false and builds nothing when the main zone does not answer", async () => {
    const s = setup({});
    expect(await s.controller.start()).toBe(false);
    expect(s.objects).toEqual([]);
  });

  test("a user write becomes the matching XML command", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.power", false, true);
    await flush();
    expect(s.client.calls).toContainEqual({
      method: "send",
      zone: "Main_Zone",
      inner: "<Power_Control><Power>On</Power></Power_Control>",
    });
  });

  test("an acked change is ignored", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.power", true, true);
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("keepalive polls the live zones", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    s.fire.keepalive?.();
    await flush();
    expect(s.client.calls).toContainEqual({ method: "getStatus", zone: "Main_Zone" });
  });

  test("close cancels the keepalive", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.controller.close();
    expect(s.cancelled()).toBe(true);
  });

  test("scenes come from the device's OWN declaration — per zone, with titles (#615)", async () => {
    const s = setup({ Main_Zone: { power: true }, Zone_2: { power: false } });
    s.client.xmlAnswers["Main_Zone|<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>"] = sceneDeclaration([
      { num: 1, title: "Movie Viewing" },
      { num: 2, title: "Radio Listening" },
    ]);
    s.client.xmlAnswers["Zone_2|<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>"] = sceneDeclaration([
      { num: 1, title: "Zone Scene" },
    ]);
    await s.controller.start();
    expect(s.objects).toContain("living.scene");
    expect(s.objects).toContain("living.scene.recall");
    // v2.0.0: ONE list state instead of a name datapoint per scene.
    expect(s.objects).toContain("living.scene.list");
    expect(s.objects).not.toContain("living.scene.name1");
    const list = s.acks.find(a => a.id === "living.scene.list");
    expect(JSON.parse(String(list?.value))).toEqual([
      { num: 1, title: "Movie Viewing" },
      { num: 2, title: "Radio Listening" },
    ]);
    // Zone 2 scenes are first-class — the device declares them (RX-V6A capture).
    expect(s.objects).toContain("living.multiroom.zone2.scene.recall");
    expect(s.objects).not.toContain("living.multiroom.zone2.hdmiOut1");
  });

  test("a device declaring no scenes gets no scene states at all", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    expect(s.objects).not.toContain("living.scene");
    expect(s.objects).not.toContain("living.scene.recall");
  });

  test("a scene write sends the DECLARED Scene_Sel element, never the predecessor's Scene_Load (#615)", async () => {
    const s = setup({ Main_Zone: { power: true } });
    s.client.xmlAnswers["Main_Zone|<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>"] = sceneDeclaration([
      { num: 1, title: "Movie Viewing" },
      { num: 4, title: "NET Audio" },
    ]);
    await s.controller.start();
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.scene.recall", false, 4);
    await flush();
    expect(s.client.calls).toContainEqual({
      method: "send",
      zone: "Main_Zone",
      inner: "<Scene><Scene_Sel>Scene 4</Scene_Sel></Scene>",
    });
    // A number the device did not declare is not sent at all.
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.scene.recall", false, 7);
    await flush();
    expect(s.client.calls).toEqual([]);
  });

  test("the classic tuner surface appears only when <Tuner> answers, with the openHAB-verified preset write", async () => {
    const s = setup({ Main_Zone: { power: true } });
    s.client.xmlAnswers["Tuner|<Play_Info>GetParam</Play_Info>"] =
      `<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Info><Preset><Preset_Sel>3</Preset_Sel></Preset>` +
      `<Tuning><Freq><Val>9810</Val><Exp>2</Exp><Unit>MHz</Unit></Freq></Tuning>` +
      `<Signal_Info><Tuned>Assert</Tuned><Stereo>Negate</Stereo></Signal_Info>` +
      `<Meta_Info><Program_Service>Radio X</Program_Service></Meta_Info></Play_Info></Tuner></YAMAHA_AV>`;
    await s.controller.start();
    expect(s.objects).toContain("living.tuner.preset");
    expect(s.acks).toContainEqual({ id: "living.tuner.preset", value: 3 });
    // The wire reports FM in MHz; the unified state is kHz (v2.0.0).
    expect(s.acks).toContainEqual({ id: "living.tuner.frequency", value: 98100 });
    expect(s.acks).toContainEqual({ id: "living.tuner.tuned", value: true });
    expect(s.acks).toContainEqual({ id: "living.tuner.rdsService", value: "Radio X" });
    s.client.calls.length = 0;
    s.controller.handleStateChange("living.tuner.preset", false, 5);
    await flush();
    expect(s.client.calls).toContainEqual({
      method: "send",
      zone: "Tuner",
      inner: "<Play_Control><Preset><Preset_Sel>5</Preset_Sel></Preset></Play_Control>",
    });
  });

  test("a device without <Tuner> gets no tuner states", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    expect(s.objects).not.toContain("living.tuner.preset");
  });

  test("the input state carries the device's own input list as its dropdown", async () => {
    const s = setup({ Main_Zone: { power: true, input: "HDMI1" } });
    s.client.xmlAnswers["Main_Zone|<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>"] =
      `<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Input><Input_Sel_Item>` +
      `<Item_1><Param>HDMI1</Param><RW>RW</RW></Item_1><Item_2><Param>NET RADIO</Param><RW>RW</RW></Item_2>` +
      `</Input_Sel_Item></Input></Main_Zone></YAMAHA_AV>`;
    await s.controller.start();
    const input = s.defs.get("living.input") as { common?: { states?: Record<string, string> } } | undefined;
    expect(input?.common?.states).toEqual({ HDMI1: "HDMI1", "NET RADIO": "NET RADIO" });
  });
});

describe("XmlDeviceController object tree and drop handling", () => {
  test("creates the parent channels of a nested datapoint, each exactly once", async () => {
    const s = setup({ Main_Zone: { power: true }, Zone_2: { power: false }, Zone_3: { power: false } });
    await s.controller.start();
    // A datapoint whose parent channel does not exist shows up unnamed in the admin
    // tree (and js-controller warns per write).
    expect(s.objects).toContain("living.multiroom");
    expect(s.objects).toContain("living.multiroom.zone2");
    expect(s.objects).toContain("living.multiroom.zone3");
    // Rewriting the shared parent for every zone churns the object DB on each start.
    expect(s.objects.filter(id => id === "living.multiroom")).toHaveLength(1);
    // The zone channel carries its readable name from the shared CHANNEL_NAMES table.
    expect(s.defs.get("living.multiroom.zone2")?.common?.name).toBe("Zone 2");
  });

  test("ignores a write meant for another device", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    s.client.calls.length = 0;
    // Every supervisor gets every state change; the prefix check is what keeps one
    // receiver from executing the other's commands.
    // "office." is exactly as long as "living." — a foreign id of a DIFFERENT
    // length would be sliced into nonsense and dropped by the catalog anyway.
    s.controller.handleStateChange("office.power", false, true);
    await flush();
    expect(s.client.calls).toEqual([]);

    s.controller.handleStateChange("living.power", false, true);
    await flush();
    expect(s.client.calls.some(c => c.method === "send")).toBe(true);
  });

  test("reports the device gone only after a RUN of failed polls, and only once", async () => {
    const s = setup({ Main_Zone: { power: true } });
    await s.controller.start();
    const drops: Array<Error | undefined> = [];
    s.controller.onDrop(reason => drops.push(reason));

    const fail = (): void => {
      s.client.getStatus = (): Promise<BasicStatus> => Promise.reject(new Error("ECONNREFUSED"));
    };
    const ok = (): void => {
      s.client.getStatus = (): Promise<BasicStatus> => Promise.resolve({ power: true });
    };

    fail();
    s.fire.keepalive?.();
    await flush();
    // XML has no socket event — a single missed poll on a busy receiver is normal.
    // Dropping on it would restart the whole transport set every few minutes.
    expect(drops).toHaveLength(0);

    ok();
    s.fire.keepalive?.();
    await flush();
    fail();
    // The counter must have been reset by the good poll, so this run starts over.
    s.fire.keepalive?.();
    await flush();
    expect(drops).toHaveLength(0);

    for (let i = 0; i < 5; i++) {
      s.fire.keepalive?.();
      await flush();
    }
    expect(drops).toHaveLength(1);
    expect(drops[0]?.message).toMatch(/polls failed/);

    // A second report would make the supervisor reconnect a handle it already replaced.
    for (let i = 0; i < 3; i++) {
      s.fire.keepalive?.();
      await flush();
    }
    expect(drops).toHaveLength(1);
  });
});

describe("XmlDeviceController browse surface (#613)", () => {
  const listBody =
    '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><List_Info><Menu_Status>Ready</Menu_Status>' +
    "<Menu_Layer>1</Menu_Layer><Menu_Name>NET RADIO</Menu_Name><Current_List>" +
    "<Line_1><Txt>Bookmarks</Txt><Attribute>Container</Attribute></Line_1></Current_List>" +
    "<Cursor_Position><Current_Line>1</Current_Line><Max_Line>1</Max_Line></Cursor_Position>" +
    "</List_Info></NET_RADIO></YAMAHA_AV>";

  function browseSetup(answers: Record<string, string>): {
    controller: XmlDeviceController;
    client: FakeClient;
    objects: string[];
  } {
    const client = new FakeClient({ Main_Zone: { power: true } });
    client.getXml = (element: string, inner: string): Promise<string> => {
      client.calls.push({ method: "getXml", zone: element, inner });
      if (element in answers) {
        return Promise.resolve(answers[element]);
      }
      // What a real receiver answers for a source without a menu: a bodyless HTTP 400
      // (captured RX-V6A: tuner-list-info, bluetooth-list-info) — the model's own verdict.
      return Promise.reject(new XmlHttpError("device refused the request (HTTP 400)", 400));
    };
    const objects: string[] = [];
    const controller = new XmlDeviceController("living", {
      client,
      scheduleKeepalive: () => () => {},
      upsertObject: id => {
        objects.push(id);
        return Promise.resolve();
      },
      setStateAck: () => {},
      log: silentLog,
      gate: testGate(),
    });
    return { controller, client, objects };
  }

  it("creates the browse tree for the sources whose List_Info probe answered", async () => {
    const { controller, objects } = browseSetup({ NET_RADIO: listBody });
    await controller.start();
    expect(objects).toContain("living.player.browse");
    expect(objects).toContain("living.player.browse.home");
  });

  it("creates no browse tree when no source answers the probe", async () => {
    const { controller, objects } = browseSetup({});
    await controller.start();
    expect(objects.some(id => id.includes("player.browse"))).toBe(false);
  });

  it("routes a browse write to the driver (input switch + List_Info read)", async () => {
    const { controller, client } = browseSetup({ NET_RADIO: listBody });
    await controller.start();
    client.calls.length = 0;
    controller.handleStateChange("living.player.browse.source", false, "netRadio");
    await flush();
    expect(client.calls).toContainEqual({
      method: "send",
      zone: "Main_Zone",
      inner: "<Input><Input_Sel>NET RADIO</Input_Sel></Input>",
    });
    // Switching the input without fetching the menu is exactly the #613 symptom class
    // (empty menu) — the List_Info read must go out too.
    expect(
      client.calls.some(
        call => call.method === "getXml" && call.zone === "NET_RADIO" && call.inner?.includes("List_Info"),
      ),
    ).toBe(true);
  });
});

describe("XmlDeviceController freshness guard (persisted memory)", () => {
  const sceneRequest = "Main_Zone|<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>";

  test("a matching model keeps the remembered declarations; a different one re-probes", async () => {
    const memory = new ProbeMemory();
    const first = setup({ Main_Zone: { power: true } });
    (first.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    first.client.modelName = "RX-V773";
    first.client.xmlAnswers[sceneRequest] = sceneDeclaration([{ num: 1, title: "Movie" }]);
    await first.controller.start();

    // Same model again: the scene declaration comes from the memory, not the wire.
    const second = setup({ Main_Zone: { power: true } });
    (second.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    second.client.modelName = "RX-V773";
    await second.controller.start();
    expect(second.client.calls.some(c => c.inner?.includes("Scene_Sel_Item"))).toBe(false);
    expect(second.objects).toContain("living.scene.recall");

    // A different model behind the address: the old declarations are void — re-asked.
    const third = setup({ Main_Zone: { power: true } });
    (third.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    third.client.modelName = "RX-V575";
    await third.controller.start();
    expect(third.client.calls.some(c => c.inner?.includes("Scene_Sel_Item"))).toBe(true);
    // The new device declared no scenes — none appear.
    expect(third.objects).not.toContain("living.scene.recall");
  });
});

describe("XmlDeviceController claim-with-proof creation (2.0.1)", () => {
  test("only states whose Basic_Status field the device delivers are created", async () => {
    // A MusicCast-era status: pureDirect/straight delivered, direct/hdmiOut2 never —
    // a blind full-catalog rollout left those standing as valueless objects.
    const s = setup({
      Main_Zone: {
        power: true,
        volume: -40,
        mute: false,
        input: "HDMI1",
        pureDirect: false,
        straight: true,
        hdmiOut1: true,
      },
    });
    await s.controller.start();
    expect(s.objects).toContain("living.sound.pureDirect");
    expect(s.objects).toContain("living.sound.straight");
    expect(s.objects).toContain("living.hdmiOut1");
    expect(s.objects).not.toContain("living.sound.direct");
    expect(s.objects).not.toContain("living.hdmiOut2");
  });

  test("a field remembered from an earlier run keeps its state on a leaner (standby) start", async () => {
    const memory = new ProbeMemory();
    memory.set("xmlStatusFields:main", ["power", "volume", "soundProgram"]);
    const s = setup({ Main_Zone: { power: false } });
    (s.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await s.controller.start();
    expect(s.objects).toContain("living.soundProgram");
    // What the device never delivered anywhere stays absent even so.
    expect(s.objects).not.toContain("living.sound.direct");
  });
});

describe("XmlDeviceController proof edge cases (2.0.1 hardening)", () => {
  test("each zone proves its OWN fields — main's straight does not leak a zone2 state", async () => {
    const s = setup({
      Main_Zone: { power: true, input: "HDMI1", straight: true },
      Zone_2: { power: false, input: "AUDIO1" },
    });
    await s.controller.start();
    expect(s.objects).toContain("living.sound.straight");
    expect(s.objects).not.toContain("living.multiroom.zone2.sound.straight");
    expect(s.objects).toContain("living.multiroom.zone2.input");
  });

  test("a field first delivered mid-run is remembered for the next start, never written without an object", async () => {
    const memory = new ProbeMemory();
    const s = setup({ Main_Zone: { power: true } });
    (s.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await s.controller.start();
    expect(s.objects).not.toContain("living.soundProgram");
    // The device (now powered on) starts delivering soundProgram in the poll.
    s.client.statuses = { Main_Zone: { power: true, soundProgram: "Standard" } };
    s.fire.keepalive?.();
    await flush();
    // No write lands without an object — but the field is remembered…
    expect(s.acks).not.toContainEqual({ id: "living.soundProgram", value: "Standard" });
    expect(memory.remembered<string[]>("xmlStatusFields:main")).toContain("soundProgram");
    // …so the NEXT start (same device memory) creates and fills it.
    const second = setup({ Main_Zone: { power: true, soundProgram: "Standard" } });
    (second.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
    await second.controller.start();
    expect(second.objects).toContain("living.soundProgram");
    expect(second.acks).toContainEqual({ id: "living.soundProgram", value: "Standard" });
  });
});

describe("XmlDeviceController probe memory verdicts (audit 2026-09-02)", () => {
  const sceneRequest = "Main_Zone|<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>";
  const withMemory = (s: ReturnType<typeof setup>, memory: ProbeMemory): void => {
    (s.controller as unknown as { deps: { probeMemory?: ProbeMemory } }).deps.probeMemory = memory;
  };

  test("a transient failure during the scene probe is NOT remembered — the next connect asks again", async () => {
    const memory = new ProbeMemory();
    const first = setup({ Main_Zone: { power: true } });
    withMemory(first, memory);
    first.client.modelName = "RX-V773";
    // A busy receiver: the scene probe times out while the zone status answered fine.
    first.client.xmlErrors[sceneRequest] = new Error("XML request timeout");
    expect(await first.controller.start()).toBe(true);
    expect(first.objects).not.toContain("living.scene.recall");
    // Before this fix the timeout was remembered as "declares no scenes" — until the model changed.
    expect(memory.remembered("xmlScenes:main")).toBeUndefined();

    const second = setup({ Main_Zone: { power: true } });
    withMemory(second, memory);
    second.client.modelName = "RX-V773";
    second.client.xmlAnswers[sceneRequest] = sceneDeclaration([{ num: 1, title: "Movie" }]);
    await second.controller.start();
    expect(second.client.calls.some(c => c.inner?.includes("Scene_Sel_Item"))).toBe(true);
    expect(second.objects).toContain("living.scene.recall");
  });

  test("a bodyless HTTP 400 IS remembered as 'declares none' — the model's own verdict", async () => {
    const memory = new ProbeMemory();
    const first = setup({ Main_Zone: { power: true } });
    withMemory(first, memory);
    first.client.modelName = "RX-V773";
    first.client.xmlErrors[sceneRequest] = new XmlHttpError("device refused the request (HTTP 400)", 400);
    await first.controller.start();
    expect(memory.remembered("xmlScenes:main")).toBe("");

    const second = setup({ Main_Zone: { power: true } });
    withMemory(second, memory);
    second.client.modelName = "RX-V773";
    await second.controller.start();
    expect(second.client.calls.some(c => c.inner?.includes("Scene_Sel_Item"))).toBe(false);
  });

  test("return code 2 is definite, a state-dependent refusal (RC 3/4) is not", async () => {
    const memory = new ProbeMemory();
    const rc2 = setup({ Main_Zone: { power: true } });
    withMemory(rc2, memory);
    rc2.client.modelName = "RX-V773";
    rc2.client.xmlAnswers[sceneRequest] = '<YAMAHA_AV rsp="GET" RC="2"><Main_Zone></Main_Zone></YAMAHA_AV>';
    await rc2.controller.start();
    expect(memory.remembered("xmlScenes:main")).toBe("");

    const memory2 = new ProbeMemory();
    const rc3 = setup({ Main_Zone: { power: true } });
    withMemory(rc3, memory2);
    rc3.client.modelName = "RX-V773";
    rc3.client.xmlAnswers[sceneRequest] = '<YAMAHA_AV rsp="GET" RC="3"><Main_Zone></Main_Zone></YAMAHA_AV>';
    await rc3.controller.start();
    expect(rc3.objects).not.toContain("living.scene.recall");
    expect(memory2.remembered("xmlScenes:main")).toBeUndefined();
  });

  test("a transient failure during the menu probe leaves the menus un-remembered, not 'none' for good", async () => {
    const memory = new ProbeMemory();
    const client = new FakeClient({ Main_Zone: { power: true } });
    client.getXml = (element: string, inner: string): Promise<string> => {
      client.calls.push({ method: "getXml", zone: element, inner });
      if (inner.includes("List_Info")) {
        return element === "NET_RADIO"
          ? Promise.reject(new Error("XML request timeout"))
          : Promise.reject(new XmlHttpError("device refused the request (HTTP 400)", 400));
      }
      return Promise.resolve("");
    };
    const objects: string[] = [];
    const controller = new XmlDeviceController("living", {
      client,
      scheduleKeepalive: () => () => {},
      upsertObject: id => {
        objects.push(id);
        return Promise.resolve();
      },
      setStateAck: () => {},
      log: silentLog,
      gate: testGate(),
      probeMemory: memory,
    });
    await controller.start();
    expect(objects.some(id => id.includes("player.browse"))).toBe(false);
    // The NET_RADIO menu could not be asked — so nothing is remembered and the next
    // connect probes again, instead of "this device has no menus" standing for good.
    expect(memory.remembered("xmlBrowseSources")).toBeUndefined();
  });
});

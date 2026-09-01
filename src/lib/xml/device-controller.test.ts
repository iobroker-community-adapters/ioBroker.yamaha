import { XmlDeviceController } from "./device-controller";
import type { XmlClientLike } from "./device-controller";
import type { BasicStatus } from "./protocol";
import { CommandGate } from "../lifecycle/command-gate";

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
  public constructor(private readonly statuses: Record<string, BasicStatus>) {}
  public async getStatus(zone: string): Promise<BasicStatus> {
    this.calls.push({ method: "getStatus", zone });
    return this.statuses[zone] ?? {};
  }
  public modelName: string | undefined = undefined;
  public async getModelName(): Promise<string | undefined> {
    this.calls.push({ method: "getModelName", zone: "" });
    return this.modelName;
  }
  public async send(zone: string, inner: string): Promise<void> {
    this.calls.push({ method: "send", zone, inner });
  }
  /** Probes (browse List_Info, scenes, inputs, tuner) — an empty body means "declares none". */
  public async getXml(zone: string, inner: string): Promise<string> {
    this.calls.push({ method: "getXml", zone, inner });
    return this.xmlAnswers[`${zone}|${inner}`] ?? "";
  }
}

/** A device-style Scene_Sel_Item declaration (the RX-V6A capture shape). */
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
      upsertObject: async (id, def) => {
        objects.push(id);
        defs.set(id, def);
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
    expect(s.objects).toContain("living.scene.name1");
    expect(s.acks).toContainEqual({ id: "living.scene.name1", value: "Movie Viewing" });
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
    expect(s.acks).toContainEqual({ id: "living.tuner.frequency", value: 98.1 });
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
    const s = setup({ Main_Zone: { power: true } });
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
    // The zone channel must carry its own readable name — created only from the
    // per-state parent loop it would be called "zone2" instead of "Zone 2".
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
    "<YAMAHA_AV rsp=\"GET\" RC=\"0\"><NET_RADIO><List_Info><Menu_Status>Ready</Menu_Status>" +
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
    client.getXml = async (element: string, inner: string): Promise<string> => {
      client.calls.push({ method: "getXml", zone: element, inner });
      if (element in answers) {
        return answers[element];
      }
      throw new Error("no such menu");
    };
    const objects: string[] = [];
    const controller = new XmlDeviceController("living", {
      client,
      scheduleKeepalive: () => () => {},
      upsertObject: async id => {
        objects.push(id);
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
  });
});

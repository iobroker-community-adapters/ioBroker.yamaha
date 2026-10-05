import type { CommandGate, CommandPriority } from "../lifecycle/command-gate";
import { settle, xmlHarness } from "../../../test/helpers/xml-controller";
import { XmlClient } from "./xml-client";
import { XmlRefusalError } from "./protocol";

// Review 2026-10-05, A55: only MusicCast asked whether the device is still there after a write nobody answered — a
// powerless XML receiver stayed "connected" for up to three poll minutes. A58: the read-back after a user write ran
// at background priority (derived from the GET) and waited behind the poll sweeps.

describe("a write nobody answered asks whether the device is still there (review 2026-10-05, A55)", () => {
  test("no answer to the write and none to the question: the drop is reported at once", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    await h.controller.start();
    const drops: Array<Error | undefined> = [];
    h.controller.onDrop(reason => drops.push(reason));
    h.client.sendError = new Error("EHOSTUNREACH");
    h.client.statusErrors.Main_Zone = new Error("EHOSTUNREACH");
    await expect(Promise.resolve(h.controller.handleWrite("power", false))).resolves.toBe("unavailable");
    await settle();
    expect(drops).toHaveLength(1);
  });

  test("a device that answers the question is not dropped; a refusal asks nothing", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    await h.controller.start();
    const drops: Array<Error | undefined> = [];
    h.controller.onDrop(reason => drops.push(reason));
    h.client.sendError = new Error("ECONNRESET");
    await h.controller.handleWrite("power", false);
    await settle();
    expect(drops).toEqual([]);
    h.client.calls.length = 0;
    h.client.statusErrors.Main_Zone = new Error("EHOSTUNREACH");
    h.client.sendError = new XmlRefusalError("<Main_Zone>", 3);
    await h.controller.handleWrite("power", false);
    await settle();
    // The refusal is read back (the device answered) — and that read is no liveness question.
    expect(drops).toEqual([]);
  });
});

describe("the read-back of a user write runs at user priority (review 2026-10-05, A58)", () => {
  test("zone, tuner, names, the all-zones power: every read-back is a user read; the poll stays background", async () => {
    const h = xmlHarness({ Main_Zone: { power: true, volume: -40 } });
    h.client.xmlAnswers["System|<Power_Control><Power>GetParam</Power></Power_Control>"] =
      '<YAMAHA_AV rsp="GET" RC="0"><System><Power_Control><Power>On</Power></Power_Control></System></YAMAHA_AV>';
    h.client.xmlAnswers["Main_Zone|<Config>GetParam</Config>"] =
      '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Config><Name><Zone>Living</Zone></Name></Config></Main_Zone></YAMAHA_AV>';
    await h.controller.start();
    const reads = (): Array<{ zone: string; priority?: string }> =>
      h.client.calls
        .filter(call => call.method !== "send")
        .map(call => ({ zone: call.zone, ...(call.priority ? { priority: call.priority } : {}) }));
    h.client.calls.length = 0;
    await h.controller.handleWrite("volume", -35);
    await h.controller.handleWrite("multiroom.masterPower", true);
    await h.controller.handleWrite("zoneName", "Den");
    await settle();
    expect(reads()).toEqual([
      { zone: "Main_Zone", priority: "user" },
      { zone: "System", priority: "user" },
      { zone: "Main_Zone", priority: "user" },
    ]);
    h.client.calls.length = 0;
    h.poll();
    await settle();
    expect(reads().every(read => read.priority === "background")).toBe(true);
  });

  test("the client hands the caller's priority to the command gate; a plain read stays background, a command user", async () => {
    const priorities: CommandPriority[] = [];
    const gate = {
      run: <T>(run: () => Promise<T> | T, priority: CommandPriority = "background"): Promise<T> => {
        priorities.push(priority);
        return Promise.resolve(run());
      },
    } as unknown as CommandGate;
    const client = new XmlClient("192.0.2.10", () => Promise.resolve('<YAMAHA_AV rsp="GET" RC="0"></YAMAHA_AV>'), gate);
    await client.getXml("Main_Zone", "<Config>GetParam</Config>");
    await client.getXml("Main_Zone", "<Config>GetParam</Config>", "user");
    await client.getStatus("Main_Zone", "user");
    await client.send("Main_Zone", "<Power_Control><Power>On</Power></Power_Control>");
    expect(priorities).toEqual(["background", "user", "user", "user"]);
  });
});

import { coordinateObjectTree } from "./object-tree-coordinator";
import type { ObjectDef } from "./types";

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}
function channel(id: string, name: string): ObjectDef {
  return { id, type: "channel", common: { name } };
}

describe("coordinateObjectTree — one unified tree from the transports' catalogs", () => {
  test("a shared capability is emitted once, from its owner, under the canonical id", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "ynca", objects: [state("volume", "Volume dB", { unit: "dB" }), state("sound.bass", "Bass")] },
      { transport: "yxc", objects: [state("volume", "Volume raw"), state("dist.role", "Role", { type: "string" })] },
    ]);
    const ids = objects.map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(["volume", "sound.bass", "dist.role"]));
    // volume shared → YNCA owner (dB, not YXC's raw scale)
    expect(objects.filter(o => o.id === "volume").length).toBe(1);
    expect(objects.find(o => o.id === "volume")?.common.name).toBe("Volume dB");
    expect(ownerByCanonicalId.get("volume")).toBe("ynca");
    // sound.bass is YNCA's own id already — no drift needed since the catalog rename
    expect(objects.some(o => o.id === "bass")).toBe(false);
    // dist.role is YXC-exclusive
    expect(ownerByCanonicalId.get("dist.role")).toBe("yxc");
  });

  test("the most modern transport wins an equal shared capability (YXC over YNCA)", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "ynca", objects: [state("power", "Power YNCA", { type: "boolean" })] },
      { transport: "yxc", objects: [state("power", "Power YXC", { type: "boolean" })] },
    ]);
    expect(objects.find(o => o.id === "power")?.common.name).toBe("Power YXC");
    expect(ownerByCanonicalId.get("power")).toBe("yxc");
  });

  test("a zoned shared capability collapses per-zone across transports", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [state("multiroom.zone2.volume", "Z2 dB")] },
      { transport: "yxc", objects: [state("multiroom.zone2.volume", "Z2 raw")] },
    ]);
    expect(objects.filter(o => o.id === "multiroom.zone2.volume").length).toBe(1);
    expect(objects.find(o => o.id === "multiroom.zone2.volume")?.common.name).toBe("Z2 dB");
  });

  test("parents come before children (channels before their states)", () => {
    const { objects } = coordinateObjectTree([
      { transport: "yxc", objects: [state("dist.role", "Role"), channel("dist", "Multiroom")] },
    ]);
    const distIdx = objects.findIndex(o => o.id === "dist");
    const roleIdx = objects.findIndex(o => o.id === "dist.role");
    expect(distIdx).toBeGreaterThanOrEqual(0);
    expect(distIdx).toBeLessThan(roleIdx);
  });
});

describe("dropdown borrowing (v2.0.0 — labels from a non-owning transport)", () => {
  test("the owner's def borrows a states map another claimant carries", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      {
        transport: "yxc",
        objects: [
          {
            id: "scene.recall",
            type: "state",
            common: { name: "Recall scene", type: "number", role: "level", read: true, write: true },
          },
        ],
      },
      {
        transport: "xml",
        objects: [
          {
            id: "scene.recall",
            type: "state",
            common: {
              name: "Recall scene",
              type: "number",
              role: "level",
              read: true,
              write: true,
              states: { 1: "Movie Viewing", 2: "Radio Listening" },
            },
          },
        ],
      },
    ]);
    // MusicCast wins the write path (the proven-writer override)…
    expect(ownerByCanonicalId.get("scene.recall")).toBe("yxc");
    // …but the picker still shows the titles only XML could deliver.
    expect(objects.find(o => o.id === "scene.recall")?.common.states).toEqual({
      1: "Movie Viewing",
      2: "Radio Listening",
    });
  });

  test("an owner with its own states map keeps it", () => {
    const { objects } = coordinateObjectTree([
      {
        transport: "ynca",
        objects: [
          {
            id: "input",
            type: "state",
            common: {
              name: "Input",
              type: "string",
              role: "media.input",
              read: true,
              write: true,
              states: { HDMI1: "HDMI1" },
            },
          },
        ],
      },
      {
        transport: "xml",
        objects: [
          {
            id: "input",
            type: "state",
            common: {
              name: "Input",
              type: "string",
              role: "media.input",
              read: true,
              write: true,
              states: { AV1: "AV1" },
            },
          },
        ],
      },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual({ HDMI1: "HDMI1" });
  });
});

describe("declared value lists beat a catalog union (#619)", () => {
  const input = (states: Record<string, string>, opts: { declared?: boolean; id?: string } = {}): ObjectDef => ({
    id: opts.id ?? "input",
    type: "state",
    ...(opts.declared ? { declaredStates: true } : {}),
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true, states },
  });
  const union = { HDMI1: "HDMI1", AV1: "AV1", Spotify: "Spotify" };

  test("the XML input list replaces the YNCA union on the YNCA-owned input", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "ynca", objects: [input(union)] },
      { transport: "xml", objects: [input({ HDMI1: "HDMI1", "NET RADIO": "NET RADIO" }, { declared: true })] },
    ]);
    // YNCA keeps the write path (its INP push, its vocabulary) …
    expect(ownerByCanonicalId.get("input")).toBe("ynca");
    // … but the picker shows what the device itself declares.
    const resolved = objects.find(o => o.id === "input");
    expect(resolved?.common.states).toEqual({ HDMI1: "HDMI1", "NET RADIO": "NET RADIO" });
    expect(resolved?.declaredStates).toBe(true);
  });

  test("a MusicCast list with a soundbar id is never adopted by a YNCA-owned input — different wire vocabulary", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [input(union)] },
      { transport: "yxc", objects: [input({ hdmi: "hdmi", analog: "analog" }, { declared: true })] },
    ]);
    // "hdmi" is not a value the YNCA write path can send — the union stays.
    expect(objects.find(o => o.id === "input")?.common.states).toEqual(union);
  });

  test("an owner's own declaration is kept over another transport's", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "yxc", objects: [input({ hdmi1: "hdmi1" }, { declared: true })] },
      { transport: "xml", objects: [input({ HDMI1: "HDMI1" }, { declared: true })] },
    ]);
    expect(ownerByCanonicalId.get("input")).toBe("yxc");
    expect(objects.find(o => o.id === "input")?.common.states).toEqual({ hdmi1: "hdmi1" });
  });

  test("the union stays where nobody declares", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [input(union)] },
      { transport: "xml", objects: [input({ AV1: "AV1" })] },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual(union);
  });

  test("a zone's declaration lands on that zone's datapoint only", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [input(union), input(union, { id: "multiroom.zone2.input" })] },
      {
        transport: "xml",
        objects: [
          input(
            { AUDIO1: "AUDIO1", "Main Zone Sync": "Main Zone Sync" },
            { declared: true, id: "multiroom.zone2.input" },
          ),
        ],
      },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual(union);
    expect(objects.find(o => o.id === "multiroom.zone2.input")?.common.states).toEqual({
      AUDIO1: "AUDIO1",
      "Main Zone Sync": "Main Zone Sync",
    });
  });
});

describe("a MusicCast list reaches a YNCA-owned datapoint through the dictionary (#619)", () => {
  const input = (states: Record<string, string>, declared = false): ObjectDef => ({
    id: "input",
    type: "state",
    ...(declared ? { declaredStates: true } : {}),
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true, states },
  });
  const program = (states: Record<string, string>, declared = false): ObjectDef => ({
    id: "soundProgram",
    type: "state",
    ...(declared ? { declaredStates: true } : {}),
    common: { name: "Program", type: "string", role: "state", read: true, write: true, states },
  });

  test("adopted in the classic spelling when no XML list exists", () => {
    const { objects, ownerByCanonicalId } = coordinateObjectTree([
      { transport: "ynca", objects: [input({ HDMI1: "HDMI1", AV1: "AV1", Spotify: "Spotify" })] },
      { transport: "yxc", objects: [input({ hdmi1: "hdmi1", net_radio: "net_radio", juke: "juke" }, true)] },
    ]);
    expect(ownerByCanonicalId.get("input")).toBe("ynca");
    const resolved = objects.find(o => o.id === "input");
    expect(resolved?.common.states).toEqual({ HDMI1: "HDMI1", "NET RADIO": "NET RADIO", JUKE: "JUKE" });
    expect(resolved?.declaredStates).toBe(true);
  });

  test("the XML list wins over the translated MusicCast list — the device's own spelling beats the dictionary", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [input({ HDMI1: "HDMI1", AV1: "AV1" })] },
      { transport: "yxc", objects: [input({ hdmi1: "hdmi1", net_radio: "net_radio" }, true)] },
      { transport: "xml", objects: [input({ HDMI1: "HDMI1" }, true)] },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual({ HDMI1: "HDMI1" });
  });

  test("a MusicCast list with an untranslatable id leaves the union standing", () => {
    const union = { HDMI1: "HDMI1", AV1: "AV1" };
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [input(union)] },
      { transport: "yxc", objects: [input({ hdmi: "hdmi", analog: "analog" }, true)] },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual(union);
  });

  test("a MusicCast program list lands on the YNCA-owned soundProgram, translated, straight skipped", () => {
    const { objects } = coordinateObjectTree([
      {
        transport: "ynca",
        objects: [program({ "Hall in Munich": "Hall in Munich", Disco: "Disco", Standard: "Standard" })],
      },
      { transport: "yxc", objects: [program({ munich: "munich", standard: "standard", straight: "straight" }, true)] },
    ]);
    expect(objects.find(o => o.id === "soundProgram")?.common.states).toEqual({
      "Hall in Munich": "Hall in Munich",
      Standard: "Standard",
    });
  });

  test("a MusicCast-owned datapoint keeps its own ids — the dictionary only serves the classic owner", () => {
    const { objects } = coordinateObjectTree([
      { transport: "yxc", objects: [input({ hdmi1: "hdmi1", net_radio: "net_radio" }, true)] },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual({ hdmi1: "hdmi1", net_radio: "net_radio" });
  });
});

describe("the value the owner reports always stays on an adopted declared list (2026-09-09)", () => {
  const input = (states: Record<string, string>, extra: Partial<ObjectDef> = {}): ObjectDef => ({
    id: "input",
    type: "state",
    ...extra,
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true, states },
  });

  test("an XML declaration that lacks the input YNCA reports right now gets that value appended", () => {
    const { objects } = coordinateObjectTree([
      {
        transport: "ynca",
        objects: [input({ HDMI1: "HDMI1", TV: "TV", Spotify: "Spotify" }, { reportedValue: "TV" })],
      },
      { transport: "xml", objects: [input({ HDMI1: "HDMI1", AV1: "AV1" }, { declaredStates: true })] },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual({ HDMI1: "HDMI1", AV1: "AV1", TV: "TV" });
  });

  test("a translated MusicCast list gets the YNCA-reported value too, and nothing is appended when it is already there", () => {
    const { objects } = coordinateObjectTree([
      { transport: "ynca", objects: [input({ HDMI1: "HDMI1", TV: "TV" }, { reportedValue: "TV" })] },
      { transport: "yxc", objects: [input({ hdmi1: "hdmi1", net_radio: "net_radio" }, { declaredStates: true })] },
    ]);
    expect(objects.find(o => o.id === "input")?.common.states).toEqual({
      HDMI1: "HDMI1",
      "NET RADIO": "NET RADIO",
      TV: "TV",
    });
    const same = coordinateObjectTree([
      { transport: "ynca", objects: [input({ HDMI1: "HDMI1" }, { reportedValue: "HDMI1" })] },
      { transport: "xml", objects: [input({ HDMI1: "HDMI1", AV1: "AV1" }, { declaredStates: true })] },
    ]);
    expect(same.objects.find(o => o.id === "input")?.common.states).toEqual({ HDMI1: "HDMI1", AV1: "AV1" });
  });
});

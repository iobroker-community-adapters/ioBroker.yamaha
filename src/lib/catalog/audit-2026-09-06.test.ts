import { describe, it, expect } from "vitest";
import { channelCommon, CHANNEL_DESC_KEYS } from "./types";
import { pickOwner } from "./owner-policy";
import { coordinateObjectTree } from "./object-tree-coordinator";
import { parseYxcFeatures } from "../yxc/capability";
import { mapYxcToObjects } from "../yxc/object-mapper";
import { presentSystemEntries, YXC_SYSTEM_CATALOG } from "../yxc/system-catalog";
import { YXC_CURSOR_VALUES, YXC_MENU_VALUES, isRemoteWord } from "../yxc/remote";
import { CURSOR_VALUES, MENU_VALUES } from "../browse/types";

/**
 * The rules the 2026-09-06 audit put into the code. Each of these was a live defect measured
 * over the bundled captures of 25 MusicCast models and 15 YNCA device protocols — no single
 * receiver decides any of it.
 */
describe("audit 2026-09-06 — a folder's explanation reaches every transport", () => {
  it("channelCommon answers name AND explanation from the one table", () => {
    const player = channelCommon("player");
    expect(player.name).toBeTruthy();
    expect(player.desc).toBeTruthy();
  });

  it("falls back to the capitalised segment for a device-derived folder, with no invented desc", () => {
    expect(channelCommon("monday")).toEqual({ name: "Monday" });
  });

  it("a folder that carries an explanation carries a TRANSLATED name too", () => {
    // The two tables are independent, and a segment listed in only one of them comes out
    // half-translated: `browse` had an explanation in eleven languages next to the hard-coded
    // English fallback "Browse" — on every device, invisible to the source-level gate, and
    // found only when the object inventory measured the built tree (2026-09-07).
    for (const segment of Object.keys(CHANNEL_DESC_KEYS)) {
      expect(typeof channelCommon(segment).name, `folder ${segment}`).toBe("object");
    }
  });

  it("every folder the table explains really gets that explanation", () => {
    // The MusicCast object mapper and the XML controller used to build their folders with a
    // name only, so 300 of 303 folders across all captures carried no explanation at all.
    for (const segment of Object.keys(CHANNEL_DESC_KEYS)) {
      expect(channelCommon(segment).desc, `folder ${segment}`).toBeTruthy();
    }
  });
});

describe("audit 2026-09-06 — a proof beats the modernity rank", () => {
  it("prefers the transport that proved the capability", () => {
    // YNCA outranks XML, but a receiver in standby cannot prove its menu claim — and that
    // unproven claim used to displace the XML driver that DID answer a real List_Info (#613).
    expect(pickOwner("player.browse.source", ["ynca", "xml"], new Set(["ynca"]))).toBe("xml");
  });

  it("still uses an unproven claim when nobody else offers the capability", () => {
    expect(pickOwner("player.browse.source", ["ynca"], new Set(["ynca"]))).toBe("ynca");
  });

  it("creates the folder that id drift invents", () => {
    // XML's `hdmiOut1` is one flat segment, so its own parent loop builds no channel — and the
    // canonical id `hdmi.out1` needs an `hdmi` folder that then belongs to nobody. On an XML-only
    // receiver the datapoint's parent object was simply missing (repochecker E3009).
    const { objects } = coordinateObjectTree([
      { transport: "xml", objects: [{ id: "hdmiOut1", type: "state", common: { name: "x" } }] },
    ]);
    const hdmi = objects.find(o => o.id === "hdmi");
    expect(hdmi?.type).toBe("channel");
    expect(typeof hdmi?.common.name).toBe("object");
    // Parents stay ahead of their children, so the folder exists before the datapoint is written.
    expect(objects.findIndex(o => o.id === "hdmi")).toBeLessThan(objects.findIndex(o => o.id === "hdmi.out1"));
  });

  it("the coordinator reads the flag off the object definitions", () => {
    const { ownerByCanonicalId } = coordinateObjectTree([
      {
        transport: "ynca",
        objects: [{ id: "player.browse.source", type: "state", common: { name: "x" }, unproven: true }],
      },
      { transport: "xml", objects: [{ id: "player.browse.source", type: "state", common: { name: "x" } }] },
    ]);
    expect(ownerByCanonicalId.get("player.browse.source")).toBe("xml");
  });
});

describe("audit 2026-09-06 — the device's own bounds reach the datapoint", () => {
  const features = {
    zone: [
      {
        id: "main",
        func_list: ["volume", "tone_control", "subwoofer_volume", "equalizer"],
        range_step: [
          { id: "volume", min: 0, max: 161, step: 1 },
          { id: "tone_control", min: -12, max: 12, step: 1 },
          { id: "subwoofer_volume", min: -10, max: 10, step: 1 },
          { id: "equalizer", min: -6, max: 6, step: 1 },
        ],
      },
    ],
  };

  it("bass, treble, subwoofer trim and the equalizer bands carry min/max/step", () => {
    const objects = mapYxcToObjects(parseYxcFeatures(features));
    for (const id of ["sound.bass", "sound.treble", "subwooferVolume", "sound.equalizer.low"]) {
      const object = objects.find(o => o.id === id);
      expect(object?.common.min, id).toBeDefined();
      expect(object?.common.max, id).toBeDefined();
      expect(object?.common.step, id).toBeDefined();
    }
  });

  it("does not claim decibels for the tone controls", () => {
    // MusicCast counts them in half-decibels: −12…+12 in 25 steps is the range the YNCA spec
    // calls −6…+6 dB in 25 steps of 0.5, measured across 19 captures.
    const objects = mapYxcToObjects(parseYxcFeatures(features));
    expect(objects.find(o => o.id === "sound.bass")?.common.unit).toBeUndefined();
    expect(objects.find(o => o.id === "sound.treble")?.common.unit).toBeUndefined();
  });

  it("hands the tone controls to the transport whose scale is documented in decibels", () => {
    expect(pickOwner("sound.bass", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("sound.treble", ["yxc", "xml"])).toBe("xml");
    expect(pickOwner("sound.subwooferTrim", ["yxc", "xml"])).toBe("xml");
    // The common case a missing override entry would break: a MusicCast AVR that also speaks
    // YNCA. `sound.subwooferTrim` reached YNCA only with this audit's catalog wave (MAIN:SWFRTRIM),
    // so without YNCA in the preference list MusicCast would win back the very scale conflict the
    // override exists to prevent — and no test asked this pairing.
    expect(pickOwner("sound.subwooferTrim", ["yxc", "ynca"])).toBe("ynca");
    expect(pickOwner("sound.bass", ["yxc", "ynca", "xml"])).toBe("ynca");
    // A MusicCast-only device keeps its own scale — with its own declared bounds.
    expect(pickOwner("sound.bass", ["yxc"])).toBe("yxc");
    expect(pickOwner("sound.subwooferTrim", ["yxc"])).toBe("yxc");
  });
});

describe("audit 2026-09-06 — the device-wide MusicCast settings", () => {
  it("creates only the settings this device really answers", () => {
    expect(presentSystemEntries({ auto_power_standby: true }).map(e => e.state)).toEqual(["advanced.autoPowerStandby"]);
    expect(presentSystemEntries({})).toEqual([]);
    expect(presentSystemEntries(null)).toEqual([]);
  });

  it("skips a field the device reports as absent", () => {
    expect(presentSystemEntries({ hdmi_out_1: null })).toEqual([]);
  });

  it("every entry can be read, and carries a setter unless the API documents none", () => {
    for (const entry of YXC_SYSTEM_CATALOG) {
      expect(entry.common.read, entry.state).toBe(true);
      expect(entry.common.write === true, entry.state).toBe(entry.write !== undefined);
    }
  });
});

describe("audit 2026-09-06 — one remote vocabulary, not four", () => {
  it("MusicCast's words are a subset of the shared vocabulary", () => {
    for (const value of YXC_CURSOR_VALUES) {
      expect(CURSOR_VALUES).toContain(value);
    }
    for (const value of YXC_MENU_VALUES) {
      expect(MENU_VALUES).toContain(value);
    }
  });

  it("the cursor pad ends at return on MusicCast — home is a MENU key there", () => {
    expect(YXC_CURSOR_VALUES).not.toContain("home");
    expect(YXC_MENU_VALUES).toContain("home");
  });

  it("a written word outside the vocabulary never reaches the device", () => {
    expect(isRemoteWord(YXC_CURSOR_VALUES, "up")).toBe(true);
    expect(isRemoteWord(YXC_CURSOR_VALUES, "home")).toBe(false);
    expect(isRemoteWord(YXC_CURSOR_VALUES, 7)).toBe(false);
  });
});

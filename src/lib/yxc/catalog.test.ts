import { disableBitOf, YXC_AMP_CATALOG } from "./catalog";

/**
 * Table test over the whole YXC catalog. Every entry with a `write.apply` is a
 * writable datapoint in the user's tree; the lambda calls the client directly, so
 * a wrong method or a missing zone argument is a button that does nothing (or
 * changes the wrong zone). Driving the list itself covers new entries as they land.
 */
describe("YXC_AMP_CATALOG", () => {
  /** A client that records the method name and arguments instead of talking HTTP. */
  function recordingClient(): { calls: Array<{ method: string; args: unknown[] }>; client: never } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const client = new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (method === "then") {
            return undefined;
          }
          return (...args: unknown[]) => {
            calls.push({ method, args });
            return Promise.resolve({ response_code: 0 });
          };
        },
      },
    );
    return { calls, client: client as never };
  }

  /** The entries whose setter the catalog calls itself. */
  const setters = YXC_AMP_CATALOG.flatMap(entry =>
    entry.write?.kind === "set" ? [{ entry, write: entry.write }] : [],
  );

  /**
   * The writes the CONTROLLER completes: they need state the catalog does not have (the device sets all three
   * equalizer bands together; the datapoint carries what the receiver DISPLAYS while setVolume takes the raw step
   * count). They are declared on the entry as their kind — a writable datapoint without any write mapping is one the
   * user can change and that never reaches the device.
   */
  const CONTROLLER_COMPLETED: Record<string, string> = {
    "sound.equalizer.low": "equalizer",
    "sound.equalizer.mid": "equalizer",
    "sound.equalizer.high": "equalizer",
    volume: "volume",
  };

  it("offers a write mapping for exactly the writable entries", () => {
    for (const entry of YXC_AMP_CATALOG) {
      expect(Boolean(entry.write), `${entry.state} write/apply mismatch`).toBe(entry.common.write === true);
      expect(entry.write?.kind ?? "-", entry.state).toBe(
        entry.write ? (CONTROLLER_COMPLETED[entry.state] ?? "set") : "-",
      );
    }
    expect(setters.length).toBeGreaterThan(5);
  });

  it("sends every writable entry to the device, addressed to the written zone", async () => {
    for (const { entry, write } of setters) {
      const { calls, client } = recordingClient();
      const sample = entry.common.type === "boolean" ? true : entry.common.type === "number" ? 5 : "straight";
      await write.apply(client, sample, "zone2");
      expect(calls, `${entry.state} sent nothing`).toHaveLength(1);
      // Dropping the zone makes every write land in the main zone — the classic
      // "zone 2 volume changes the living room" bug.
      const carriesZone = calls[0].args.includes("zone2");
      const zoneless = ["multiroom.party"];
      expect(carriesZone || zoneless.some(z => entry.state.startsWith(z)), `${entry.state} lost its zone`).toBe(true);
    }
  });

  it("reads every entry back from a status field or path", () => {
    for (const entry of YXC_AMP_CATALOG) {
      const read = entry.read as { field?: string; path?: string[] };
      expect(Boolean(read.field) || (read.path?.length ?? 0) > 0, `${entry.state} has no read source`).toBe(true);
      // fromStatus must coerce, not pass through: an undefined reaching a boolean state makes js-controller reject
      // the write. An answer that names no value is `null` — never a guessed switch, never NaN.
      expect(entry.fromStatus(undefined), entry.state).toBeNull();
    }
  });

  // `Boolean(value)` read the word "false" as on (review 2026-10-05, KISS): every entry reads by its type.
  it("reads a switch, a number and a word by their type — an answer of another type is no value", () => {
    const byState = new Map(YXC_AMP_CATALOG.map(entry => [entry.state, entry]));
    expect(byState.get("mute")?.fromStatus("false")).toBe(false);
    expect(byState.get("mute")?.fromStatus(true)).toBe(true);
    expect(byState.get("mute")?.fromStatus("maybe")).toBeNull();
    expect(byState.get("power")?.fromStatus("standby")).toBe(false);
    expect(byState.get("power")?.fromStatus("on")).toBe(true);
    // The sleep timer reads in the receiver's words, as over YNCA and XML.
    expect(byState.get("sleep")?.fromStatus(60)).toBe("60 min");
    expect(byState.get("sleep")?.fromStatus(0)).toBe("Off");
    expect(byState.get("sleep")?.fromStatus("abc")).toBeNull();
    expect(byState.get("input")?.fromStatus(" hdmi1 ")).toBe("hdmi1");
    expect(byState.get("input")?.fromStatus("")).toBeNull();
  });

  // The five side tables keyed by id strings (review 2026-10-05, DRY) stand on the entries now — with exactly the
  // pairs they held.
  it("carries the range, list, disable bit and scale the side tables held", () => {
    const declared = (key: "range" | "list" | "disableBit" | "scale"): Record<string, unknown> =>
      Object.fromEntries(YXC_AMP_CATALOG.filter(entry => entry[key] !== undefined).map(e => [e.state, e[key]]));
    expect(declared("range")).toEqual({
      volume: "volume",
      "sound.bass": "tone_control",
      "sound.treble": "tone_control",
      subwooferVolume: "subwoofer_volume",
      "sound.dialogueLevel": "dialogue_level",
      "sound.dialogueLift": "dialogue_lift",
      "sound.dtsDialogueControl": "dts_dialogue_control",
      "sound.balance": "balance",
      "sound.equalizer.low": "equalizer",
      "sound.equalizer.mid": "equalizer",
      "sound.equalizer.high": "equalizer",
    });
    expect(declared("list")).toEqual({
      soundProgram: "sound_program_list",
      "sound.surroundDecoder": "surr_decoder_type_list",
      "sound.toneMode": "tone_control_mode_list",
      "sound.equalizer.mode": "equalizer_mode_list",
      "sound.audioSelect": "audio_select_list",
      "sound.linkControl": "link_control_list",
      "sound.linkAudioDelay": "link_audio_delay_list",
      "sound.linkAudioQuality": "link_audio_quality_list",
    });
    // YXC Basic §5.1 `disable_flags`: b0 volume, b1 mute, b2 link audio delay.
    expect(declared("disableBit")).toEqual({ volume: 0b1, mute: 0b10, "sound.linkAudioDelay": 0b100 });
    expect([disableBitOf("volume"), disableBitOf("mute"), disableBitOf("sound.bass")]).toEqual([0b1, 0b10, undefined]);
    expect(declared("scale")).toEqual({
      volume: "volume",
      "advanced.maxVolume": "volumeLimit",
      "sound.bass": "halfDb",
      "sound.treble": "halfDb",
    });
  });

  it("keeps every state id unique", () => {
    const ids = YXC_AMP_CATALOG.map(e => e.state);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

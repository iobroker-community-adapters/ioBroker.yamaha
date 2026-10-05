import type { ObjectDef } from "../catalog/types";
import { writableNumber } from "../catalog/value-coerce";
import { errText } from "../err-text";
import { tName } from "../i18n";
import { MEMORY_KEY } from "../lifecycle/memory-keys";
import type { XmlControllerContext, XmlWriteRoute } from "./controller-context";
import { parsePresetList, parseTunerInfo, type XmlPresetSlot, type XmlTunerInfo } from "./protocol";

/** The tuner's own status read (`Tuner,Play_Info`). */
const PLAY_INFO_GET = "<Play_Info>GetParam</Play_Info>";

/** The tuner's declared preset slots (`Tuner,Play_Control,Preset,Preset_Sel_Item`, desc.xml `G3`). */
const PRESET_LIST_GET = "<Play_Control><Preset><Preset_Sel_Item>GetParam</Preset_Sel_Item></Preset></Play_Control>";

/**
 * The classic tuner surface (pre-2010 devices, where XML is the ONLY transport — the predecessor served their tuner,
 * the rewrite had dropped it): preset, band, frequency, RDS, tuned and stereo under `tuner.*`. Existence is probed
 * once per device; the preset write is the openHAB-verified `<Play_Control><Preset><Preset_Sel>`, band and frequency
 * are written through `Tuning`. On newer devices YNCA/YXC own these ids via the owner policy.
 */
export class XmlTuner implements XmlWriteRoute {
  /** Whether the device answers `<Tuner><Play_Info>` (the classic pre-2010 tuner). */
  private present = false;
  /** The slots the tuner declares (`Preset_Sel_Item`) — the values a recall takes (D2). */
  private presetSlots: XmlPresetSlot[] = [];
  /** The band the tuner last reported, and how its frequency is spelled (D6). */
  private tunerBand: string | undefined;
  private freqForm: "band" | "flat" = "band";

  /**
   * @param ctx the controller's shared context
   */
  public constructor(private readonly ctx: XmlControllerContext) {}

  /** @returns whether the device has the classic tuner (answered its Play_Info) */
  public get exists(): boolean {
    return this.present;
  }

  /** Probe the tuner and build its datapoints — only the fields its Play_Info carries. */
  public async setup(): Promise<void> {
    const ctx = this.ctx;
    const probe = await ctx.probeXml(MEMORY_KEY.xmlTuner, "Tuner", PLAY_INFO_GET);
    if (probe.length === 0) {
      return;
    }
    this.present = true;
    await ctx.ensureChannels("tuner.preset");
    // Only the fields this device's Play_Info carries become datapoints — the remembered probe is the
    // proof of existence, never the source of a value (D7: an RX-V675 has no RDS block and carried
    // three RDS datapoints that never got a value).
    const carried = parseTunerInfo(probe);
    this.freqForm = carried.freqForm ?? "band";
    const state = async (id: keyof XmlTunerInfo, common: ObjectDef["common"]): Promise<void> => {
      if (carried[id] === undefined && !(id === "preset" && /<Preset[>_]/.test(probe))) {
        return;
      }
      await ctx.deps.upsertObject(`${ctx.deviceId}.tuner.${id}`, { id: `tuner.${id}`, type: "state", common });
    };
    // The slots the device declares (`Preset_Sel_Item`, desc.xml `Indirect G3`) — the 2008 generation
    // names them `A1…E8`; 0 is "no preset", as on YNCA and MusicCast (audit 2026-09-29, D2).
    this.presetSlots = parsePresetList(await ctx.probeXml(MEMORY_KEY.xmlTunerPresets, "Tuner", PRESET_LIST_GET));
    const slots = this.presetSlots;
    await state("preset", {
      name: tName("presetRecallByNumber"),
      desc: tName("descPresetRecallByNumber"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
      max: slots.length > 0 ? Math.max(...slots.map(slot => slot.num)) : 40,
      step: 1,
      ...(slots.length > 0 ? { states: Object.fromEntries(slots.map(slot => [slot.num, slot.title])) } : {}),
    });
    // The band and the frequency are written too — the XML-only generation had no way to tune (D6).
    await state("band", {
      name: tName("band"),
      type: "string",
      role: "state",
      read: true,
      write: true,
      states: { AM: "AM", FM: "FM" },
    });
    await state("frequency", {
      name: tName("frequency"),
      type: "number",
      role: "level",
      unit: "kHz",
      read: true,
      write: true,
    });
    await state("rdsService", {
      name: tName("rdsStation"),
      desc: tName("descRdsStation"),
      type: "string",
      role: "text",
      read: true,
      write: false,
    });
    await state("rdsText", {
      name: tName("rdsText"),
      desc: tName("descRdsText"),
      type: "string",
      role: "text",
      read: true,
      write: false,
    });
    await state("rdsTextB", {
      name: tName("rdsTextB"),
      desc: tName("descRdsTextB"),
      type: "string",
      role: "text",
      read: true,
      write: false,
    });
    await state("tuned", {
      name: tName("tunedToAStation"),
      desc: tName("descTunedToAStation"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    });
    await state("stereo", {
      name: tName("stereoReception"),
      desc: tName("descStereoReception"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    });
    // NOT `emitTunerInfo(probe)`: the probe body comes out of the PERSISTED memory on every
    // reconnect and restart, so seeding from it published a snapshot of an earlier session
    // — frequency, RDS station and text, "tuned" — as the CURRENT reading, until the first
    // poll up to a whole interval later. The existence verdict is a model property and stays
    // remembered; the values are read fresh. (Same class as the menu's resting shape, which
    // showed rows six days older than the connection until it was fixed.)
    await this.refresh();
  }

  /** Poll the tuner's Play_Info (keepalive, read-back) and write the states. */
  public async refresh(): Promise<void> {
    try {
      this.emitTunerInfo(await this.ctx.deps.client.getXml("Tuner", PLAY_INFO_GET));
    } catch (e) {
      this.ctx.deps.log.debug(`${this.ctx.deviceId}: tuner Play_Info failed: ${errText(e)}`);
    }
  }

  /**
   * Whether a write is the tuner's: `tuner.preset`, `tuner.band`, `tuner.frequency`.
   *
   * @param stateId the state id relative to the device
   * @returns true for the three tuner datapoints
   */
  public serves(stateId: string): boolean {
    return stateId === "tuner.preset" || stateId === "tuner.band" || stateId === "tuner.frequency";
  }

  /**
   * A user write to a tuner state: `tuner.preset` → the openHAB-verified preset recall,
   * `tuner.band`/`tuner.frequency` → {@link writeTuning}.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   */
  public write(stateId: string, value: unknown): void {
    if (stateId === "tuner.band" || stateId === "tuner.frequency") {
      this.writeTuning(stateId, value);
      return;
    }
    if (!this.present) {
      return;
    }
    // Number(true) is 1 — a switch bound here by mistake recalled preset 1 (audit 2026-09-24, D20).
    const num = Math.round(writableNumber(value) ?? Number.NaN);
    if (!Number.isFinite(num) || num < 1) {
      return;
    }
    // The device's own spelling of the slot (`A1` on the 2008 generation); a slot it does not
    // declare is not sent (D2).
    const code = this.presetSlots.length > 0 ? this.presetSlots.find(slot => slot.num === num)?.code : String(num);
    if (code === undefined) {
      this.ctx.deps.log.debug(
        `${this.ctx.deviceId}: tuner preset ${num} is not a slot this device declares — not sent`,
      );
      return;
    }
    void this.ctx.applyCommand(
      { zone: "Tuner", inner: `<Play_Control><Preset><Preset_Sel>${code}</Preset_Sel></Preset></Play_Control>` },
      () => this.refresh(),
    );
  }

  /**
   * Write the tuner states from a Play_Info response.
   *
   * @param xml the Play_Info response body
   */
  private emitTunerInfo(xml: string): void {
    const info = parseTunerInfo(xml);
    const emit = (id: string, value: boolean | number | string | undefined): void => {
      if (value !== undefined) {
        this.ctx.emit(id, value);
      }
    };
    emit("tuner.preset", info.preset);
    if (info.band !== undefined) {
      this.tunerBand = info.band;
    }
    emit("tuner.band", info.band);
    if (info.frequency !== undefined) {
      // Unified kHz (v2.0.0): the device reports FM in MHz, AM in kHz — normalize.
      emit("tuner.frequency", Math.round(info.frequencyUnit === "MHz" ? info.frequency * 1000 : info.frequency));
    }
    emit("tuner.rdsService", info.rdsService);
    emit("tuner.rdsText", info.rdsText);
    emit("tuner.rdsTextB", info.rdsTextB);
    emit("tuner.tuned", info.tuned);
    emit("tuner.stereo", info.stereo);
  }

  /**
   * A write to `tuner.band` or `tuner.frequency` (`Tuner,Play_Control,Tuning`, 9 of 10 descriptors):
   * the band as AM/FM, the frequency in kHz on the current band, snapped to the grid the device
   * declares (`Tuning,Freq` ranges — 9 kHz/50 kHz in Europe, 10 kHz/200 kHz in the US) and written in
   * the device's own spelling — `Freq,FM|AM` from 2009, `Freq` alone on the 2008 generation (D6).
   *
   * @param stateId `tuner.band` or `tuner.frequency`
   * @param value the written value
   */
  private writeTuning(stateId: string, value: unknown): void {
    if (!this.present) {
      return;
    }
    if (stateId === "tuner.band") {
      if (value !== "AM" && value !== "FM") {
        return;
      }
      void this.ctx.applyCommand(
        { zone: "Tuner", inner: `<Play_Control><Tuning><Band>${value}</Band></Tuning></Play_Control>` },
        () => this.refresh(),
      );
      return;
    }
    const khz = writableNumber(value);
    const band = this.tunerBand === "AM" ? "AM" : this.tunerBand === "FM" ? "FM" : undefined;
    if (khz === undefined || band === undefined) {
      this.ctx.deps.log.debug(`${this.ctx.deviceId}: tuner.frequency not written — the band is not known yet`);
      return;
    }
    const grid = this.ctx.descriptor().tunerGrid?.[band];
    const snapped = grid ? grid.min + Math.round((khz - grid.min) / grid.step) * grid.step : Math.round(khz);
    const bounded = grid ? Math.min(grid.max, Math.max(grid.min, snapped)) : snapped;
    const wire =
      band === "FM"
        ? `<Val>${Math.round(bounded / 10)}</Val><Exp>2</Exp><Unit>MHz</Unit>`
        : `<Val>${bounded}</Val><Exp>0</Exp><Unit>kHz</Unit>`;
    const freq = this.freqForm === "flat" ? `<Freq>${wire}</Freq>` : `<Freq><${band}>${wire}</${band}></Freq>`;
    void this.ctx.applyCommand({ zone: "Tuner", inner: `<Play_Control><Tuning>${freq}</Tuning></Play_Control>` }, () =>
      this.refresh(),
    );
  }
}

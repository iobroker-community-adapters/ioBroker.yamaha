import { formatWireNumber, snapToGrid, writableNumber } from "../catalog/value-coerce";
import { tunerGrid, yncaWrite, type YncaEntry, type YncaWire } from "./catalog";

/** What the controller knows about the tuner when a write comes in. */
export interface TunerState {
  /** The active band (`AM`, `FM`, `DAB`), upper-case — from the live read and every BAND line. */
  band: string;
  /** Whether the device carries the DAB subunit (its FM half shares the flat tuner ids). */
  hasDab: boolean;
  /** Whether the device carries the HD Radio subunit (US models; its AM/FM half shares the flat tuner ids). */
  hasHdRadio: boolean;
  /** The grid the device declares (`@SYS:FREQSTEP`), if it declares one. */
  freqStep: string | undefined;
}

/** Where a band-routed tuner write goes — or why it goes nowhere. */
export type TunerRoute =
  | {
      /** The line to send. */
      wire: YncaWire;
      /** The entry to read back after the PUT (the receiver answers a PUT only when the value changed). */
      readBack?: YncaEntry;
      /** The band the write switches to, when it is a band write. */
      band?: string;
    }
  | {
      /** Why nothing is sent. */
      problem: string;
    };

/** AM frequencies are whole kHz below this, FM ones (in kHz) above it — the same split XML's grid makes. */
const AM_FM_BOUNDARY_KHZ = 2000;

/**
 * Route a band-dependent tuner write (v2.0.0 unification) to its wire function — a pure function of the write, the
 * tuner's state and the entries the device reported, so every route says what became of it (review 2026-10-05, A3: the
 * old router sent and returned nothing, the handle read "unclear" and never tried another protocol).
 *
 * - `tuner.frequency` is ONE state in kHz. Its band is the value's magnitude — an AM frequency is a few hundred kHz,
 *   an FM one tens of thousands — never the band the receiver happened to report last: "band FM, then 98100" went out
 *   as AMFREQ=98100 while the band push was still on its way (the same bug as XML's A20). Snapped onto the grid the
 *   device declares (the shared `snapToGrid`, A26); a value below the band names no station and is not sent. On a DAB
 *   device the FM half lives on the DAB subunit; DAB itself tunes by service and has no frequency command.
 * - `tuner.band` goes to the subunit that owns the written band.
 * - `tuner.preset` and the preset keys go to the subunit that holds the presets: HD Radio's bank replaces TUN's, DAB
 *   keeps its DAB and FM stations apart; the slot is checked by the shared slot rule (A26).
 *
 * Every function written is one the device reported (claim with proof, #615).
 *
 * @param stateId the state id relative to the device
 * @param value the written value
 * @param tuner the tuner's state
 * @param entries the entries THIS device reported
 * @returns the route, or undefined when the id is no band-routed tuner write
 */
export function routeTunerWrite(
  stateId: string,
  value: unknown,
  tuner: TunerState,
  entries: readonly YncaEntry[],
): TunerRoute | undefined {
  const proven = (wire: YncaWire, band?: string): TunerRoute => {
    const readBack = entries.find(
      entry => !entry.derived && !entry.writeOnly && entry.subunit === wire.subunit && entry.func === wire.func,
    );
    return entries.some(entry => entry.subunit === wire.subunit && entry.func === wire.func)
      ? { wire, readBack, ...(band ? { band } : {}) }
      : { problem: `${wire.subunit}:${wire.func} was not reported by this device` };
  };
  const viaEntry = (id: string, subunit: string, func?: string): TunerRoute => {
    const entry = entries.find(
      candidate =>
        candidate.id === id && candidate.subunit === subunit && (func === undefined || candidate.func === func),
    );
    if (!entry) {
      return { problem: `${subunit}${func ? `:${func}` : ""} has no ${id} on this device` };
    }
    const wire = yncaWrite(entry, value);
    return "problem" in wire ? wire : proven(wire);
  };
  if (stateId === "tuner.frequency") {
    const written = writableNumber(value);
    if (written === undefined) {
      return { problem: `"${String(value)}" is no frequency` };
    }
    const band = written < AM_FM_BOUNDARY_KHZ ? "AM" : "FM";
    if (tuner.hasDab) {
      if (band === "AM") {
        return { problem: "the DAB tuner has no AM band" };
      }
      if (tuner.band !== "FM") {
        return { problem: "DAB tunes by service — it has no frequency to set" };
      }
    }
    const khz = snapToGrid(written, tunerGrid(band, tuner.freqStep));
    if (khz === undefined) {
      return { problem: `${written} kHz lies below the ${band} band` };
    }
    // The HD Radio subunit carries the AM/FM tuner of the US models — with TUN beside it or (six of the seven
    // official lists) alone; on a DAB device the FM half lives on DAB.
    const subunit = tuner.hasDab ? "DAB" : tuner.hasHdRadio ? "HDRADIO" : "TUN";
    return proven(
      band === "AM"
        ? { subunit, func: "AMFREQ", value: String(Math.round(khz)) }
        : { subunit, func: "FMFREQ", value: formatWireNumber(khz / 1000, 2) },
    );
  }
  if (stateId === "tuner.band") {
    // Up to three subunits feed this one dropdown: on an HD Radio model every band goes to HDRADIO; otherwise AM lives
    // only on TUN, DAB only on DAB, and FM on both — on a device that has DAB its FM half lives there too.
    const band = typeof value === "string" ? value : "";
    const subunit = tuner.hasHdRadio
      ? "HDRADIO"
      : band === "AM"
        ? "TUN"
        : band === "DAB" || tuner.hasDab
          ? "DAB"
          : "TUN";
    const route = viaEntry("tuner.band", subunit);
    return "wire" in route ? { ...route, band: band.toUpperCase() } : { problem: `band "${band}" is not available` };
  }
  if (stateId === "tuner.preset") {
    if (tuner.hasDab) {
      return viaEntry(stateId, "DAB", tuner.band === "DAB" ? "DABPRESET" : "FMPRESET");
    }
    return viaEntry(stateId, tuner.hasHdRadio ? "HDRADIO" : "TUN", "PRESET");
  }
  if (stateId === "tuner.presetSave" || stateId === "tuner.presetUp" || stateId === "tuner.presetDown") {
    // DAB stores its DAB and FM stations (`@DAB:MEM`) and has no step keys (audit 2026-09-29, B9).
    const subunit = tuner.hasHdRadio ? "HDRADIO" : tuner.hasDab && stateId === "tuner.presetSave" ? "DAB" : "TUN";
    return viaEntry(stateId, subunit);
  }
  return undefined;
}

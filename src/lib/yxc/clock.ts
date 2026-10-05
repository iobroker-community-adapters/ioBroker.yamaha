import type { StateValue } from "../types";

/**
 * The clock and alarm block of the desk-audio and clock models (`/clock/getSettings`, YXC Basic Rev 1.10 §9.1). Parser
 * only — split out of the command mapper, which did five jobs (review 2026-10-05, SOLID).
 */

/**
 * Format a YXC alarm time ("0800") as a readable "08:00"; other shapes pass through.
 *
 * @param time the raw time value
 * @returns the formatted time
 */
function formatAlarmTime(time: string): string {
  return /^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}` : time;
}

/**
 * Parse one alarm-detail block (oneday and each weekly day share the shape).
 *
 * @param prefix the state-id prefix the fields land under (e.g. `clock.alarm.oneday`)
 * @param detail the raw detail block
 * @returns the state updates for that block
 */
function parseAlarmDetail(prefix: string, detail: Record<string, unknown>): StateValue[] {
  const updates: StateValue[] = [];
  if (typeof detail.enable === "boolean") {
    updates.push({ id: `${prefix}.enable`, value: detail.enable });
  }
  if (typeof detail.time === "string") {
    updates.push({ id: `${prefix}.time`, value: formatAlarmTime(detail.time) });
  }
  if (typeof detail.beep === "boolean") {
    updates.push({ id: `${prefix}.beep`, value: detail.beep });
  }
  if (typeof detail.playback_type === "string") {
    updates.push({ id: `${prefix}.playbackType`, value: detail.playback_type });
  }
  if (typeof detail.snooze === "boolean") {
    updates.push({ id: `${prefix}.snooze`, value: detail.snooze });
  }
  const resume = detail.resume;
  if (typeof resume === "object" && resume !== null && typeof (resume as { input?: unknown }).input === "string") {
    updates.push({ id: `${prefix}.resumeInput`, value: (resume as { input: string }).input });
  }
  const preset = detail.preset;
  if (typeof preset === "object" && preset !== null) {
    const p = preset as Record<string, unknown>;
    if (typeof p.type === "string") {
      updates.push({ id: `${prefix}.presetType`, value: p.type });
    }
    if (typeof p.num === "number") {
      updates.push({ id: `${prefix}.presetNumber`, value: p.num });
    }
    // YXC Basic §9.1: the slot's source and station name under `netusb_info`, its band and frequency under
    // `tuner_info` — "unknown"/"" /0 when the slot is empty. Until 3.0.1 the adapter read `netusb_input`, a
    // field no source knows, and the input stood empty for good (audit 2026-09-29, C34).
    const netusb = p.netusb_info as { input?: unknown; text?: unknown } | undefined;
    if (netusb && typeof netusb === "object") {
      if (typeof netusb.input === "string") {
        updates.push({ id: `${prefix}.presetInput`, value: netusb.input === "unknown" ? "" : netusb.input });
      }
      if (typeof netusb.text === "string") {
        updates.push({ id: `${prefix}.presetName`, value: netusb.text });
      }
    }
    const tuner = p.tuner_info as { band?: unknown; number?: unknown } | undefined;
    if (tuner && typeof tuner === "object") {
      const band = typeof tuner.band === "string" && tuner.band !== "unknown" ? tuner.band : "";
      updates.push({ id: `${prefix}.presetBand`, value: band });
      // AM/FM carry the frequency in kHz; DAB a station id, which is no frequency.
      const khz = (band === "am" || band === "fm") && typeof tuner.number === "number" ? tuner.number : 0;
      updates.push({ id: `${prefix}.presetFrequency`, value: khz });
    }
  }
  return updates;
}

/** The weekly alarm day keys, as the YXC clock block names them. */
export const ALARM_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse a `/clock/getSettings` response into the clock/alarm states
 * (capture-verified shape: auto_sync/format plus the nested alarm block).
 *
 * @param settings the getSettings response object
 * @returns the clock state updates, empty if malformed
 */
export function parseYxcClock(settings: unknown): StateValue[] {
  if (typeof settings !== "object" || settings === null) {
    return [];
  }
  const s = settings as Record<string, unknown>;
  const updates: StateValue[] = [];
  if (typeof s.auto_sync === "boolean") {
    updates.push({ id: "clock.autoSync", value: s.auto_sync });
  }
  if (typeof s.format === "string") {
    updates.push({ id: "clock.format", value: s.format });
  }
  const alarm = s.alarm;
  if (typeof alarm === "object" && alarm !== null) {
    const a = alarm as Record<string, unknown>;
    if (typeof a.alarm_on === "boolean") {
      updates.push({ id: "clock.alarm.on", value: a.alarm_on });
    }
    if (typeof a.volume === "number") {
      updates.push({ id: "clock.alarm.volume", value: a.volume });
    }
    if (typeof a.fade_interval === "number") {
      updates.push({ id: "clock.alarm.fadeInterval", value: a.fade_interval });
    }
    if (typeof a.fade_type === "number") {
      updates.push({ id: "clock.alarm.fadeType", value: a.fade_type });
    }
    if (typeof a.mode === "string") {
      updates.push({ id: "clock.alarm.mode", value: a.mode });
    }
    if (typeof a.repeat === "boolean") {
      updates.push({ id: "clock.alarm.repeat", value: a.repeat });
    }
    const oneday = a.oneday;
    if (typeof oneday === "object" && oneday !== null) {
      updates.push(...parseAlarmDetail("clock.alarm.oneday", oneday as Record<string, unknown>));
    }
    for (const day of ALARM_DAYS) {
      const detail = a[day];
      if (typeof detail === "object" && detail !== null) {
        updates.push(...parseAlarmDetail(`clock.alarm.${day}`, detail as Record<string, unknown>));
      }
    }
  }
  return updates;
}

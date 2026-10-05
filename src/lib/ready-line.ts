import type { Transport } from "./catalog/owner-policy";

/**
 * The label the user sees for every transport, in the order they are reported and shown — typed by the one
 * transport list, so a transport without a label does not compile (review 2026-10-05, E).
 */
const LABELS: Readonly<Record<Transport, string>> = { ynca: "YNCA", yxc: "MusicCast", xml: "XML" };

/**
 * The transports a device can speak, in the fixed order they are reported and shown,
 * each with the label the user sees. Single source for the ready-log line and the
 * device-manager card indicators.
 */
export const TRANSPORT_LABELS: ReadonlyArray<{ id: Transport; label: string }> = (
  Object.keys(LABELS) as Transport[]
).map(id => ({ id, label: LABELS[id] }));

/**
 * One "ready" log line summarising which transports connected, govee-style: a single
 * line with a check per live protocol instead of one line per transport. Only the
 * transports that actually connected are listed — a receiver speaks one to three of
 * them, and a protocol it does not speak is not a fault to flag.
 *
 * @param deviceId the id-safe device id
 * @param transportIds the transports live now (from connectTransports)
 * @returns the log line, e.g. `living: ready — YNCA ✓  MusicCast ✓  XML ✓`
 */
export function readyLine(deviceId: string, transportIds: readonly string[]): string {
  const live = new Set(transportIds);
  const parts = TRANSPORT_LABELS.filter(({ id }) => live.has(id)).map(({ label }) => `${label} ✓`);
  return `${deviceId}: ready — ${parts.join("  ")}`;
}

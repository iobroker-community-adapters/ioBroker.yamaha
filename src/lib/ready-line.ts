/**
 * The transports a device can speak, in the fixed order they are reported and shown,
 * each with the label the user sees. Single source for the ready-log line and the
 * device-manager card indicators.
 */
export const TRANSPORT_LABELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "ynca", label: "YNCA" },
  { id: "yxc", label: "MusicCast" },
  { id: "xml", label: "XML" },
];

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

/**
 * Playback times, in the two forms ioBroker asks for.
 *
 * The state-role catalog defines both — `media.elapsed`/`media.duration` as a NUMBER in
 * seconds, `media.elapsed.text`/`media.duration.text` as the readable "1:23" — and the
 * type detector's media-player slots take only the number (`@iobroker/type-detector`,
 * ELAPSED/DURATION are typed `Number`). So a text-only datapoint leaves the player without
 * a time, which is what a YNCA-only receiver used to show.
 *
 * The two transports deliver different halves — YNCA the text ("1:23"), MusicCast the
 * seconds — so both are converted here and BOTH datapoints are written from the one value.
 * That also settles the second half of the problem: the written form no longer depends on
 * which protocol happens to answer.
 */

/** Seconds in an hour — the threshold where the readable form grows an hour field. */
const SECONDS_PER_HOUR = 3600;

/**
 * Parse a device's readable playback time into seconds.
 *
 * Accepts `m:ss` and `h:mm:ss` (both with any number of leading digits); the device's
 * "nothing playing" forms — an empty string, `--:--`, or anything else without digits —
 * yield undefined, so the state is left without a bogus 0.
 *
 * @param text the device's time text (YNCA `ELAPSEDTIME`/`TOTALTIME`)
 * @returns the time in seconds, or undefined when the text carries none
 */
export function parsePlayTime(text: string): number | undefined {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) {
    return undefined;
  }
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part.trim())) {
      return undefined;
    }
    seconds = seconds * 60 + Number(part.trim());
  }
  return seconds;
}

/**
 * Format a playback time in seconds as the readable form: `m:ss` below an hour, `h:mm:ss`
 * from an hour on. A negative or non-finite value has nothing to show and yields "".
 *
 * @param seconds the time in seconds
 * @returns the readable time, or "" when there is none
 */
export function formatPlayTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const total = Math.floor(seconds);
  const ss = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  if (total < SECONDS_PER_HOUR) {
    return `${minutes}:${ss}`;
  }
  return `${Math.floor(total / SECONDS_PER_HOUR)}:${String(minutes).padStart(2, "0")}:${ss}`;
}

/** The flat player states that carry a time, with the text twin each one feeds. */
export const PLAY_TIME_TWINS: Readonly<Record<string, string>> = {
  "player.elapsedTime": "player.elapsedTimeText",
  "player.totalTime": "player.totalTimeText",
};

/**
 * The readable twin of a numeric playback-time state, when the id has one.
 *
 * Both transports route their player values through one funnel per transport, and this is
 * what those funnels use to write the second form alongside the first.
 *
 * @param id the flat player state id
 * @param value the value written to it
 * @returns the twin's id and text, or undefined when the id carries no time
 */
export function playTimeTwin(id: string, value: boolean | number | string): { id: string; value: string } | undefined {
  const twin = PLAY_TIME_TWINS[id];
  if (twin === undefined) {
    return undefined;
  }
  return { id: twin, value: typeof value === "number" ? formatPlayTime(value) : "" };
}

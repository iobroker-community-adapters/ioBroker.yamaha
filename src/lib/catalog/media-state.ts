/**
 * The number coding of `media.state` — ONE place for both players (YNCA and MusicCast), which each
 * wrote their own table before. The ioBroker state-role catalog defines it (`stateroles.md`,
 * `media.state`: "[0 - pause, 1 - play, 2 - stop]"); until 3.0.1 both players used 0 = play,
 * 1 = stop, 2 = pause (audit 2026-09-29, B4/C31).
 */
export const MEDIA_STATE = { pause: 0, play: 1, stop: 2 } as const;

/** The dropdown labels of the coding above. */
export const MEDIA_STATE_LABELS: Record<number, string> = {
  [MEDIA_STATE.pause]: "Pause",
  [MEDIA_STATE.play]: "Play",
  [MEDIA_STATE.stop]: "Stop",
};

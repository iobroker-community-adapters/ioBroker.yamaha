import { CURSOR_VALUES, MENU_VALUES, type CursorValue, type MenuValue } from "../browse/types";

/**
 * The on-screen remote words MusicCast really accepts — the ONE list behind both the
 * datapoint's dropdown (object mapper) and the write path (command mapper).
 *
 * MusicCast is where the shared vocabulary comes from, but it is not identical to it:
 * `controlCursor` has no `home` (the cursor cross ends at `return`), while `controlMenu`
 * carries the full set including `home`. Both endpoints and their words were verified against
 * a live receiver — they appear in NEITHER public specification, so nothing here may be
 * widened by guesswork.
 *
 * Until 2026-09-06 these words were a literal array inside the object mapper, a second literal
 * inside the command mapper, and a third list in `browse/types.ts` that no code read at all.
 * The cursor lists had already drifted (six words here against seven there) and nothing could
 * notice. Deriving them from the shared vocabulary makes a typo a compile error.
 */
export const YXC_CURSOR_VALUES: readonly CursorValue[] = CURSOR_VALUES.filter(value => value !== "home");

/** The menu keys MusicCast accepts — the full shared set. */
export const YXC_MENU_VALUES: readonly MenuValue[] = MENU_VALUES;

/**
 * Whether a written word is one this transport accepts. The dropdown on the datapoint is a
 * hint, not a constraint — a script can write anything, and without this check the adapter
 * put the raw string on the wire for the device to reject.
 *
 * @param values the accepted words
 * @param value the written value
 * @returns true when the value is one of them
 */
export function isRemoteWord(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

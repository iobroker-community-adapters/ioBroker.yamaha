import { coerceBool, snapToGrid, writableNumber, type NumberGrid } from "../catalog/value-coerce";

/**
 * The one rule for a MusicCast value in each direction — read from a device answer, or written to a datapoint.
 * The zone catalog, the device-wide settings and the clock each coerced on their own: `Boolean(value)` read the
 * word "false" as on, and the write side repeated the same `coerceBool` guard in four places (review 2026-10-05,
 * KISS). Every catalog now reads and writes through these.
 */

/** A written value after {@link gateValue}: a switch's boolean, a number on the declared grid, a word. */
export type YxcValue = boolean | number | string;

/** What the gate made of a written value: the value to send, or the reason it is not sent. */
export type Gated = { value: YxcValue; dropped?: never } | { dropped: string; value?: never };

/**
 * A switch as the device reports it: a boolean, or a word or number read for what it means; anything else is no
 * value — never a guessed "on".
 *
 * @param raw the reported value
 * @returns the switch state, or null when the answer names none
 */
export function readSwitch(raw: unknown): boolean | null {
  return coerceBool(raw) ?? null;
}

/**
 * A number as the device reports it: finite, or a plain decimal in text; anything else is no value — never NaN.
 *
 * @param raw the reported value
 * @returns the number, or null when the answer names none
 */
export function readNumber(raw: unknown): number | null {
  return writableNumber(raw) ?? null;
}

/**
 * A word as the device reports it, trimmed; an empty or non-text answer is no value — `null`, never `""`.
 *
 * @param raw the reported value
 * @returns the word, or null when the answer names none
 */
export function readWord(raw: unknown): string | null {
  const word = typeof raw === "string" ? raw.trim() : "";
  return word.length > 0 ? word : null;
}

/**
 * The one gate of a value written to a datapoint, by the datapoint's type: a switch takes the words and numbers
 * a script writes for what they mean (`coerceBool`), a number takes the strict number rule and the grid the device
 * declares (`snapToGrid` — outside the declared range nothing is sent), a word is trimmed text (a number written
 * to it is its text).
 *
 * @param type the datapoint's type
 * @param value the written value
 * @param grid the grid the device declares for a number, if any
 * @returns the value to send, or why it is not sent
 */
export function gateValue(type: "boolean" | "number" | "string" | undefined, value: unknown, grid?: NumberGrid): Gated {
  if (type === "boolean") {
    const on = coerceBool(value);
    return on === undefined ? { dropped: `${shown(value)} is no switch value` } : { value: on };
  }
  if (type === "number") {
    const num = writableNumber(value);
    if (num === undefined) {
      return { dropped: `${shown(value)} is no number` };
    }
    const snapped = snapToGrid(num, grid);
    return snapped === undefined
      ? { dropped: `${num} is outside the declared range ${range(grid)}` }
      : { value: snapped };
  }
  const word = typeof value === "string" ? value.trim() : writableNumber(value) !== undefined ? String(value) : "";
  return word.length > 0 ? { value: word } : { dropped: `${shown(value)} is no word` };
}

/**
 * A written value as a log line shows it.
 *
 * @param value the written value
 * @returns its JSON form ("abc" in quotes, null, 1.5)
 */
export function shown(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * A declared range as a log line shows it.
 *
 * @param grid the grid
 * @returns "min…max", or "from min" without an upper end
 */
export function range(grid: NumberGrid | undefined): string {
  if (!grid) {
    return "";
  }
  return grid.max === undefined ? `from ${grid.min}` : `${grid.min}…${grid.max}`;
}

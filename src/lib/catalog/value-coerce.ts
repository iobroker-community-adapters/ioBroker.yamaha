/** An on/off value → a boolean state. */
export interface OnOffSpec {
  /** Discriminant. */
  kind: "onoff";
  /** Wire value that maps to `true`. */
  on: string;
  /** Wire value that maps to `false`. */
  off: string;
}

/** A fixed multi-value choice → a string state with a `states` dropdown. */
export interface EnumSpec {
  /** Discriminant. */
  kind: "enum";
  /** Wire value → display label (usually identical for YNCA). */
  states: Record<string, string>;
}

/** A numeric value → a number state with an optional unit and range. */
export interface NumberSpec {
  /** Discriminant. */
  kind: "number";
  /** Unit for the numeric state (e.g. "dB"). */
  unit?: string;
  /** Minimum value. */
  min?: number;
  /** Maximum value. */
  max?: number;
  /** Step size. */
  step?: number;
}

/** A free-text value → a string state. */
export interface TextSpec {
  /** Discriminant. */
  kind: "text";
}

/**
 * A coded value: a fixed set of wire tokens maps to numeric codes and back, so a player
 * datum whose wire form is text ("Play"/"Pause"/"Stop") becomes a real `number` state
 * carrying its labels — the form the type-detector's `media.state` / `media.mode.repeat`
 * slots require. The code table lives on the spec (per state), so the write path stays
 * value-based, not a fragile global name→wire guess.
 */
export interface CodeSpec {
  /** Discriminant. */
  kind: "code";
  /** Wire token → numeric code; the reverse encodes a written code back to the wire. */
  codes: Record<string, number>;
  /** Numeric code → display label for the states dropdown. */
  labels: Record<number, string>;
}

/**
 * A write-only action button → a boolean state that, when written, sends one fixed wire
 * value supplied by the entry's `wireEncode`. `read:false` so it never mirrors device state
 * (e.g. a "next track" button that puts `Skip Fwd` on the wire).
 */
export interface ButtonSpec {
  /** Discriminant. */
  kind: "button";
}

/**
 * The value semantics of a device function, protocol-agnostic. A catalog entry
 * carries one of these so the adapter can turn a raw protocol value into a
 * properly typed, user-friendly ioBroker state instead of a bare string.
 */
export type ValueSpec = OnOffSpec | EnumSpec | NumberSpec | TextSpec | CodeSpec | ButtonSpec;

/** The ioBroker `common` fields this layer derives from a {@link ValueSpec}. */
export interface StateCommon {
  /** ioBroker value type. */
  type: "boolean" | "number" | "string";
  /** ioBroker role. */
  role: string;
  /** Always readable. */
  read: boolean;
  /** Whether the state accepts writes. */
  write: boolean;
  /** Unit for numeric states. */
  unit?: string;
  /** Minimum for numeric states. */
  min?: number;
  /** Maximum for numeric states. */
  max?: number;
  /** Step for numeric states. */
  step?: number;
  /** Predefined value → label map for a dropdown. */
  states?: Record<string, string>;
}

/**
 * Derive the ioBroker `common` for a value spec — the core of the intelligent
 * typing: an on/off value becomes a real boolean, not the raw "On"/"Off" text.
 *
 * @param spec the value semantics
 * @param opts write flag and an optional role override
 * @param opts.write whether the state accepts writes
 * @param opts.role optional role override (else derived from the spec kind)
 * @returns the derived common fields
 */
export function specToCommon(spec: ValueSpec, opts: { write?: boolean; role?: string } = {}): StateCommon {
  const write = opts.write ?? false;
  switch (spec.kind) {
    case "onoff":
      return { type: "boolean", role: opts.role ?? "switch", read: true, write };
    case "enum":
      return { type: "string", role: opts.role ?? "state", read: true, write, states: spec.states };
    case "number": {
      // Only set the range fields the spec actually carries — a stray
      // `{ min: undefined }` would break the object-tree fixture comparisons.
      const common: StateCommon = { type: "number", role: opts.role ?? (write ? "level" : "value"), read: true, write };
      if (spec.unit !== undefined) {
        common.unit = spec.unit;
      }
      if (spec.min !== undefined) {
        common.min = spec.min;
      }
      if (spec.max !== undefined) {
        common.max = spec.max;
      }
      if (spec.step !== undefined) {
        common.step = spec.step;
      }
      return common;
    }
    case "text":
      return { type: "string", role: opts.role ?? "text", read: true, write };
    case "code": {
      const states: Record<string, string> = {};
      for (const [code, label] of Object.entries(spec.labels)) {
        states[code] = label;
      }
      return { type: "number", role: opts.role ?? "value", read: true, write, states };
    }
    case "button":
      return { type: "boolean", role: opts.role ?? "button", read: false, write: true };
  }
}

/**
 * Strict decimal: only a plain finite decimal counts as a number, so garbage
 * ("N/A", "12abc") never lands in a number state (same line as the nut adapter).
 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * Turn a raw protocol value into the typed ioBroker state value for a spec: an
 * on/off value becomes a real boolean, a numeric string a finite number (or
 * `undefined` if it is not a clean decimal), enum/text stay strings.
 *
 * @param spec the value semantics
 * @param wire the raw value received from the device
 * @returns the typed value, or undefined when a numeric value cannot be parsed
 */
export function decode(spec: ValueSpec, wire: string): boolean | number | string | undefined {
  switch (spec.kind) {
    case "onoff":
      // A third, unexpected wire value must not silently become `false` — that would
      // write back an explicit "off" command. Report it as unknown (undefined).
      if (wire === spec.on) {
        return true;
      }
      if (wire === spec.off) {
        return false;
      }
      return undefined;
    case "number": {
      const trimmed = wire.trim();
      return DECIMAL_RE.test(trimmed) ? Number(trimmed) : undefined;
    }
    case "enum":
    case "text":
      return wire;
    case "code": {
      // A wire token the device does not know maps to no code — report unknown (undefined)
      // rather than a bogus 0, the same way onoff rejects a third wire value.
      const code = spec.codes[wire];
      return code === undefined ? undefined : code;
    }
    case "button":
      return undefined; // write-only action — never read back into a state
  }
}

/**
 * Whether a written state value may be sent to the device: never `null`/`undefined`
 * (both are regular ioBroker state values but not valid commands), and a finite
 * number for a numeric state — so a stray `null` or `"abc"` is dropped rather than
 * turned into a bogus command (`@TUN:AMFREQ=null`, `<Val>NaN</Val>`).
 *
 * @param value the value written to the state
 * @param numeric whether the target state is numeric
 * @returns true if the value is safe to encode and send
 */
export function isWritableValue(value: unknown, numeric: boolean): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (!numeric) {
    return true;
  }
  // Reject an empty/whitespace string explicitly: Number("") is 0 (finite), so it
  // would otherwise slip through and put an empty value on the wire.
  if (typeof value === "string" && value.trim() === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}

/**
 * Turn a typed ioBroker state value back into the raw protocol value: a boolean
 * becomes the on/off wire token, everything else its string form.
 *
 * @param spec the value semantics
 * @param value the ioBroker state value written by the user
 * @returns the wire value to send to the device
 */
export function encode(spec: ValueSpec, value: boolean | number | string): string {
  switch (spec.kind) {
    case "onoff":
      return value ? spec.on : spec.off;
    case "number":
    case "enum":
    case "text":
      return String(value);
    case "code": {
      // Reverse the code table: the written numeric code back to its wire token.
      const token = Object.keys(spec.codes).find(w => spec.codes[w] === value);
      return token ?? String(value);
    }
    case "button":
      // Unreachable: a button entry always carries a wireEncode that supplies the fixed
      // command, so yncaCommand never falls back to encode() here.
      return "";
  }
}

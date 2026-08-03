/**
 * The value semantics of a device function, protocol-agnostic. A catalog entry
 * carries one of these so the adapter can turn a raw protocol value into a
 * properly typed, user-friendly ioBroker state instead of a bare string.
 */
export type ValueSpec =
  | { kind: "onoff"; on: string; off: string }
  | { kind: "enum"; states: Record<string, string> }
  | { kind: "number"; unit?: string; min?: number; max?: number; step?: number }
  | { kind: "text" };

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
    case "number":
      return {
        type: "number",
        role: opts.role ?? (write ? "level" : "value"),
        read: true,
        write,
        unit: spec.unit,
        min: spec.min,
        max: spec.max,
        step: spec.step,
      };
    case "text":
      return { type: "string", role: opts.role ?? "text", read: true, write };
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
      return wire === spec.on;
    case "number": {
      const trimmed = wire.trim();
      return DECIMAL_RE.test(trimmed) ? Number(trimmed) : undefined;
    }
    case "enum":
    case "text":
      return wire;
  }
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
  }
}

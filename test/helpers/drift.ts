/**
 * The network hook's drifted JSON (`test/network-hook.js`, fleet master — `drift`), copied: requiring the hook would
 * patch node:net and node:http in the test process. Of every object's keys the first of each three is gone, the second
 * null, the third of another type.
 *
 * @param value a parsed answer
 * @returns the drifted answer
 */
export function drift(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(drift);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  Object.keys(value).forEach((key, i) => {
    const v = (value as Record<string, unknown>)[key];
    if (i % 3 === 1) {
      out[key] = null;
    } else if (i % 3 === 2) {
      out[key] =
        typeof v === "number"
          ? String(v)
          : typeof v === "string"
            ? 0
            : typeof v === "boolean"
              ? String(v)
              : v === null
                ? 0
                : drift(v);
    }
  });
  return out;
}

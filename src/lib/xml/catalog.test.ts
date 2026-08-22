import { XML_AMP_CATALOG } from "./catalog";

/**
 * Table test over the whole XML catalog. Every entry with a `toInner` is a
 * writable datapoint in the user's tree; a broken or empty inner element is a
 * button that silently does nothing on the receiver. Driving the list itself
 * means a newly added entry is covered the moment it is added.
 */
describe("XML_AMP_CATALOG", () => {
  const writable = XML_AMP_CATALOG.filter(e => e.toInner);

  it("offers a writable mapping for every entry the objects mark writable", () => {
    for (const entry of XML_AMP_CATALOG) {
      // A `write: true` common with no toInner is a datapoint the user can change
      // and that never reaches the device.
      expect(Boolean(entry.toInner), `${entry.state} write/toInner mismatch`).toBe(entry.common.write === true);
    }
    expect(writable.length).toBeGreaterThan(5);
  });

  it("builds a well-formed, non-empty command body for every writable entry", () => {
    for (const entry of writable) {
      const sample = entry.common.type === "boolean" ? true : entry.common.type === "number" ? 5 : "Straight";
      const inner = entry.toInner!(sample);
      expect(inner, entry.state).toMatch(/^<[A-Za-z_]/);
      // Balanced tags: the receiver answers RC=2 (parse error) on anything else.
      const open = (inner.match(/<[A-Za-z_][^/>]*>/g) ?? []).length;
      const close = (inner.match(/<\/[A-Za-z_][^>]*>/g) ?? []).length;
      expect(open, `${entry.state} unbalanced: ${inner}`).toBe(close);
      expect(inner, entry.state).not.toContain("undefined");
      expect(inner, entry.state).not.toContain("><</");
    }
  });

  it("maps a boolean entry to the receiver's own vocabulary, not to true/false", () => {
    for (const entry of writable.filter(e => e.common.type === "boolean")) {
      const on = entry.toInner!(true);
      const off = entry.toInner!(false);
      // The XML API takes words (On/Off, or Standby for power) — a literal
      // "true" on the wire is answered with RC=3 and the switch does nothing.
      expect(on, entry.state).not.toMatch(/>(true|false|1|0)</);
      expect(off, entry.state).not.toMatch(/>(true|false|1|0)</);
      expect(on, `${entry.state} on == off`).not.toBe(off);
    }
  });

  it("keeps every state id unique", () => {
    const ids = XML_AMP_CATALOG.map(e => e.state);
    // Two entries on one id would make the later one overwrite the earlier's value.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

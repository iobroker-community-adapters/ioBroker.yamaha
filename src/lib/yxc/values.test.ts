import { range, shown } from "./values";

describe("how a written value and a declared range read in a log line", () => {
  test("a value in its JSON form, undefined as a word", () => {
    expect(shown("abc")).toBe('"abc"');
    expect(shown(1.5)).toBe("1.5");
    expect(shown(null)).toBe("null");
    expect(shown(undefined)).toBe("undefined");
  });

  test("a range with both ends, from its lower end without an upper one, nothing without a grid", () => {
    expect(range({ min: 531, step: 9, max: 1611 })).toBe("531…1611");
    expect(range({ min: 87500, step: 50 })).toBe("from 87500");
    expect(range(undefined)).toBe("");
  });
});

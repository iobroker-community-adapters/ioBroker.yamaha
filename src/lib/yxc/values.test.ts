import { range, readSwitch, readWord, reported, shown } from "./values";

// Fleet suite D6/C26b (2026-10-22, Y-01): a drifted answer — a field gone, null or of another type — emptied
// datapoints that held a value. Only the device's explicit "nothing" (an empty word) is no value.
describe("what an answer reports for a catalog field", () => {
  test("a field left out, sent as null or in a form the reader does not take writes nothing", () => {
    expect(reported(undefined, readSwitch)).toBeUndefined();
    expect(reported(null, readSwitch)).toBeUndefined();
    expect(reported(0, readWord)).toBeUndefined();
    expect(reported("maybe", readSwitch)).toBeUndefined();
    expect(reported({}, readWord)).toBeUndefined();
  });

  test("a read value is written, an empty word is the device's explicit nothing", () => {
    expect(reported(true, readSwitch)).toBe(true);
    expect(reported(false, readSwitch)).toBe(false);
    expect(reported(" hdmi1 ", readWord)).toBe("hdmi1");
    expect(reported("", readWord)).toBeNull();
    expect(reported("  ", readWord)).toBeNull();
  });
});

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

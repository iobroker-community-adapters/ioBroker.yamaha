import { errorMessage } from "./util";

describe("errorMessage", () => {
  it("uses an Error's message", () => {
    expect(errorMessage(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED");
    expect(errorMessage(new TypeError("not a function"))).toBe("not a function");
  });

  it("still says something for a value that is not an Error", () => {
    // node:net and node:dgram bindings do reject with bare strings and with objects
    // carrying only a `code`. `e.message` would be undefined and the log line would
    // name no cause at all.
    expect(errorMessage("EPERM")).toBe("EPERM");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(404)).toBe("404");
    expect(errorMessage(false)).toBe("false");
  });

  it("names what a thrown object carries instead of [object Object]", () => {
    // The whole point of the helper. `String({code:"EHOSTUNREACH"})` is "[object Object]",
    // which tells a user nothing about why their receiver went quiet — and until 2.11.0 that
    // is exactly what every catch in this adapter logged for a rejected socket error object.
    expect(errorMessage({ code: "EHOSTUNREACH" })).toBe('{"code":"EHOSTUNREACH"}');
    expect(errorMessage({ code: 500, body: "denied" })).toBe('{"code":500,"body":"denied"}');
  });

  it("falls back to the class name when the object cannot be serialised", () => {
    // Two ways JSON.stringify gives nothing usable, and BOTH end at the same fallback: a
    // circular structure makes it throw, an object whose toJSON answers undefined makes it
    // return undefined. Either would be an empty log line without the guard.
    const circular: Record<string, unknown> = { code: "ELOOP" };
    circular.self = circular;
    expect(errorMessage(circular)).toBe("[object Object]");
    expect(errorMessage({ toJSON: () => undefined })).toBe("[object Object]");
    expect(errorMessage(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
  });

  it("keeps working for a thrown symbol, where a template literal would throw", () => {
    expect(errorMessage(Symbol("YNCA"))).toBe("Symbol(YNCA)");
  });
});

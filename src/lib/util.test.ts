import { DeviceBody, decodeDeviceText, encodeDeviceText, errorMessage } from "./util";

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

describe("device text (audit 2026-09-24, B5/C5/D12)", () => {
  it("decodes UTF-8, and bytes that are no UTF-8 as Latin-1", () => {
    expect(decodeDeviceText(Buffer.from("Küche", "utf8"))).toBe("Küche");
    expect(decodeDeviceText(Buffer.from("Küche", "latin1"))).toBe("Küche");
  });

  it("encodes Latin-1 only when every character fits", () => {
    expect(encodeDeviceText("Küche", "latin1")).toEqual(Buffer.from([0x4b, 0xfc, 0x63, 0x68, 0x65]));
    expect(encodeDeviceText("Kü€", "latin1")).toBeUndefined();
    expect(encodeDeviceText("€")).toEqual(Buffer.from("€", "utf8"));
  });

  it("a body collected in chunks decodes a split character whole and stops at the cap", () => {
    const body = new DeviceBody();
    const bytes = Buffer.from('{"artist":"Die Ärzte"}', "utf8");
    const cut = bytes.indexOf(0xc3) + 1;
    expect(body.add(bytes.subarray(0, cut))).toBe(true);
    expect(body.add(bytes.subarray(cut))).toBe(true);
    expect(body.text()).toBe('{"artist":"Die Ärzte"}');
    expect(new DeviceBody().add(Buffer.alloc(1024 * 1024 + 1))).toBe(false);
  });
});

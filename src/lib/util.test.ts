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
    expect(errorMessage({ code: "EHOSTUNREACH" })).toBe("[object Object]");
  });
});

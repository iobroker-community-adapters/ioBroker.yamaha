import { LineBuffer } from "./line-buffer";

describe("LineBuffer", () => {
  test("splits complete CRLF-terminated lines", () => {
    const buf = new LineBuffer();
    expect(buf.push("@MAIN:PWR=On\r\n@MAIN:VOL=-30.0\r\n")).toEqual(["@MAIN:PWR=On", "@MAIN:VOL=-30.0"]);
  });

  test("holds an incomplete line until its terminator arrives", () => {
    const buf = new LineBuffer();
    expect(buf.push("@MAIN:P")).toEqual([]);
    expect(buf.push("WR=On\r\n")).toEqual(["@MAIN:PWR=On"]);
  });

  test("skips empty lines between terminators", () => {
    const buf = new LineBuffer();
    expect(buf.push("\r\n@SYS:PWR=On\r\n\r\n")).toEqual(["@SYS:PWR=On"]);
  });
});

describe("LineBuffer overflow", () => {
  it("drops a partial line that grows past the cap", () => {
    const buffer = new LineBuffer();
    // A receiver that stops sending terminators (or a stream of binary noise)
    // would otherwise grow this string until the adapter runs out of memory.
    expect(buffer.push("x".repeat(200_000))).toEqual([]);
    expect(buffer.push("@MAIN:PWR=On\r\n")).toEqual(["@MAIN:PWR=On"]);
  });
});

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

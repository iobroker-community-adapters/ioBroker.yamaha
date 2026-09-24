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

describe("LineBuffer decodes whole lines (audit 2026-09-24, B5)", () => {
  it("keeps a multi-byte character that a TCP chunk splits", () => {
    const buf = new LineBuffer();
    const bytes = Buffer.from("@NETRADIO:STATION=Hitradio Ö3\r\n", "utf8");
    const cut = bytes.indexOf(0xc3) + 1;
    expect(buf.push(bytes.subarray(0, cut))).toEqual([]);
    expect(buf.push(bytes.subarray(cut))).toEqual(["@NETRADIO:STATION=Hitradio Ö3"]);
  });

  it("reads a line that is not UTF-8 as the Latin-1 the specification declares for names", () => {
    const buf = new LineBuffer();
    expect(buf.push(Buffer.from("@MAIN:ZONENAME=K\xfcche\r\n", "latin1"))).toEqual(["@MAIN:ZONENAME=Küche"]);
  });
});

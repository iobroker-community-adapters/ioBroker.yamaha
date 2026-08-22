import { decodeLine, encodeCommand, encodeGet } from "./protocol";

describe("decodeLine", () => {
  test("decodes a normal @SUBUNIT:FUNC=VALUE response", () => {
    expect(decodeLine("@MAIN:PWR=On")).toEqual({ status: "ok", subunit: "MAIN", func: "PWR", value: "On" });
  });

  test("decodes @UNDEFINED as an undefined status without fields", () => {
    expect(decodeLine("@UNDEFINED")).toEqual({ status: "undefined" });
  });

  test("decodes @RESTRICTED as a restricted status without fields", () => {
    expect(decodeLine("@RESTRICTED")).toEqual({ status: "restricted" });
  });

  test("keeps '=' inside the value (splits only on the first)", () => {
    expect(decodeLine("@NETRADIO:PLAYINFO=key=val")).toEqual({
      status: "ok",
      subunit: "NETRADIO",
      func: "PLAYINFO",
      value: "key=val",
    });
  });

  test("decodes a negative numeric value (volume)", () => {
    expect(decodeLine("@MAIN:VOL=-50.5")).toEqual({ status: "ok", subunit: "MAIN", func: "VOL", value: "-50.5" });
  });

  test("returns unknown for a line that is not a YNCA response", () => {
    expect(decodeLine("garbage")).toEqual({ status: "unknown" });
    expect(decodeLine("")).toEqual({ status: "unknown" });
  });
});

describe("encode", () => {
  test("encodes a PUT command", () => {
    expect(encodeCommand("MAIN", "PWR", "On")).toBe("@MAIN:PWR=On");
  });

  test("encodes a GET as =?", () => {
    expect(encodeGet("SYS", "MODELNAME")).toBe("@SYS:MODELNAME=?");
  });
});

describe("decodeLine rejects what is not a YNCA response", () => {
  it("ignores a line that does not start with @", () => {
    // The socket also carries the echo of what we sent and the odd banner line.
    // Reading one as a response would create a datapoint from our own command.
    for (const line of ["MAIN:PWR=On", "", "  ", "OK"]) {
      expect(decodeLine(line)).toEqual({ status: "unknown" });
    }
  });

  it("ignores a response with an empty subunit, func or missing separator", () => {
    // A truncated line (the receiver cuts one on a busy link) would otherwise
    // produce a state id with an empty segment — an object that can never be read.
    expect(decodeLine("@:PWR=On")).toEqual({ status: "unknown" });
    expect(decodeLine("@MAIN:=On")).toEqual({ status: "unknown" });
    expect(decodeLine("@MAIN:PWR")).toEqual({ status: "unknown" });
    expect(decodeLine("@MAINPWR=On")).toEqual({ status: "unknown" });
  });

  it("keeps an empty VALUE, which the receiver does send", () => {
    expect(decodeLine("@MAIN:INPNAME=")).toEqual({ status: "ok", subunit: "MAIN", func: "INPNAME", value: "" });
  });
});

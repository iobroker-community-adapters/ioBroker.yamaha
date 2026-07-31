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

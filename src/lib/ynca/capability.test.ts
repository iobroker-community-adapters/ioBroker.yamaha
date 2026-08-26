import { buildCapabilities } from "./capability";
import { capabilitiesFromLines as parseCapabilities } from "./__fixtures__/capabilities-from-lines";
import rxA810 from "./__fixtures__/RX-A810.json";
import rN500 from "./__fixtures__/R-N500.json";

describe("parseCapabilities", () => {
  test("extracts the model name from SYS:MODELNAME", () => {
    expect(parseCapabilities(rxA810).model).toBe("RX-A810");
  });

  test("collects MAIN amplifier functions from the init sweep", () => {
    const caps = parseCapabilities(rxA810);
    expect(caps.subunits.MAIN).toMatchObject({
      PWR: expect.any(String),
      VOL: expect.any(String),
      MUTE: expect.any(String),
      INP: expect.any(String),
    });
  });

  test("detects a second zone on a multi-zone receiver", () => {
    expect(parseCapabilities(rxA810).subunits.ZONE2).toBeDefined();
  });

  test("a stereo receiver has MAIN but no ZONE2", () => {
    const caps = parseCapabilities(rN500);
    expect(caps.subunits.MAIN).toBeDefined();
    expect(caps.subunits.ZONE2).toBeUndefined();
  });

  test("ignores @UNDEFINED and @RESTRICTED, keeping the value of the last ok response", () => {
    const caps = parseCapabilities(["@UNDEFINED", "@RESTRICTED", "@MAIN:PWR=Standby"]);
    expect(Object.keys(caps.subunits)).toEqual(["MAIN"]);
    expect(caps.subunits.MAIN?.PWR).toBe("Standby");
  });
});

describe("buildCapabilities", () => {
  test("assembles subunits and model from decoded messages", () => {
    const caps = buildCapabilities([
      { subunit: "SYS", func: "MODELNAME", value: "RX-A810" },
      { subunit: "MAIN", func: "PWR", value: "On" },
      { subunit: "MAIN", func: "VOL", value: "-30.0" },
    ]);
    expect(caps.model).toBe("RX-A810");
    expect(caps.subunits.MAIN).toEqual({ PWR: "On", VOL: "-30.0" });
  });
});

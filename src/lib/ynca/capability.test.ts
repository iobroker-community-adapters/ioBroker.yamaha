import { buildCapabilities, mergeYncaSubunits } from "./capability";
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

describe("mergeYncaSubunits (standby must not shrink the proven shape)", () => {
  test("keeps every remembered function, lets fresh values win, adds new ones", () => {
    const remembered = {
      MAIN: { PWR: "On", VOL: "-30.0" },
      NETRADIO: { PLAYBACKINFO: "Play", STATION: "Radio X" },
    };
    // A standby sweep: NETRADIO answers nothing, MAIN reports new values + a new function.
    const fresh = { MAIN: { PWR: "Standby", VOL: "-50.5", SLEEP: "Off" } };
    expect(mergeYncaSubunits(remembered, fresh)).toEqual({
      MAIN: { PWR: "Standby", VOL: "-50.5", SLEEP: "Off" },
      NETRADIO: { PLAYBACKINFO: "Play", STATION: "Radio X" },
    });
  });

  test("keeps a function the standby sweep of the SAME subunit did not answer", () => {
    // The real standby case: MAIN still answers PWR, but the scene names and the tone
    // controls come back @RESTRICTED — they must survive inside the subunit, not only
    // whole subunits that stayed silent.
    const remembered = { MAIN: { PWR: "On", SCENE1NAME: "Movie", TONEBASS: "0.0" } };
    const fresh = { MAIN: { PWR: "Standby" } };
    expect(mergeYncaSubunits(remembered, fresh).MAIN).toEqual({ PWR: "Standby", SCENE1NAME: "Movie", TONEBASS: "0.0" });
  });

  test("does not mutate either input", () => {
    const remembered = { MAIN: { PWR: "On" } };
    const fresh = { MAIN: { PWR: "Standby" }, DAB: { BAND: "FM" } };
    mergeYncaSubunits(remembered, fresh);
    expect(remembered).toEqual({ MAIN: { PWR: "On" } });
    expect(fresh).toEqual({ MAIN: { PWR: "Standby" }, DAB: { BAND: "FM" } });
  });
});

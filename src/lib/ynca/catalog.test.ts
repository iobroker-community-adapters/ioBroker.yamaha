import { buildYncaCatalog, funcToEntry, idToEntry, sweepGets } from "./catalog";
import type { EnumSpec } from "../catalog/value-coerce";

describe("YNCA catalog", () => {
  test("a MAIN amplifier function becomes a top-level state carrying its YNCA function", () => {
    const power = buildYncaCatalog().find(e => e.id === "power");
    expect(power).toMatchObject({ subunit: "MAIN", func: "PWR", write: true, role: "switch.power" });
    expect(power?.spec).toEqual({ kind: "onoff", on: "On", off: "Standby" });
  });

  test("each additional zone gets its own prefixed states", () => {
    expect(buildYncaCatalog().find(e => e.id === "zone2.volume")).toMatchObject({ subunit: "ZONE2", func: "VOL" });
  });

  test("input is an enum dropdown carrying the full device-agnostic input list", () => {
    const input = buildYncaCatalog().find(e => e.id === "input");
    expect(input?.spec.kind).toBe("enum");
    const states = (input?.spec as EnumSpec).states;
    expect(states).toHaveProperty("HDMI1");
    expect(states).toHaveProperty("TUNER");
    expect(states).toHaveProperty("Spotify");
  });

  test("the init sweep asks each function once per subunit", () => {
    const gets = sweepGets(buildYncaCatalog());
    expect(gets).toContainEqual({ subunit: "MAIN", func: "PWR" });
    expect(gets).toContainEqual({ subunit: "ZONE2", func: "VOL" });
  });

  test("funcToEntry maps a device line (subunit:func) back to its state id", () => {
    const map = funcToEntry(buildYncaCatalog());
    expect(map.get("MAIN:PWR")?.id).toBe("power");
    expect(map.get("ZONE2:VOL")?.id).toBe("zone2.volume");
  });

  test("idToEntry maps a state write back to its subunit and function", () => {
    expect(idToEntry(buildYncaCatalog()).get("zone2.volume")).toMatchObject({ subunit: "ZONE2", func: "VOL" });
  });
});

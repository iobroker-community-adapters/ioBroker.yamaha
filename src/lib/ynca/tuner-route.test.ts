import { writeProblem, YNCA_CATALOG } from "./catalog";
import { routeTunerWrite } from "./tuner-route";

const preset = YNCA_CATALOG.filter(entry => entry.id === "tuner.preset" && entry.subunit === "TUN");
const fm = { band: "FM", hasDab: false, hasHdRadio: false, freqStep: undefined };

describe("a tuner write the slot rule refuses", () => {
  test("is dropped with the slot rule's own reason, the declared slots named", () => {
    expect(preset).toHaveLength(1);
    const reason = writeProblem(preset[0], 41);
    expect(reason).toBe('"41" names no slot (1…40)');
    expect(routeTunerWrite("tuner.preset", 41, fm, preset)).toEqual({ problem: reason });
  });

  test("a slot it takes goes to the preset function", () => {
    expect(routeTunerWrite("tuner.preset", 7, fm, preset)).toMatchObject({
      wire: { subunit: "TUN", func: "PRESET", value: "7" },
    });
  });
});

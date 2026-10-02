import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { parseInputLabels } from "../lib/xml/protocol";
import { YNCA_CATALOG } from "../lib/ynca/catalog";
import { XML_AMP_CATALOG } from "../lib/xml/catalog";
import { RENAMED_STATE_IDS } from "../lib/pure-helpers";

// Y-25: the inputs carry the names the user gave them in the receiver. There is no second datapoint with the same
// content: inputText is gone.

describe("Y-25 inputs carry the user's names; no inputText", () => {
  test("MusicCast: the input list shows the names given in the app, the value stays the device's id", () => {
    const input = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power"], inputs: ["hdmi1", "hdmi2", "net_radio"] }],
      media: [],
      names: { inputs: { hdmi1: "Apple TV", hdmi2: "Turntable" }, soundPrograms: {} },
    }).find(o => o.id === "input");
    expect(input?.common.states).toEqual({ hdmi1: "Apple TV", hdmi2: "Turntable", net_radio: "NET RADIO" });
  });

  test("XML: the input list shows the titles the receiver reports", () => {
    const labels = parseInputLabels(
      "<Input_Sel_Item><Item_1><Param>HDMI1</Param><Title>Apple TV</Title></Item_1>" +
        "<Item_2><Param>AV1</Param><Title> </Title></Item_2></Input_Sel_Item>",
    );
    expect(labels).toEqual({ HDMI1: "Apple TV", AV1: "AV1" });
  });

  test("no protocol builds an inputText, and an update removes the old one", () => {
    const ids = [
      ...YNCA_CATALOG.map(entry => entry.id),
      ...XML_AMP_CATALOG.map(entry => entry.state),
      ...mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: ["hdmi1"] }], media: [] }).map(o => o.id),
    ];
    expect(ids.filter(id => /inputText/i.test(id))).toEqual([]);
    expect(RENAMED_STATE_IDS).toContain("inputText");
  });
});

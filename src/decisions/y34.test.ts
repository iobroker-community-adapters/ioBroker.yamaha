import { describe, expect, test } from "vitest";
import { descriptorPuts, zonePad } from "../lib/xml/protocol";

// Y-34 (krobi 2026-10-05 22:47 "y34 yes"): a remote key the receiver lists as not assigned (desc.xml
// `Assigned="No"`, RX-A2060 zone 2: On Screen, Top Menu, Menu, Display) is not offered.

/**
 * A zone 2 block of a device description declaring three menu keys.
 *
 * @param assigned the attribute each key carries (`""` for none)
 * @returns the desc.xml excerpt
 */
function zone2(assigned: readonly string[]): string {
  const keys = ["On Screen", "Option", "Display"]
    .map((word, i) => `<Put_1 Func="Event" ID="P1"${assigned[i]}>${word}</Put_1>`)
    .join("");
  return (
    '<Menu Func="Unit" Title_1="Zone 2" YNC_Tag="Zone_2"><Cmd_List>' +
    '<Define ID="P1">Zone_2,Cursor_Control,Menu_Control</Define></Cmd_List>' +
    `${keys}</Menu>`
  );
}

describe("Y-34 a key the receiver lists as not assigned is not offered", () => {
  test("the keys marked Assigned=No are left out, the assigned one stays", () => {
    const xml = zone2([' Assigned="No"', "", ' Assigned="No"']);
    expect(zonePad(descriptorPuts(xml), "Zone_2").menu?.words).toEqual(["Option"]);
  });

  test("without the mark every listed key is offered", () => {
    expect(zonePad(descriptorPuts(zone2(["", "", ""])), "Zone_2").menu?.words).toEqual([
      "On Screen",
      "Option",
      "Display",
    ]);
  });
});

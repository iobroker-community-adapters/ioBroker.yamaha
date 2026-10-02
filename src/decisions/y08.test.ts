import { describe, expect, test } from "vitest";
import { YncaBrowseDriver } from "../lib/browse/ynca-browse-driver";
import { XmlBrowseDriver } from "../lib/browse/xml-browse-driver";
import type { BrowseEngine } from "../lib/browse/browse-engine";

// Y-08: Back is sent as Back. A device that refuses it does not make the adapter switch to another key on its own;
// the cursor keys — Left among them — are there for the user to step back with.

const instant = (): Promise<void> => Promise.resolve();
const engine = { onWindow: (): void => undefined } as unknown as BrowseEngine;

/** A minimal XML menu answer: ready, first level, no lines. */
const MENU =
  '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><List_Info><Menu_Status>Ready</Menu_Status><Menu_Layer>1</Menu_Layer>' +
  "<Menu_Name>NET RADIO</Menu_Name><Current_List></Current_List><Cursor_Position><Current_Line>1</Current_Line>" +
  "<Max_Line>0</Max_Line></Cursor_Position></List_Info></NET_RADIO></YAMAHA_AV>";

describe("Y-08 Back is sent as Back; no key of the adapter's own choosing replaces it", () => {
  test("YNCA: back is the generation's back word, every time — never Left", () => {
    for (const [returnWords, word] of [
      [false, "Back"],
      [true, "Return"],
    ] as const) {
      const sent: string[] = [];
      const driver = new YncaBrowseDriver(
        { send: (_subunit, func, value) => sent.push(`${func}=${value}`), get: () => undefined },
        new Set(["NETRADIO"]),
        instant,
        "list",
        { returnWords, display: true, pad: true },
      );
      driver.attach(engine);
      driver.open("netRadio");
      sent.length = 0;
      driver.back();
      driver.back();
      driver.back();
      expect(sent).toEqual([`LISTCURSOR=${word}`, `LISTCURSOR=${word}`, `LISTCURSOR=${word}`]);
    }
  });

  test("YNCA: the user's cursor keys include Left, sent as Left", () => {
    const sent: string[] = [];
    const driver = new YncaBrowseDriver(
      { send: (subunit, func, value) => sent.push(`${subunit}:${func}=${value}`), get: () => undefined },
      new Set(["NETRADIO"]),
      instant,
    );
    expect(driver.cursorValues).toEqual(expect.arrayContaining(["left", "return"]));
    driver.cursor("left");
    expect(sent).toEqual(["MAIN:LISTCURSOR=Left"]);
  });

  test("XML: a refused Return stays Return on the next press", async () => {
    const sent: string[] = [];
    const driver = new XmlBrowseDriver(
      {
        send: (_element, inner) => {
          sent.push(inner);
          return inner.includes("<Cursor>Return</Cursor>")
            ? Promise.reject(new Error("device refused (RC=2)"))
            : Promise.resolve();
        },
        getXml: () => Promise.resolve(MENU),
      },
      new Set(["NET_RADIO"]),
      instant,
    );
    driver.attach(engine);
    await driver.open("netRadio");
    sent.length = 0;
    await driver.back().catch(() => undefined);
    await driver.back().catch(() => undefined);
    expect(sent).toEqual([
      "<List_Control><Cursor>Return</Cursor></List_Control>",
      "<List_Control><Cursor>Return</Cursor></List_Control>",
    ]);
    expect(driver.cursorValues).toEqual(expect.arrayContaining(["left"]));
  });
});

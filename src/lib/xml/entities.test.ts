import { decodeXmlText, escapeXmlText } from "./entities";
import { parseBasicStatus } from "./protocol";
import { parseXmlListInfo } from "../browse/xml-browse-driver";
import { XML_AMP_CATALOG } from "./catalog";

describe("decodeXmlText", () => {
  it("resolves the predefined entities", () => {
    expect(decodeXmlText("Rock &amp; Pop")).toBe("Rock & Pop");
    expect(decodeXmlText("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeXmlText("&quot;quoted&quot; &apos;single&apos;")).toBe('"quoted" \'single\'');
  });

  it("resolves numeric character references, decimal and hexadecimal", () => {
    expect(decodeXmlText("caf&#233;")).toBe("café");
    expect(decodeXmlText("caf&#xe9;")).toBe("café");
  });

  it("leaves unknown or malformed references untouched instead of mangling them", () => {
    expect(decodeXmlText("100&nbsp;%")).toBe("100&nbsp;%");
    expect(decodeXmlText("a & b")).toBe("a & b");
  });
});

describe("escapeXmlText", () => {
  it("escapes everything that could break the request body", () => {
    expect(escapeXmlText("Rock & Pop")).toBe("Rock &amp; Pop");
    expect(escapeXmlText('<a href="x">')).toBe("&lt;a href=&quot;x&quot;&gt;");
  });

  it("round-trips with the decoder", () => {
    const raw = `Rock & Pop <"'>`;
    expect(decodeXmlText(escapeXmlText(raw))).toBe(raw);
  });
});

describe("XML values carrying entities (the predecessor's xml2js did this for free)", () => {
  it("decodes an input name in Basic_Status", () => {
    const xml = "<YAMAHA_AV><Main_Zone><Basic_Status><Input><Input_Sel>AV &amp; Audio</Input_Sel></Input></Basic_Status></Main_Zone></YAMAHA_AV>";
    expect(parseBasicStatus(xml).input).toBe("AV & Audio");
  });

  it("decodes a browse row, so a path lookup can match the folder by its real name", () => {
    const xml =
      "<List_Info><Menu_Status>Ready</Menu_Status><Menu_Layer>1</Menu_Layer>" +
      "<Menu_Name>Rock &amp; Pop</Menu_Name><Current_List>" +
      "<Line_1><Txt>Rock &amp; Pop</Txt><Attribute>Container</Attribute></Line_1>" +
      "</Current_List><Cursor_Position><Current_Line>1</Current_Line><Max_Line>1</Max_Line></Cursor_Position></List_Info>";
    const info = parseXmlListInfo(xml);
    expect(info.menuName).toBe("Rock & Pop");
    expect(info.rows[0].text).toBe("Rock & Pop");
  });

  it("escapes a written input name, so the receiver gets well-formed XML", () => {
    const entry = XML_AMP_CATALOG.find(e => e.state === "input");
    expect(entry?.toInner?.("AV & Audio")).toBe("<Input><Input_Sel>AV &amp; Audio</Input_Sel></Input>");
  });
});

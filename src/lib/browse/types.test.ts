import { MENU_WIRE, RETURN_CURSOR_WIRE, wireFor } from "./types";

// Review 2026-10-05, A35: `wireFor` returned a FUNCTION for an inherited name — `toString` put `function toString()…`
// on the wire, and the YNCA zone pad sent `@ZONE2:LISTCURSOR=function Object()…`.
describe("wireFor", () => {
  test("translates a word of the table to the transport's wire spelling", () => {
    expect(wireFor(RETURN_CURSOR_WIRE, "select")).toBe("Sel");
    expect(wireFor(RETURN_CURSOR_WIRE, "home")).toBe("Return to Home");
    expect(wireFor(MENU_WIRE, "top_menu")).toBe("Top Menu");
  });

  test("has no wire spelling for a word outside the table, an inherited property name included", () => {
    expect(wireFor(MENU_WIRE, "home")).toBeUndefined();
    expect(wireFor(RETURN_CURSOR_WIRE, "toString")).toBeUndefined();
    expect(wireFor(MENU_WIRE, "constructor")).toBeUndefined();
    expect(wireFor(MENU_WIRE, "__proto__")).toBeUndefined();
  });
});

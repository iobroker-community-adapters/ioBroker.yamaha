import { CHANNEL_DESC_KEYS, CHANNEL_NAME_KEYS } from "../catalog/types";
import type { ObjectDef } from "../catalog/types";
import { tName } from "../i18n";

/**
 * The object tree of the browsing surface. Every capable transport contributes the
 * SAME ids, so the object-tree coordinator dedups them and modernity picks the one
 * owner (YXC > YNCA > XML) — no owner override needed. The ids live under
 * `player.browse.*`, so the existing "Playback & browsing" admin group switch and
 * the `player` folder gate them like every other playback datapoint.
 *
 * @param sources the selectable sources (state value → display label)
 * @returns the channel and state definitions, parents first
 */
export function browseObjectDefs(sources: Record<string, string>): ObjectDef[] {
  const line = (n: number): ObjectDef => ({
    id: `player.browse.line${n}`,
    type: "state",
    common: { name: tName("line", n), type: "string", role: "text", read: true, write: false },
  });
  const button = (id: string, name: ioBroker.StringOrTranslated): ObjectDef => ({
    id: `player.browse.${id}`,
    type: "state",
    common: { name, type: "boolean", role: "button", read: false, write: true },
  });
  return [
    { id: "player", type: "channel", common: { name: tName("mediaPlayer") } },
    { id: "player.browse", type: "channel", common: { name: tName("browse") } },
    {
      id: "player.browse.source",
      type: "state",
      common: { name: tName("source"), type: "string", role: "state", read: true, write: true, states: sources },
    },
    {
      id: "player.browse.menuName",
      type: "state",
      common: {
        name: tName("menuName"),
        desc: tName("descMenuName"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    },
    {
      id: "player.browse.layer",
      type: "state",
      common: {
        name: tName("menuLevel"),
        desc: tName("descMenuLevel"),
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
    },
    {
      id: "player.browse.totalItems",
      type: "state",
      common: {
        name: tName("totalEntries"),
        desc: tName("descTotalEntries"),
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
    },
    {
      id: "player.browse.currentLine",
      type: "state",
      common: {
        name: tName("currentLine"),
        desc: tName("descCurrentLine"),
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(line),
    {
      id: "player.browse.selectLine",
      type: "state",
      common: {
        name: tName("selectLineFolderOpensItemPlays"),
        desc: tName("descSelectLineFolderOpensItemPlays"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
        max: 8,
        step: 1,
      },
    },
    button("pageUp", tName("pageUp")),
    button("pageDown", tName("pageDown")),
    button("back", tName("back")),
    button("home", tName("menuRoot")),
    {
      id: "player.browse.path",
      type: "state",
      common: {
        name: tName("navigatePathEGBookmarksRadioParadise"),
        desc: tName("descNavigatePathEGBookmarksRadioParadise"),
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
    },
    {
      id: "player.browse.rows",
      type: "state",
      common: {
        name: tName("rowsJSON"),
        desc: tName("descRowsJSON"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    },
    {
      id: "player.browse.busy",
      type: "state",
      common: {
        name: tName("busy"),
        desc: tName("descBusy"),
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
    },
  ];
}

/**
 * The on-screen remote of one transport: the cursor pad, and the menu keys where the
 * protocol has them.
 *
 * Lives beside the browsing surface because that is where the proof is. A cursor key is a
 * LIST command on both text protocols (`LISTCURSOR`, `<List_Control><Cursor>`), so a device
 * that answered no list probe has no pad either — the same rule that keeps the menu folder
 * off a receiver that cannot browse (#613). Ids are unprefixed, i.e. the main zone: neither
 * YNCA nor XML declares a cursor for zones 2–4.
 *
 * @param cursorValues the cursor words this transport supports (empty/absent = no pad)
 * @param menuValues the menu keys this transport supports (empty/absent = none)
 * @returns the channel and state definitions, parents first
 */
export function remoteObjectDefs(cursorValues?: readonly string[], menuValues?: readonly string[]): ObjectDef[] {
  const states = (values: readonly string[]): Record<string, string> =>
    Object.fromEntries(values.map(value => [value, value]));
  const defs: ObjectDef[] = [];
  if (!cursorValues?.length && !menuValues?.length) {
    return defs;
  }
  defs.push({
    id: "remote",
    type: "channel",
    common: { name: tName(CHANNEL_NAME_KEYS.remote), desc: tName(CHANNEL_DESC_KEYS.remote) },
  });
  if (cursorValues?.length) {
    defs.push({
      id: "remote.cursor",
      type: "state",
      common: {
        name: tName("cursorPad"),
        desc: tName("descCursorPad"),
        type: "string",
        role: "state",
        read: false,
        write: true,
        states: states(cursorValues),
      },
    });
  }
  if (menuValues?.length) {
    defs.push({
      id: "remote.menu",
      type: "state",
      common: {
        name: tName("menuKey"),
        desc: tName("descMenuKey"),
        type: "string",
        role: "state",
        read: false,
        write: true,
        states: states(menuValues),
      },
    });
  }
  return defs;
}

import { channelCommon } from "../catalog/types";
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
 * @param playLine whether the transport can play a folder line as a whole (creates `playLine`)
 * @returns the channel and state definitions, parents first
 */
export function browseObjectDefs(sources: Record<string, string>, playLine = false): ObjectDef[] {
  const line = (n: number): ObjectDef => ({
    id: `player.browse.line${n}`,
    type: "state",
    common: {
      name: tName("line", n),
      desc: tName("descLine"),
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
  });
  const button = (id: string, name: ioBroker.StringOrTranslated, desc?: ioBroker.StringOrTranslated): ObjectDef => ({
    id: `player.browse.${id}`,
    type: "state",
    common: { name, ...(desc ? { desc } : {}), type: "boolean", role: "button", read: false, write: true },
  });
  return [
    { id: "player", type: "channel", common: channelCommon("player") },
    { id: "player.browse", type: "channel", common: channelCommon("browse") },
    {
      id: "player.browse.source",
      type: "state",
      common: {
        name: tName("source"),
        desc: tName("descSource"),
        type: "string",
        role: "state",
        read: true,
        write: true,
        states: sources,
      },
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
    ...(playLine
      ? [
          {
            id: "player.browse.playLine",
            type: "state",
            common: {
              name: tName("playLine"),
              desc: tName("descPlayLine"),
              type: "number",
              role: "level",
              read: true,
              write: true,
              min: 1,
              max: 8,
              step: 1,
            },
          } satisfies ObjectDef,
        ]
      : []),
    button("pageUp", tName("pageUp"), tName("descPageUp")),
    button("pageDown", tName("pageDown"), tName("descPageDown")),
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
 * Lives beside the browsing surface because that is where the proof is: on the main zone a
 * cursor key is proven by the list probe or the pad probe, so a device that proved neither has no
 * pad — the same rule that keeps the menu folder off a receiver that cannot browse (#613). The ids
 * are unprefixed, i.e. the main zone; a zone's own pad (XML `Cursor_Control` of Zone 2, MusicCast
 * `cursor_list`) is built by its transport under the zone's prefix.
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
    common: channelCommon("remote"),
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

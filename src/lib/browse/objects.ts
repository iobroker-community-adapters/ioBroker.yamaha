import type { ObjectDef } from "../catalog/types";

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
    common: { name: `Line ${n}`, type: "string", role: "text", read: true, write: false },
  });
  const button = (id: string, name: string): ObjectDef => ({
    id: `player.browse.${id}`,
    type: "state",
    common: { name, type: "boolean", role: "button", read: false, write: true },
  });
  return [
    { id: "player", type: "channel", common: { name: "Media player" } },
    { id: "player.browse", type: "channel", common: { name: "Browse" } },
    {
      id: "player.browse.source",
      type: "state",
      common: { name: "Source", type: "string", role: "state", read: true, write: true, states: sources },
    },
    {
      id: "player.browse.menuName",
      type: "state",
      common: { name: "Menu name", type: "string", role: "text", read: true, write: false },
    },
    {
      id: "player.browse.layer",
      type: "state",
      common: { name: "Menu level", type: "number", role: "value", read: true, write: false },
    },
    {
      id: "player.browse.totalItems",
      type: "state",
      common: { name: "Total entries", type: "number", role: "value", read: true, write: false },
    },
    {
      id: "player.browse.currentLine",
      type: "state",
      common: { name: "Current line", type: "number", role: "value", read: true, write: false },
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(line),
    {
      id: "player.browse.selectLine",
      type: "state",
      common: {
        name: "Select line (folder opens, item plays)",
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
        max: 8,
        step: 1,
      },
    },
    button("pageUp", "Page up"),
    button("pageDown", "Page down"),
    button("back", "Back"),
    button("home", "Menu root"),
    {
      id: "player.browse.path",
      type: "state",
      common: {
        name: "Navigate path (e.g. Bookmarks>Radio Paradise)",
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
    },
    {
      id: "player.browse.rows",
      type: "state",
      common: { name: "Rows (JSON)", type: "string", role: "json", read: true, write: false },
    },
    {
      id: "player.browse.busy",
      type: "state",
      common: { name: "Busy", type: "boolean", role: "indicator", read: true, write: false },
    },
  ];
}

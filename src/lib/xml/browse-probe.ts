import { provesMenu, XML_BROWSE_SOURCES, type XmlBrowseSource } from "../browse/xml-browse-driver";
import type { ControllerLog } from "../controller";
import { errText } from "../err-text";
import { MEMORY_KEY } from "../lifecycle/memory-keys";
import type { ProbeMemory } from "../lifecycle/probe-memory";
import { definiteXmlBody } from "./protocol";

/** What the menu probe decided, remembered per device under `xmlBrowseSources:v2` — source ids per verdict. */
export interface BrowseVerdicts {
  /** The sources whose menu answered with a menu. */
  proven: string[];
  /** The sources the model has no menu for (RC 2, a bodyless 400/404, or an answer without a menu). */
  absent: string[];
}

/**
 * The verdicts a device's memory holds. Before review 2026-10-05 the key held the plain list of proven ids, written
 * only when EVERY probe answered for good; it is read as proven, and every other source is asked once more — that
 * list was decided against an older source table, so its silence about a source proves nothing.
 *
 * @param stored the remembered value
 * @returns the proven and the absent source ids
 */
export function rememberedBrowseVerdicts(stored: unknown): { proven: Set<string>; absent: Set<string> } {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  if (Array.isArray(stored)) {
    return { proven: new Set(ids(stored)), absent: new Set() };
  }
  const verdicts = (stored ?? {}) as Partial<Record<keyof BrowseVerdicts, unknown>>;
  return { proven: new Set(ids(verdicts.proven)), absent: new Set(ids(verdicts.absent)) };
}

/** What the probe needs: one GET, the device's memory and the log. */
export interface BrowseProbeDeps {
  /** The id-safe device id, for the log lines. */
  deviceId: string;
  /** Read an element's inner GET request. */
  getXml(element: string, inner: string): Promise<string>;
  /** The device's probe memory. */
  probeMemory: ProbeMemory;
  /** Adapter log. */
  log: ControllerLog;
}

/**
 * Which sources have a menu — ONE verdict per source. Which sources have a menu is a property of the MODEL, so a
 * decided source is never asked again; one request per menu element (the 2008 generation's three network inputs share
 * one `NET_USB` menu, D5), only for the menus still undecided.
 *
 * It was one verdict for all: twelve probes under one `Promise.all`, and a single "not now" (RC 3/4 — a receiver in
 * standby, a region-locked service that always answers 4) threw the whole probe away. A proven NET_RADIO menu was
 * then not offered for the session (0 instead of 22 objects), and a permanent RC 4 kept the menu away for good
 * (review 2026-10-05, A21). Now a proven source is used at once, a definite answer is remembered, and only an
 * undecided source is asked again on the next connect.
 *
 * @param deps the request, the memory and the log
 * @returns the ids of the sources whose menu is proven
 */
export async function decideBrowseSources(deps: BrowseProbeDeps): Promise<ReadonlySet<string>> {
  const { proven, absent } = rememberedBrowseVerdicts(deps.probeMemory.remembered(MEMORY_KEY.xmlBrowseSources));
  const menus = [...new Map(XML_BROWSE_SOURCES.map(source => [menuKey(source), source])).values()];
  const sourcesOf = (menu: XmlBrowseSource): string[] =>
    XML_BROWSE_SOURCES.filter(source => menuKey(source) === menuKey(menu)).map(source => source.id);
  const undecided = menus.filter(menu => sourcesOf(menu).some(id => !proven.has(id) && !absent.has(id)));
  const answers = await Promise.all(
    undecided.map(async menu => {
      try {
        // RC 3/4 or a transport error throws — "not now" is no verdict.
        const body = await definiteXmlBody(
          () => deps.getXml(menu.element, `<${menu.list}>GetParam</${menu.list}>`),
          `${menu.element} ${menu.list} probe`,
        );
        return { menu, hasMenu: provesMenu(menu, body) };
      } catch (e) {
        deps.log.debug(
          `${deps.deviceId}: ${menu.element} menu undecided, asking again on the next connect (${errText(e)})`,
        );
        return undefined;
      }
    }),
  );
  let decided = false;
  for (const answer of answers) {
    if (answer) {
      decided = true;
      for (const id of sourcesOf(answer.menu)) {
        (answer.hasMenu ? proven : absent).add(id);
      }
    }
  }
  if (decided) {
    const inOrder = (ids: Set<string>): string[] =>
      XML_BROWSE_SOURCES.filter(source => ids.has(source.id)).map(source => source.id);
    const verdicts: BrowseVerdicts = { proven: inOrder(proven), absent: inOrder(absent) };
    deps.probeMemory.set(MEMORY_KEY.xmlBrowseSources, verdicts);
  }
  return proven;
}

/**
 * One menu: the element and its list form.
 *
 * @param source a source
 * @returns the key of the menu it shows
 */
function menuKey(source: XmlBrowseSource): string {
  return `${source.element}|${source.list}`;
}

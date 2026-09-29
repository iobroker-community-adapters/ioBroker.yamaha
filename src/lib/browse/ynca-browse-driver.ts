import {
  ROW_KIND_BY_ATTRIBUTE,
  wireFor,
  type BrowseDriver,
  type BrowseRow,
  type BrowseRowKind,
  type CursorValue,
  type MenuValue,
  type WireTable,
} from "./types";
import type { BrowseEngine } from "./browse-engine";
import { SOURCE_INPUTS, YNCA_PLAYER_SOURCES, type YncaGenerationEvidence } from "../ynca/catalog";
import { errorMessage } from "../util";

/** Collect a burst of list lines for this long before rendering the window. */
const BURST_SETTLE_MS = 200;

/**
 * The browsable YNCA subunits — the sources {@link YNCA_PLAYER_SOURCES} marks `browse`, with the
 * transport-neutral source key (the player channel) and the `@MAIN:INP` wire value that activates
 * the source (browsing follows the active input, like the remote), from {@link SOURCE_INPUTS}.
 */
export const YNCA_BROWSE_SOURCES: ReadonlyArray<{ subunit: string; key: string; label: string; input: string }> =
  YNCA_PLAYER_SOURCES.flatMap(source => {
    const input = SOURCE_INPUTS.find(candidate => candidate.subunits.includes(source.subunit))?.value;
    return source.browse !== undefined && input !== undefined
      ? [{ subunit: source.subunit, key: source.channel, label: source.browse, input }]
      : [];
  });

/** The client surface the driver needs (a slice of the YNCA client). */
export interface YncaBrowseClient {
  /** Send a PUT command. */
  send(subunit: string, func: string, value: string): void;
  /** Send a GET request. */
  get(subunit: string, func: string): void;
}

/**
 * The main-zone pad in wire words, LIST dialect (2010–2012 generation): `@MAIN:LISTCURSOR`
 * declares all seven keys, `@MAIN:LISTMENU` five of the six menu keys — `home` has no menu
 * wire word and stays out of the dropdown instead of being mapped onto something else.
 * Sources: the official command lists (RX-V671 2011; `Display` from the RX-A3020 2012 list).
 */
const YNCA_CURSOR_WIRE: WireTable<CursorValue> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  select: "Sel",
  return: "Back",
  home: "Back to Home",
};

/**
 * The LIST dialect of the 2012 generation: the same keys, but `Return` / `Return to Home` — eight of
 * the fifteen official lists with the list dialect (HTR-7065, RX-A720/820/1020/2020/3020, RX-V673/773)
 * and the source subunits of the 2012 and 2015 lists (audit 2026-09-24, B16). The 2011 lists say
 * `Back`. The word comes from the generation evidence, never from a refused key.
 */
const YNCA_RETURN_CURSOR_WIRE: WireTable<CursorValue> = {
  ...YNCA_CURSOR_WIRE,
  return: "Return",
  home: "Return to Home",
};

const YNCA_MENU_WIRE: WireTable<MenuValue> = {
  on_screen: "On Screen",
  top_menu: "Top Menu",
  menu: "Menu",
  option: "Option",
  display: "Display",
};

/**
 * The same pad in the ZONE dialect of the 2015 generation (RX-A850 official list): `@MAIN:CURSOR`
 * with the 2012 words (`Return` / `Return to Home`) and `@MAIN:MENU` with the list dialect's menu
 * words — the tables are the same, only the functions differ (audit 2026-09-29, B16). The receiver
 * answers `@UNDEFINED` to a list-dialect key — that verdict (unknown function on this model, unlike
 * `@RESTRICTED` = not now) is what switches a device over, once, and for good.
 */
const YNCA_ZONE_CURSOR_WIRE = YNCA_RETURN_CURSOR_WIRE;
const YNCA_ZONE_MENU_WIRE = YNCA_MENU_WIRE;

/**
 * Which wire functions the main-zone pad uses (see {@link YNCA_ZONE_CURSOR_WIRE}) — or `none`: the
 * device has no pad (a 2010 receiver, or one whose probe knows neither `LISTCURSOR` nor `CURSOR`).
 */
export type YncaPadDialect = "list" | "zone" | "none";

/**
 * The YNCA list driver: navigation writes go out as LISTSEL/LISTPAGE/LISTCURSOR
 * commands, the window comes back as a burst of LISTLAYER/LISTLAYERNAME/CURRLINE/
 * MAXLINE/LINE1TXT…LINE8TXT lines — solicited by a `LISTINFO=?` read, and pushed
 * unsolicited over the held connection whenever the list changes ("Initial Auto
 * Feedback: Available" in the official command list). The controller feeds every
 * received line into {@link handleMessage}; lines for the active subunit update the
 * window assembly, which is rendered to the engine once the burst settles.
 */
export class YncaBrowseDriver implements BrowseDriver {
  private active: { subunit: string; key: string; input: string } | undefined;
  private engine: BrowseEngine | undefined;
  /** The window assembly the bursts fill. */
  private menuName = "";
  private layer = 0;
  private totalItems = 0;
  private currentLine = 1;
  private readonly texts = new Map<number, string>();
  private readonly kinds = new Map<number, BrowseRowKind>();
  /** True while a settle delay is pending, so one burst renders once. */
  private renderPending = false;
  /** True between asking for a window and the first field of the answer — see {@link refresh}. */
  private awaitingWindow = false;
  private closed = false;

  /**
   * @param client the client slice (send + get)
   * @param present the source subunits that proved their menus
   * @param delay adapter-managed delay
   * @param padDialect the pad dialect this device is known to speak (remembered per device)
   * @param generation what the device's generation says about the key words (see `yncaGenerationEvidence`)
   */
  public constructor(
    private readonly client: YncaBrowseClient,
    private readonly present: ReadonlySet<string>,
    private readonly delay: (ms: number) => Promise<void>,
    public padDialect: YncaPadDialect = "list",
    generation: YncaGenerationEvidence = { returnWords: false, display: true, pad: true },
  ) {
    this.listCursorWire = generation.returnWords ? YNCA_RETURN_CURSOR_WIRE : YNCA_CURSOR_WIRE;
    this.homeWord = generation.pad;
    // No pad on the device: no cursor or menu datapoints — every key would come back @UNDEFINED
    // (audit 2026-09-29, B5; the rule "no claim without proof").
    const pad = generation.pad && padDialect !== "none";
    this.cursorValues = pad ? Object.keys(YNCA_CURSOR_WIRE) : undefined;
    this.menuValues = pad
      ? Object.keys(YNCA_MENU_WIRE).filter(key => generation.display || key !== "display")
      : undefined;
  }

  /** Whether the sources' lists know `Back to Home` (every list from 2011 on). */
  private readonly homeWord: boolean;

  /** The list-dialect cursor words of this device's generation. */
  private readonly listCursorWire: WireTable<CursorValue>;

  /**
   * Switch the pad's dialect (see {@link YncaPadDialect}).
   *
   * @param dialect the dialect to use from now on
   */
  public usePadDialect(dialect: YncaPadDialect): void {
    this.padDialect = dialect;
  }

  /**
   * Send a refused pad key once more, in the dialect a probe just proved (see the controller's
   * `reprobePad`) — so the press that revealed the wrong dialect is not lost.
   *
   * @param func the refused function (LISTCURSOR, LISTMENU, CURSOR, MENU)
   * @param wire the refused wire value
   */
  public resend(func: string, wire: string): void {
    const cursor = func === "LISTCURSOR" || func === "CURSOR";
    const tables = cursor ? [YNCA_CURSOR_WIRE, YNCA_RETURN_CURSOR_WIRE] : [YNCA_MENU_WIRE];
    for (const table of tables) {
      const word = Object.keys(table).find(key => wireFor(table as WireTable<string>, key) === wire);
      if (word !== undefined) {
        if (cursor) {
          this.cursor(word);
        } else {
          this.menu(word);
        }
        return;
      }
    }
  }

  /**
   * Attach the engine that renders the windows (set after both are constructed).
   *
   * @param engine the browse engine
   */
  public attach(engine: BrowseEngine): void {
    this.engine = engine;
  }

  /** Stop rendering (the controller is closing). */
  public close(): void {
    this.closed = true;
  }

  /** The cursor keys this device has on the main zone — none without a pad. */
  public readonly cursorValues: string[] | undefined;

  /** The menu keys this device has on the main zone (`display` only where the generation declares it). */
  public readonly menuValues: string[] | undefined;

  /** @returns the selectable sources this device offers (state value → label) */
  public sources(): Record<string, string> {
    const entries = YNCA_BROWSE_SOURCES.filter(source => this.present.has(source.subunit));
    return Object.fromEntries(entries.map(source => [source.key, source.label]));
  }

  /**
   * Open a source's menu: switch the main-zone input to it (browsing follows the
   * active input, like the remote) and read the current window.
   *
   * @param source the source key (from {@link sources})
   */
  public open(source: string): void {
    const entry = YNCA_BROWSE_SOURCES.find(s => s.key === source && this.present.has(s.subunit));
    if (!entry) {
      return;
    }
    this.active = entry;
    this.resetAssembly();
    this.client.send("MAIN", "INP", entry.input);
    this.refresh();
  }

  /**
   * Select a visible line — `@<SUB>:LISTSEL=Line_n` acts like OK on that line.
   *
   * @param line the line number (1–8)
   */
  public select(line: number): void {
    this.command("LISTSEL", `Line_${line}`);
  }

  /** Show the previous 8 lines. */
  public pageUp(): void {
    this.command("LISTPAGE", "Up");
  }

  /** Show the next 8 lines. */
  public pageDown(): void {
    this.command("LISTPAGE", "Down");
  }

  /**
   * Go one menu level back.
   *
   * The generation's word (`Back` on the 2010/2011 lists, `Return` from 2012), never a learned
   * substitute: a refusal is not proof that the model lacks the step — `@RESTRICTED` also comes
   * back while the receiver is in standby, and switching the whole device to `Left` on that would
   * break the receivers where the listed word is the right one.
   * A model that only knows `Left` (RX-V473, issue #613) is served by `remote.cursor`, which
   * offers every value the official command list declares, including `Left`.
   */
  public back(): void {
    this.command("LISTCURSOR", wireFor(this.listCursorWire, "return") ?? "Back");
  }

  /**
   * Return to the menu root. The 2010 lists declare no `Back to Home` on a source's list — there the
   * root is reached one `Back` per level (audit 2026-09-29, B5).
   */
  public home(): void {
    if (this.homeWord) {
      this.command("LISTCURSOR", wireFor(this.listCursorWire, "home") ?? "Back to Home");
      return;
    }
    if (!this.active) {
      return;
    }
    const back = wireFor(this.listCursorWire, "return") ?? "Back";
    for (let level = this.layer; level > 2; level--) {
      this.client.send(this.active.subunit, "LISTCURSOR", back);
    }
    if (this.layer > 1) {
      this.command("LISTCURSOR", back);
    } else {
      this.refresh();
    }
  }

  /**
   * Press a cursor key — always on `@MAIN`, never on the open source.
   *
   * The official command list gives MAIN the FULL pad (Up/Down/Left/Right/Sel/Back/Back to
   * Home) while the source subunits (`@NETRADIO`, `@USB`, …) declare only
   * Up/Down/Sel/Back/Back to Home — no Left, no Right. Sending to MAIN therefore gives the
   * user every key the device has, and it works with no list open: this is the on-screen
   * menu of the receiver, not a list window. That is also the way out for a model that
   * refuses `Back` on the list (#613) — `left` steps back there.
   *
   * @param value one of {@link cursorValues}
   */
  public cursor(value: string): void {
    if (!this.cursorValues) {
      return;
    }
    if (this.padDialect === "zone") {
      this.send("CURSOR", wireFor(YNCA_ZONE_CURSOR_WIRE, value));
      return;
    }
    this.send("LISTCURSOR", wireFor(this.listCursorWire, value));
  }

  /**
   * Press a menu key (`@MAIN:LISTMENU`, or `@MAIN:MENU` in the zone dialect).
   *
   * @param value one of {@link menuValues}
   */
  public menu(value: string): void {
    if (!this.menuValues) {
      return;
    }
    if (this.padDialect === "zone") {
      this.send("MENU", wireFor(YNCA_ZONE_MENU_WIRE, value));
      return;
    }
    this.send("LISTMENU", wireFor(YNCA_MENU_WIRE, value));
  }

  /**
   * Send one main-zone remote command and re-read the window.
   *
   * @param func the YNCA function (LISTCURSOR, LISTMENU)
   * @param wire the wire value, or undefined for a word this device has no key for
   */
  private send(func: string, wire: string | undefined): void {
    if (this.closed || wire === undefined) {
      return;
    }
    this.client.send("MAIN", func, wire);
    // Only if a list is open: the pad also drives the on-screen menu, which reports nothing.
    this.refresh();
  }

  /** Re-read the current window (`LISTINFO=?` answers with the full field burst). */
  private refresh(): void {
    if (this.active) {
      // Cleared when the ANSWER starts arriving, not here: clearing eagerly would let a
      // render that is already pending paint eight empty lines before the new window shows
      // up. Every reference device answers with all eight lines (empty ones included), so
      // today the assembly is fully overwritten anyway — this makes it independent of the
      // firmware, for one that sends only the filled lines and would otherwise show the
      // tail of the PREVIOUS window under a shorter menu.
      this.awaitingWindow = true;
      this.client.get(this.active.subunit, "LISTINFO");
    }
  }

  /**
   * Feed one received YNCA line. Lines of the active subunit's list functions update
   * the window assembly; anything else is ignored. Called by the controller for every
   * message, so unsolicited auto-feedback keeps the window live.
   *
   * @param message the decoded YNCA message
   * @param message.subunit the message's subunit
   * @param message.func the message's function name
   * @param message.value the message's raw wire value
   */
  public handleMessage(message: { subunit: string; func: string; value: string }): void {
    if (!this.active || message.subunit !== this.active.subunit) {
      return;
    }
    const isWindowField =
      /^LINE[1-8](TXT|ATRIB)$/.test(message.func) ||
      ["LISTLAYERNAME", "LISTLAYER", "MAXLINE", "CURRLINE"].includes(message.func);
    if (isWindowField && this.awaitingWindow) {
      // The first field of the answer we asked for: everything still standing belongs to the
      // window before it.
      this.awaitingWindow = false;
      this.resetAssembly();
    }
    const line = /^LINE([1-8])(TXT|ATRIB)$/.exec(message.func);
    if (line) {
      const n = Number(line[1]);
      if (line[2] === "TXT") {
        this.texts.set(n, message.value);
      } else {
        this.kinds.set(n, ROW_KIND_BY_ATTRIBUTE[message.value] ?? "item");
      }
    } else if (message.func === "LISTLAYERNAME") {
      this.menuName = message.value;
    } else if (message.func === "LISTLAYER") {
      this.layer = Number(message.value) || 0;
    } else if (message.func === "MAXLINE") {
      this.totalItems = Number(message.value) || 0;
    } else if (message.func === "CURRLINE") {
      this.currentLine = Number(message.value) || 1;
    } else {
      return;
    }
    this.scheduleRender();
  }

  /**
   * Send a navigation command to the active subunit and read the window back.
   *
   * @param func the list function (LISTSEL, LISTPAGE, LISTCURSOR)
   * @param value the wire value
   */
  private command(func: string, value: string): void {
    if (!this.active) {
      return;
    }
    this.client.send(this.active.subunit, func, value);
    this.refresh();
  }

  /** Clear the window assembly — on a source switch, and when a freshly asked window starts arriving. */
  private resetAssembly(): void {
    this.awaitingWindow = false;
    this.menuName = "";
    this.layer = 0;
    this.totalItems = 0;
    this.currentLine = 1;
    this.texts.clear();
    this.kinds.clear();
  }

  /** Render once the current burst has settled (avoids 8+ renders per LISTINFO answer). */
  private scheduleRender(): void {
    if (this.renderPending) {
      return;
    }
    this.renderPending = true;
    void this.delay(BURST_SETTLE_MS)
      .then(() => {
        this.renderPending = false;
        if (!this.closed) {
          this.render();
        }
      })
      .catch((e: unknown) => {
        // Nobody awaits this chain, so a throw out of render() would be an unhandled rejection —
        // and js-controller stops the instance for one. The pending flag needs no reset here:
        // it falls in the first statement above, BEFORE render() can throw.
        this.engine?.log.debug(`browse: rendering the window failed: ${errorMessage(e)}`);
      });
  }

  /** Assemble the window from the collected fields and hand it to the engine. */
  private render(): void {
    const rows: BrowseRow[] = [];
    for (let line = 1; line <= 8; line++) {
      const text = this.texts.get(line) ?? "";
      if (text.length > 0) {
        rows.push({ line, text, kind: this.kinds.get(line) ?? "item" });
      }
    }
    this.engine?.onWindow({
      menuName: this.menuName,
      layer: this.layer,
      totalItems: this.totalItems,
      currentLine: this.currentLine,
      rows,
    });
  }
}

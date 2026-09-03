import { ROW_KIND_BY_ATTRIBUTE, type BrowseDriver, type BrowseRow, type BrowseRowKind } from "./types";
import type { BrowseEngine } from "./browse-engine";

/** Collect a burst of list lines for this long before rendering the window. */
const BURST_SETTLE_MS = 200;

/**
 * The browsable YNCA subunits (official RX-V671 command list + the all-commands
 * corpus: every one carries LISTINFO/LISTSEL/LISTCURSOR/LISTPAGE), with the
 * transport-neutral source key and the `@MAIN:INP` wire value that activates the
 * source (browsing follows the active input, like the remote).
 */
export const YNCA_BROWSE_SOURCES: ReadonlyArray<{ subunit: string; key: string; label: string; input: string }> = [
  { subunit: "NETRADIO", key: "netRadio", label: "Net Radio", input: "NET RADIO" },
  { subunit: "SERVER", key: "server", label: "Media server", input: "SERVER" },
  { subunit: "PC", key: "pc", label: "PC", input: "PC" },
  { subunit: "USB", key: "usb", label: "USB", input: "USB" },
  { subunit: "IPOD", key: "ipod", label: "iPod", input: "iPod" },
  { subunit: "IPODUSB", key: "ipodUsb", label: "iPod (USB)", input: "iPod (USB)" },
  { subunit: "NAPSTER", key: "napster", label: "Napster", input: "Napster" },
  { subunit: "PANDORA", key: "pandora", label: "Pandora", input: "Pandora" },
  { subunit: "RHAP", key: "rhapsody", label: "Rhapsody", input: "Rhapsody" },
  { subunit: "SIRIUS", key: "sirius", label: "SiriusXM", input: "SIRIUS" },
];

/** The client surface the driver needs (a slice of the YNCA client). */
export interface YncaBrowseClient {
  /** Send a PUT command. */
  send(subunit: string, func: string, value: string): void;
  /** Send a GET request. */
  get(subunit: string, func: string): void;
}

/**
 * The main-zone pad in wire words. `@MAIN:LISTCURSOR` declares all seven keys and
 * `@MAIN:LISTMENU` four of the six menu keys — the two the receiver has no wire word for
 * (display, home) stay out of the dropdown instead of being mapped onto something else.
 * Source: the official command list, `Ressourcen/yamaha/ynca-command-list-rx-v671.txt`.
 */
const YNCA_CURSOR_WIRE: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  select: "Sel",
  return: "Back",
  home: "Back to Home",
};

const YNCA_MENU_WIRE: Record<string, string> = {
  on_screen: "On Screen",
  top_menu: "Top Menu",
  menu: "Menu",
  option: "Option",
};

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
   * @param client the YNCA client slice (send + get)
   * @param present the browsable subunits this device reported in the AVAIL probe
   * @param delay adapter-managed delay
   */
  public constructor(
    private readonly client: YncaBrowseClient,
    private readonly present: ReadonlySet<string>,
    private readonly delay: (ms: number) => Promise<void>,
  ) {}

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

  /** The cursor keys this protocol has on the main zone. */
  public readonly cursorValues = Object.keys(YNCA_CURSOR_WIRE);

  /** The menu keys this protocol has on the main zone. */
  public readonly menuValues = Object.keys(YNCA_MENU_WIRE);

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
   * Always `Back`, never a learned substitute: a refusal is not proof that the model lacks the
   * step — `@RESTRICTED` also comes back while the receiver is in standby, and switching the
   * whole device to `Left` on that would break the receivers where `Back` is the right word.
   * A model that only knows `Left` (RX-V473, issue #613) is served by `remote.cursor`, which
   * offers every value the official command list declares, including `Left`.
   */
  public back(): void {
    this.command("LISTCURSOR", "Back");
  }

  /** Return to the menu root. */
  public home(): void {
    this.command("LISTCURSOR", "Back to Home");
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
    this.send("LISTCURSOR", YNCA_CURSOR_WIRE[value]);
  }

  /**
   * Press a menu key (`@MAIN:LISTMENU`).
   *
   * @param value one of {@link menuValues}
   */
  public menu(value: string): void {
    this.send("LISTMENU", YNCA_MENU_WIRE[value]);
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
    void this.delay(BURST_SETTLE_MS).then(() => {
      this.renderPending = false;
      if (!this.closed) {
        this.render();
      }
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

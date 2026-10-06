import { MUSICCAST_INPUT_NAMES } from "../catalog/musiccast-vocabulary";
import { chosenAddress } from "../network-address";
import { decodeXmlText } from "../xml/entities";

/**
 * Stable pseudonyms for the diagnostics report (after govee-smart's anonymiser).
 *
 * The report is meant for a public GitHub issue, so it must not carry the reporter's addresses,
 * serial numbers, network names or the names they gave their rooms. Blanking them (`***`) would make
 * the report useless at the same time — half of a diagnosis is "do these two lines talk about the SAME
 * device/zone" — so each distinct value gets a stable marker instead: the same address is `ip-1`
 * everywhere in the file, a second one `ip-2`. A private address stays recognisably private, and a
 * serial keeps its last four characters, which the object ids carry anyway (`rx-v6a-2b3c`).
 *
 * Two passes: {@link Pseudonymiser.learn} collects the values that have no detectable shape (names,
 * serials, MACs written without separators) from the places the protocols put them; {@link
 * Pseudonymiser.walk} then replaces every occurrence anywhere in the report, plus everything that has a
 * shape of its own (IPv4, separated MACs, mail addresses, UUIDs). Markers are stable inside ONE file only.
 */

/** IPv4 in dotted form, each part 0–255. */
const IPV4 =
  /\b(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/** A MAC written with separators. */
const MAC_SEPARATED = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;

/** Anything shaped like a mail address — an account name can surface in a streaming service's answer. */
const EMAIL = /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/gi;

/** A UUID — MusicCast's `analytics_info.uuid` names one installation of the app, a UPnP UDN one device. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Zone names a receiver ships with — not personal, and replacing them would hide what a zone is. */
const GENERIC_NAME = /^(main|main ?zone|zone ?[1-4ab]|zone_[1-4]|room ?\d*|living|home\d*|a yamaha device)$/i;

/**
 * A Yamaha model designation (`RX-V6A`, `WX-030`, `R-N500`, `CD-NT670D`). A log line that names a device by its
 * model where it has no name of its own must not turn the model into a "name" — the report would lose it everywhere.
 */
const MODEL_DESIGNATION = /^[A-Z]{1,5}-[A-Z0-9]{2,}[A-Z0-9-]*$/;

/** JSON keys whose value is a serial number (MusicCast `getDeviceInfo`, the device identity, XML's System_ID). */
const SERIAL_KEYS = new Set(["system_id", "serial_number", "serial", "systemid"]);

/** JSON keys whose value is a MAC without separators — MusicCast's `device_id` is the device's MAC. */
const MAC_KEYS = new Set(["device_id"]);

/** JSON keys whose value is a name the user gave: the network name, the WLAN, the MusicCast Link group. */
const NAME_KEYS = new Set(["ssid", "network_name", "group_name"]);

/** JSON keys whose value is a secret — never shown, not even as a marker. */
const SECRET_KEYS = new Set(["key", "airplay_pin", "password", "token"]);

/**
 * YNCA functions whose value is a name the user gave — the zone names and the paired Bluetooth device —
 * as an answer key (`MAIN:ZONENAME`) or as the bare function the remembered profile keeps per subunit
 * (`subunits.MAIN.ZONENAME`; review 2026-10-05, B1).
 */
const YNCA_NAME_KEY = /^(?:[A-Z0-9]+:)?(?:ZONE[AB]?NAME|DEVICENAME)$/;

/** The same functions in a received line: `@MAIN:ZONENAME=Wohnzimmer`, `@BT:DEVICENAME=iPhone von Anna`. */
const YNCA_NAME_LINE = /^@?[A-Z0-9]+:(?:ZONE[AB]?NAME|DEVICENAME)=(.+)$/gm;

/**
 * XML nodes whose text is a name the user gave: inside a zone's `<Name>` block the zone (`<Zone>`), Zone B
 * (`<Zone_B>`, HTR-4069/RX-V579) and the MusicCast room (`<Room_for_YXC>`, RX-V6A) — only inside the block,
 * because Basic_Status carries a `<Zone_B>` block of its own —; the 2008 zone name (`<Rename_Latin_1>`); the
 * paired Bluetooth device (`<Device_Name>`).
 */
const XML_NAME_BLOCK = /<Name>([\s\S]*?)<\/Name>/g;
const XML_BLOCK_NAME = /<(?:Zone|Zone_B|Room_for_YXC)>([^<]+)<\//g;
const XML_NAME = /<(?:Rename_Latin_1|Device_Name)>([^<]+)<\//g;

/**
 * The datapoints whose value is a name the user gave (the zone names, Zone B, the MusicCast Link group, the
 * paired Bluetooth device). The object tree carries them under `val`, next to their `id`.
 */
const PERSONAL_STATE =
  /^(?:(?:multiroom\.zone[2-4B]\.)?zoneName|multiroom\.group\.name|player\.bluetooth\.deviceName)$/;

/**
 * The adapter's log lines that carry a device's name (main.ts: the SSDP NOTIFY a device announces itself
 * with, the display name it is given). Pinned by a test against the source of main.ts.
 */
const LOG_NAMES: readonly RegExp[] = [/^SSDP alive from \S+: (.+) announced itself$/, /: device name set to "(.+)"$/];

/**
 * An input name the user can change in the receiver (Y-25) — YNCA `@SYS:INPNAME<CODE>`, MusicCast `getNameText`
 * `input_list`, XML `Input_Sel_Item` `<Title>` next to its `<Param>`, the profile's XML `inputNames`, the `input` dropdown.
 */
const YNCA_INPUT_NAME_KEY = /^(?:SYS:)?INPNAME([A-Z0-9]+)$/;
const YNCA_INPUT_NAME_LINE = /^@?SYS:INPNAME([A-Z0-9]+)=(.+)$/gm;
const XML_INPUT_LIST = /<Input_Sel_Item>([\s\S]*?)<\/Input_Sel_Item>/g;
const XML_INPUT_ITEM = /<Param>([^<]*)<\/Param>[\s\S]*?<Title>([^<]*)<\/Title>/g;
const INPUT_DATAPOINT = /^(?:multiroom\.zone[2-4]\.)?input$/;

/**
 * How an input name is compared with its code and the factory names: letters and digits only, any case.
 *
 * @param value a name or a code
 * @returns the comparison key
 */
function inputKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The factory names of the inputs — every MusicCast id and its classic spelling (`net_radio`, "NET RADIO"), plus the
 * YNCA-only codes and names. A name the user did not change stays readable: "USB" or "TUNER" says which input it is.
 */
const FACTORY_INPUT_NAMES = new Set(
  [
    ...Object.keys(MUSICCAST_INPUT_NAMES),
    ...Object.values(MUSICCAST_INPUT_NAMES),
    "dock",
    "iPod",
    "iPod (USB)",
    "SIRIUS InternetRadio",
  ].map(inputKey),
);

/** What a taught value is — and what its marker says. */
export type PersonalKind = "name" | "serial" | "mac" | "host" | "device";

/** One value the pseudonymiser replaces wherever it occurs. */
interface Known {
  kind: PersonalKind;
  /** The value the marker stands for — an XML text taught in its raw and its decoded form shares one. */
  canonical: string;
}

/**
 * Whether a kind is matched regardless of case — serials and MACs are written in both.
 *
 * @param kind the kind
 * @returns true for serials and MACs
 */
function caseless(kind: PersonalKind): boolean {
  return kind === "serial" || kind === "mac";
}

/**
 * Addresses that say something about the setup but nothing about the person.
 *
 * @param address an IPv4 address
 * @returns true for the unspecified address, masks and loopback
 */
function isNeutralAddress(address: string): boolean {
  return chosenAddress(address) === undefined || address.startsWith("255.") || address.startsWith("127.");
}

/**
 * Whether an IPv4 address is private (RFC 1918, link-local).
 *
 * @param address an IPv4 address
 * @returns true for a private address
 */
function isPrivate(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Replaces personal values in a report with stable markers. */
export class Pseudonymiser {
  private readonly markers = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  /** Known values without a shape, replaced wherever they occur. */
  private readonly known = new Map<string, Known>();
  /** The caseless ones by their upper-case spelling — what a case-insensitive match is looked up by. */
  private readonly knownCaseless = new Map<string, Known>();
  /**
   * The known values as two alternations, longest first — built once per set of values, not per string and
   * value: a report of a few thousand strings and a few dozen values took ~400 ms (seconds on a Pi) when every
   * string compiled every value's pattern anew (review 2026-10-05, B8). Undefined until needed.
   */
  private patterns: { exact?: RegExp; caseless?: RegExp } | undefined;

  /**
   * Teach a value that has no shape of its own.
   *
   * @param kind what it is
   * @param value the value (ignored when empty, generic or too short to replace safely)
   * @param alias another spelling of the same value (an XML text before its entities are decoded) — the
   *   same marker for both
   */
  public teach(kind: PersonalKind, value: unknown, alias?: string): void {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length < 3 || (kind === "name" && GENERIC_NAME.test(trimmed)) || /^0+$/.test(trimmed)) {
      return;
    }
    const canonical = kind === "mac" ? trimmed.replace(/[:-]/g, "").toUpperCase() : trimmed;
    this.remember(canonical, { kind, canonical });
    const other = alias?.trim();
    if (other && other !== trimmed && other.length >= 3) {
      this.remember(other, { kind, canonical });
    }
  }

  /**
   * Keep one spelling of a known value.
   *
   * @param spelling how it is written
   * @param known what it stands for
   */
  private remember(spelling: string, known: Known): void {
    this.known.set(spelling, known);
    if (caseless(known.kind)) {
      this.knownCaseless.set(spelling.toUpperCase(), known);
    }
    this.patterns = undefined;
  }

  /**
   * Collect the shapeless personal values from the places the three protocols put them.
   *
   * @param value the report (or any part of it)
   * @param key the key the value sits under
   * @param path the keys above it
   */
  public learn(value: unknown, key = "", path: readonly string[] = []): void {
    if (typeof value === "string") {
      this.learnFromText(value, key, path);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.learn(item, key, path);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      // A datapoint of the object tree: the value of a name datapoint is a name (review 2026-10-05, B1).
      if (typeof record.id === "string" && PERSONAL_STATE.test(record.id)) {
        this.teach("name", record.val);
      }
      // The input dropdown: its labels are the names the user gave the inputs (Y-25).
      if (typeof record.id === "string" && INPUT_DATAPOINT.test(record.id) && isRecord(record.states)) {
        for (const [code, label] of Object.entries(record.states)) {
          this.teachInputName(label, code);
        }
      }
      // MusicCast getNameText: `input_list` pairs each input id with the name the user gave it.
      if (key === "input_list" && typeof record.id === "string") {
        this.teachInputName(record.text, record.id);
      }
      const below = [...path, key];
      // A recorded request and its answer (the diagnostics trail): the answer is read under its endpoint, as the live
      // read's captures are — the rules that know an endpoint (getLocationInfo) reach it there too.
      const request = typeof record.request === "string" ? record.request.split(" ")[0] : undefined;
      for (const [k, v] of Object.entries(record)) {
        this.learn(v, k === "answer" && request ? request : k, below);
      }
    }
  }

  private learnFromText(value: string, key: string, path: readonly string[]): void {
    const lower = key.toLowerCase();
    const parent = path[path.length - 1]?.toLowerCase() ?? "";
    if (SERIAL_KEYS.has(lower)) {
      this.teach("serial", value);
    } else if (NAME_KEYS.has(lower)) {
      this.teach("name", value);
    } else if (MAC_KEYS.has(lower) || lower.includes("mac") || parent.includes("mac_address")) {
      this.teach("mac", value);
    } else if (lower === "text" && path.some(p => p === "zone_list")) {
      // MusicCast getNameText: the names the user gave the zones.
      this.teach("name", value);
    } else if ((lower === "name" || lower === "id") && path.some(p => p.endsWith("getLocationInfo"))) {
      this.teach("name", value);
    } else if (parent.startsWith("xmlzonenames:")) {
      // XML's remembered zone names (`xmlZoneNames:<zone>` → zone, Zone B) in the capability profile.
      this.teach("name", value);
    } else if (YNCA_NAME_KEY.test(key)) {
      this.teach("name", value);
    } else if (YNCA_INPUT_NAME_KEY.test(key)) {
      this.teachInputName(value, YNCA_INPUT_NAME_KEY.exec(key)?.[1] ?? "");
    } else if (parent === "inputnames") {
      // XML's remembered input names in the capability profile (`HDMI_1` → "Apple TV").
      this.teachInputName(value, key);
    } else if (lower === "msg") {
      for (const pattern of LOG_NAMES) {
        const name = pattern.exec(value)?.[1];
        if (name !== undefined && !MODEL_DESIGNATION.test(name)) {
          this.teach("name", name);
        }
      }
    }
    if (/:MAC/.test(key)) {
      this.teach("mac", value);
    }
    // YNCA: the names inside raw lines.
    if (value.includes("NAME")) {
      for (const match of value.matchAll(YNCA_NAME_LINE)) {
        this.teach("name", match[1]);
      }
      for (const match of value.matchAll(YNCA_INPUT_NAME_LINE)) {
        this.teachInputName(match[2], match[1]);
      }
    }
    if (value.includes("<")) {
      this.learnFromXml(value);
    }
  }

  /**
   * The serial, the MACs and the names inside a raw XML response body. A name is taught as the device
   * means it (entities decoded, what the datapoint shows) and as the body spells it.
   *
   * @param body the body
   */
  private learnFromXml(body: string): void {
    for (const match of body.matchAll(/<System_ID>([^<]+)<\/System_ID>/g)) {
      this.teach("serial", match[1]);
    }
    for (const match of body.matchAll(/<(?:Wired|Wireless)_LAN>([0-9A-Fa-f]{12})<\//g)) {
      this.teach("mac", match[1]);
    }
    const teachName = (raw: string): void => this.teach("name", decodeXmlText(raw), raw);
    for (const block of body.matchAll(XML_NAME_BLOCK)) {
      for (const match of block[1].matchAll(XML_BLOCK_NAME)) {
        teachName(match[1]);
      }
    }
    for (const match of body.matchAll(XML_NAME)) {
      teachName(match[1]);
    }
    for (const list of body.matchAll(XML_INPUT_LIST)) {
      for (const item of list[1].matchAll(XML_INPUT_ITEM)) {
        if (!this.isFactoryInputName(decodeXmlText(item[2]), decodeXmlText(item[1]))) {
          teachName(item[2]);
        }
      }
    }
  }

  /**
   * Teach an input name — unless it is the input's factory name, which says only which input it is.
   *
   * @param name the name the device reports
   * @param code the input it belongs to (YNCA `HDMI1`, MusicCast `hdmi1`, XML `HDMI_1`)
   */
  private teachInputName(name: unknown, code: string): void {
    if (typeof name === "string" && !this.isFactoryInputName(name, code)) {
      this.teach("name", name);
    }
  }

  /**
   * Whether an input name is the one the input has from the factory: its own code, or any input's factory name.
   *
   * @param name the name
   * @param code the input's code
   * @returns true for a factory name
   */
  private isFactoryInputName(name: string, code: string): boolean {
    const key = inputKey(name);
    return key === "" || key === inputKey(code) || FACTORY_INPUT_NAMES.has(key);
  }

  /**
   * Replace every personal value in the report.
   *
   * @param value the report (or any part of it)
   * @param key the key the value sits under
   * @returns the pseudonymised copy
   */
  public walk(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        return value === "" ? "" : "***";
      }
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.walk(item, key));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.text(k), this.walk(v, k)]));
    }
    return value;
  }

  /**
   * Pseudonymise one text: the known values first (longest first, so a name inside a longer one does
   * not split it), then the shapes.
   *
   * @param text the text
   * @returns the text with markers
   */
  public text(text: string): string {
    const patterns = (this.patterns ??= this.compile());
    let out = text;
    if (patterns.exact) {
      out = out.replace(patterns.exact, match => this.markerOf(match, this.known.get(match)));
    }
    if (patterns.caseless) {
      out = out.replace(patterns.caseless, match => this.markerOf(match, this.knownCaseless.get(match.toUpperCase())));
    }
    out = out.replace(IPV4, address => (isNeutralAddress(address) ? address : this.marker("ip", address)));
    out = out.replace(MAC_SEPARATED, mac => this.marker("mac", mac.replace(/[:-]/g, "").toUpperCase()));
    out = out.replace(EMAIL, mail => this.marker("mail", mail.toLowerCase()));
    // An all-zero UUID is "not set" — like 0.0.0.0, it says something about the setup and nothing about the person.
    out = out.replace(UUID, uuid => (/^[0-]+$/.test(uuid) ? uuid : this.marker("uuid", uuid.toLowerCase())));
    return out;
  }

  /**
   * The two alternations of the known values, longest first.
   *
   * @returns the patterns (absent where no value of the kind is known)
   */
  private compile(): { exact?: RegExp; caseless?: RegExp } {
    const alternation = (spellings: string[], flags: string): RegExp | undefined =>
      spellings.length > 0
        ? new RegExp(
            spellings
              .sort((a, b) => b.length - a.length)
              .map(escapeRegExp)
              .join("|"),
            flags,
          )
        : undefined;
    const entries = [...this.known];
    return {
      exact: alternation(
        entries.filter(([, known]) => !caseless(known.kind)).map(([spelling]) => spelling),
        "g",
      ),
      caseless: alternation(
        entries.filter(([, known]) => caseless(known.kind)).map(([spelling]) => spelling),
        "gi",
      ),
    };
  }

  /**
   * The marker of a known value.
   *
   * @param match the text the pattern matched
   * @param known what it stands for (always found — the pattern is built from the same table)
   * @returns its marker
   */
  private markerOf(match: string, known: Known | undefined): string {
    return known ? this.marker(known.kind, known.canonical) : match;
  }

  /**
   * The stable marker of one value.
   *
   * @param kind the kind of value
   * @param value the value
   * @returns its marker, the same for the same value throughout the report
   */
  private marker(kind: string, value: string): string {
    const id = `${kind}\u0000${kind === "serial" ? value.toUpperCase() : value}`;
    const existing = this.markers.get(id);
    if (existing) {
      return existing;
    }
    const prefix = kind === "ip" ? (isPrivate(value) ? "ip-private" : "ip-public") : kind;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    // A serial keeps its last four characters: the object ids carry them anyway, and they tell two
    // receivers of the same model apart.
    const marker = kind === "serial" ? `serial-${n}-…${value.slice(-4).toUpperCase()}` : `${prefix}-${n}`;
    this.markers.set(id, marker);
    return marker;
  }
}

/**
 * Whether a value is a plain object.
 *
 * @param value the value
 * @returns true for an object that is not an array
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Escape a literal for a regular expression.
 *
 * @param value the literal
 * @returns the escaped literal
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { MUSICCAST_INPUT_NAMES } from "../catalog/musiccast-vocabulary";
import { decodeXmlText } from "../xml/entities";
import type { Placeholders } from "./placeholders";

/**
 * What in a yamaha report is personal and has no shape of its own — the fleet master `Placeholders` replaces it.
 *
 * The master finds addresses, MACs and mail addresses by their form; everything else (names the user gave, serial
 * numbers, MACs a protocol writes without separators, UUIDs, a device id made from a typed name) it replaces only
 * once the adapter registers it with `name()` (page "Diagnosebericht — Flottenstandard", DB-04/DB-05).
 * {@link PersonalValues.learn} collects those values from the places the three protocols put them; secrets are
 * blanked before ({@link blankSecrets}) — the master's order: blank, replace, cut.
 */

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

/** JSON keys whose value is a name the user gave: the device's network name, the MusicCast Link group. */
const NAME_KEYS = new Set(["network_name", "group_name"]);

/** JSON keys whose value is a WLAN name — its own kind: the master replaces it wherever it stands, inside a token too. */
const NETWORK_KEYS = new Set(["ssid"]);

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

/**
 * The words the protocols use — the input ids and factory names, split into words (`net_radio` → `net`, `radio`), and
 * the YNCA subunit words. The master replaces a registered name as a whole word with `_` and `-` as word boundaries,
 * so a name made only of such words ("Radio") would also replace `radio` in `net_radio` and leave the report without
 * its protocol words; such a name says nothing personal and stays readable (round 97, measured 2026-10-07).
 */
const PROTOCOL_WORDS = new Set(
  [
    ...Object.keys(MUSICCAST_INPUT_NAMES),
    ...Object.values(MUSICCAST_INPUT_NAMES),
    "main zone sys server system tuner bluetooth airplay spotify pandora napster netradio usb pc ipod",
  ]
    .flatMap(text => text.toLowerCase().split(/[\s_\-()/]+/))
    .filter(word => word.length > 0),
);

/**
 * Whether a name consists of protocol words only.
 *
 * @param name the name
 * @returns true when every word of it is a protocol word
 */
function onlyProtocolWords(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[\s_-]+/)
    .every(word => word === "" || PROTOCOL_WORDS.has(word));
}

/** What a registered value is — the placeholder's word. */
export type PersonalKind = "name" | "serial" | "mac" | "host" | "device" | "uuid" | "network";

/** JSON keys whose value is a secret — never shown, not even as a placeholder. */
const SECRET_KEYS = new Set(["key", "airplay_pin", "password", "token"]);

/**
 * Blank the secrets of a report — before the placeholders replace anything.
 *
 * @param value the report (or any part of it)
 * @param key the key the value sits under
 * @returns a copy with every secret as `***` (an empty one stays empty)
 */
export function blankSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return SECRET_KEYS.has(key.toLowerCase()) && value !== "" ? "***" : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => blankSecrets(item, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankSecrets(v, k)]));
  }
  return value;
}

/** Finds the personal values of a yamaha report and registers them with the report's placeholders. */
export class PersonalValues {
  /**
   * @param places the report's placeholders
   */
  public constructor(private readonly places: Placeholders) {}

  /**
   * Register a value that has no shape of its own.
   *
   * @param kind what it is
   * @param value the value (ignored when empty, generic or too short to replace safely)
   * @param alias another spelling of the same value (an XML text before its entities are decoded)
   */
  public teach(kind: PersonalKind, value: unknown, alias?: string): void {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (
      trimmed.length < 3 ||
      (kind === "name" && (GENERIC_NAME.test(trimmed) || onlyProtocolWords(trimmed))) ||
      /^0+$/.test(trimmed)
    ) {
      return;
    }
    this.places.name(trimmed, kind);
    const other = alias?.trim();
    if (other && other !== trimmed && other.length >= 3) {
      this.places.name(other, kind);
    }
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
    // An all-zero UUID is "not set" — it says something about the setup and nothing about the person.
    for (const uuid of value.match(UUID) ?? []) {
      if (!/^[0-]+$/.test(uuid)) {
        this.teach("uuid", uuid);
      }
    }
    const lower = key.toLowerCase();
    const parent = path[path.length - 1]?.toLowerCase() ?? "";
    if (SERIAL_KEYS.has(lower)) {
      this.teach("serial", value);
    } else if (NAME_KEYS.has(lower)) {
      this.teach("name", value);
    } else if (NETWORK_KEYS.has(lower)) {
      this.teach("network", value);
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

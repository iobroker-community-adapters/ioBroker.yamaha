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
 * shape of its own (IPv4, separated MACs, mail addresses). Markers are stable inside ONE file only.
 */

/** IPv4 in dotted form, each part 0–255. */
const IPV4 =
  /\b(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/** A MAC written with separators. */
const MAC_SEPARATED = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;

/** Anything shaped like a mail address — an account name can surface in a streaming service's answer. */
const EMAIL = /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/gi;

/** Zone names a receiver ships with — not personal, and replacing them would hide what a zone is. */
const GENERIC_NAME = /^(main|main ?zone|zone ?[1-4ab]|zone_[1-4]|room ?\d*|living|home\d*)$/i;

/** JSON keys whose value is a serial number (MusicCast `getDeviceInfo`, the device identity). */
const SERIAL_KEYS = new Set(["system_id", "device_id", "serial_number", "serial"]);

/** JSON keys whose value is personal although it has no shape. */
const NAME_KEYS = new Set(["ssid", "network_name"]);

/** JSON keys whose value is a secret — never shown, not even as a marker. */
const SECRET_KEYS = new Set(["key", "airplay_pin", "password", "token"]);

/**
 * Addresses that say something about the setup but nothing about the person.
 *
 * @param address an IPv4 address
 * @returns true for the unspecified address, masks and loopback
 */
function isNeutralAddress(address: string): boolean {
  return address === "0.0.0.0" || address.startsWith("255.") || address.startsWith("127.");
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
  /** Known values without a shape → their kind, replaced wherever they occur. */
  private readonly known = new Map<string, "name" | "serial" | "mac" | "host">();

  /**
   * Teach a value that has no shape of its own.
   *
   * @param kind what it is
   * @param value the value (ignored when empty, generic or too short to replace safely)
   */
  public teach(kind: "name" | "serial" | "mac" | "host", value: unknown): void {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length < 3 || (kind === "name" && GENERIC_NAME.test(trimmed)) || /^0+$/.test(trimmed)) {
      return;
    }
    this.known.set(kind === "mac" ? trimmed.replace(/[:-]/g, "").toUpperCase() : trimmed, kind);
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
      for (const [k, v] of Object.entries(value)) {
        this.learn(v, k, [...path, key]);
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
    } else if (lower.includes("mac") || parent.includes("mac_address")) {
      this.teach("mac", value);
    } else if (lower === "text" && path.some(p => p === "zone_list")) {
      // MusicCast getNameText: the names the user gave the zones.
      this.teach("name", value);
    } else if ((lower === "name" || lower === "id") && path.some(p => p.endsWith("getLocationInfo"))) {
      this.teach("name", value);
    }
    // YNCA: `@MAIN:ZONENAME=Wohnzimmer` (a raw line) or `MAIN:ZONENAME` → value (an answer).
    for (const match of value.matchAll(/^@?[A-Z0-9]+:ZONE[AB]?NAME=(.+)$/gm)) {
      this.teach("name", match[1]);
    }
    if (/:ZONE[AB]?NAME$/.test(key)) {
      this.teach("name", value);
    }
    if (/:MAC/.test(key)) {
      this.teach("mac", value);
    }
    // XML: the serial, the MACs and the zone names inside a raw response body.
    for (const match of value.matchAll(/<System_ID>([^<]+)<\/System_ID>/g)) {
      this.teach("serial", match[1]);
    }
    for (const match of value.matchAll(/<(?:Wired|Wireless)_LAN>([0-9A-Fa-f]{12})<\//g)) {
      this.teach("mac", match[1]);
    }
    for (const match of value.matchAll(/<Name>\s*<Zone>([^<]+)<\/Zone>/g)) {
      this.teach("name", match[1]);
    }
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
    let out = text;
    const known = [...this.known].sort(([a], [b]) => b.length - a.length);
    for (const [value, kind] of known) {
      const pattern = new RegExp(escapeRegExp(value), kind === "name" || kind === "host" ? "g" : "gi");
      out = out.replace(pattern, match => this.marker(kind, kind === "mac" ? match.toUpperCase() : match));
    }
    out = out.replace(IPV4, address => (isNeutralAddress(address) ? address : this.marker("ip", address)));
    out = out.replace(MAC_SEPARATED, mac => this.marker("mac", mac.replace(/[:-]/g, "").toUpperCase()));
    out = out.replace(EMAIL, mail => this.marker("mail", mail.toLowerCase()));
    return out;
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
 * Escape a literal for a regular expression.
 *
 * @param value the literal
 * @returns the escaped literal
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

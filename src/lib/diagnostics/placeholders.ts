// Fleet master (.consistency-master/src/lib/diagnostics/placeholders.ts) — never edit the copy in an adapter.
//
// Diagnostics report standard (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard"): what the report promises about
// privacy it keeps (DB-04, krobi 2026-09-22: the promise is kept, not only made), and names the user gave stand in it
// only as placeholders (DB-05). The core every adapter shares: stable
// placeholders per report, addresses, hardware ids and mail addresses found by their form, names found as whole words in
// any case and with any separator, in values and in object keys alike.
// Order for every text: the adapter blanks secrets first, then this replaces, then the report is cut to size.
// What else is personal (serial numbers, network names, an adapter's own fields) the adapter registers with `name()`.

import { isIPv6 } from "node:net";

/** One IPv4 number, 0–255. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** IPv4, four numbers 0–255, not part of a longer dotted number — a full stop after it ends a sentence. */
const IPV4 = new RegExp(`(?<!\\d|\\d\\.)${OCTET}(?:\\.${OCTET}){3}(?!\\d|\\.\\d)`, "g");
/**
 * What may be an IPv6 address, written out or shortened with `::`, also right after a `:` (`host:fe80::1`); `isIPv6`
 * decides. One bounded run (an address has at most 45 characters), so a long text is read in linear time.
 */
const IPV6_CANDIDATE = /(?<![\w.])[0-9A-Fa-f:.]{2,45}(?![\w:])/g;
/** A hardware id: six (MAC) or eight (EUI-64) bytes with `:` or `-` between them. */
const HARDWARE =
  /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}(?:(?:[:-][0-9A-Fa-f]{2}){2})?(?![0-9A-Fa-f:-])/g;
/** A MAC address without separators: twelve hex digits with at least one letter and one digit. */
const BARE_MAC = /(?<![0-9A-Za-z])(?=[0-9A-Fa-f]*[A-Fa-f])(?=[0-9A-Fa-f]*\d)[0-9A-Fa-f]{12}(?![0-9A-Za-z])/g;
/** A mail address — it starts only where a word starts, so a long text without `@` is read in linear time. */
const MAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * The placeholders of one report: the same real value always gets the same placeholder inside it (`address-1`,
 * `name-2` …), so two lines about the same thing stay recognisable. A new report starts counting anew.
 */
export class Placeholders {
  private readonly known = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private readonly names = new Map<string, string>();

  /**
   * The placeholder for one value.
   *
   * @param kind what it is, the placeholder's word (`address`, `mac`, `name`, `serial` …)
   * @param value the real value
   * @returns the placeholder
   */
  public mark(kind: string, value: string): string {
    const key = `${kind}\u0000${value.toLowerCase()}`;
    const known = this.known.get(key);
    if (known) {
      return known;
    }
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const placeholder = `${kind}-${n}`;
    this.known.set(key, placeholder);
    return placeholder;
  }

  /**
   * Register a name the user gave (a device, room or network name) or any other personal value: from now on it is
   * replaced wherever it stands as a whole word — in any case, and with spaces, `_` or `-` between its words.
   *
   * @param value the real value (blank ones are ignored)
   * @param kind the placeholder's word, `name` when not given
   * @returns the placeholder, or the value itself when it is blank
   */
  public name(value: string, kind = "name"): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return value;
    }
    const placeholder = this.mark(kind, trimmed);
    this.names.set(trimmed, placeholder);
    return placeholder;
  }

  /**
   * Replace everything personal in a text: the registered names (longest first, as whole words), then mail, hardware
   * ids and IP addresses by their form.
   *
   * @param text the text
   * @returns the text with placeholders
   */
  public text(text: string): string {
    let out = text;
    const names = [...this.names.entries()].sort(([a], [b]) => b.length - a.length);
    for (const [name, placeholder] of names) {
      const words = name.split(/[\s_-]+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]+")}(?![\\p{L}\\p{N}])`, "giu"),
        placeholder,
      );
    }
    out = out.replace(MAIL, match => this.mark("mail", match));
    out = out.replace(HARDWARE, match => this.mark("mac", match.replace(/-/g, ":")));
    out = out.replace(BARE_MAC, match => this.mark("mac", match.replace(/(..)(?!$)/g, "$1:")));
    out = out.replace(IPV6_CANDIDATE, match => {
      const address = match.replace(/\.+$/, "");
      return isIPv6(address) && /[0-9A-Fa-f]/.test(address)
        ? this.mark("address", address) + match.slice(address.length)
        : match;
    });
    return out.replace(IPV4, match => this.mark("address", match));
  }

  /**
   * Replace in every string of a value and in every object key — a device keyed by its address or name is as
   * personal as the value.
   *
   * @param value any JSON-like value
   * @returns a copy with placeholders
   */
  public deep(value: unknown): unknown {
    if (typeof value === "string") {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.deep(item));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        // two keys that become the same placeholder (`Kitchen` and `kitchen`) both stay in the report
        let name = this.text(key);
        for (let n = 2; Object.hasOwn(out, name); n++) {
          name = `${this.text(key)}#${n}`;
        }
        out[name] = this.deep(item);
      }
      return out;
    }
    return value;
  }
}

/**
 * The canary check every adapter's report test runs: which of the real values still stand in the finished report, in
 * any case.
 *
 * @param report the report text
 * @param secrets the real values that must not appear
 * @returns the ones that leaked
 */
export function leaked(report: string, secrets: readonly string[]): string[] {
  const lower = report.toLowerCase();
  return secrets.filter(secret => secret.length > 0 && lower.includes(secret.toLowerCase()));
}

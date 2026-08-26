/**
 * XML entity handling for the legacy protocol.
 *
 * The XML transport reads values with regular expressions and writes them by string
 * interpolation, so entities have to be handled explicitly — the predecessor adapter got
 * this for free from its XML parser (`legacy/soef.js` used xml2js), which makes a missing
 * conversion a regression against the surface those users had. It shows up wherever device
 * content carries a `&`: an internet-radio folder "Rock & Pop" arrives as `Rock &amp; Pop`
 * and the browse path never matches it, and a renamed input written back unescaped
 * produces a body the receiver silently discards.
 */

/** The five predefined XML entities, plus numeric character references. */
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Turn XML entities in a text value back into their characters.
 *
 * @param raw the raw text captured from the response
 * @returns the decoded text
 */
export function decodeXmlText(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X") ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

/**
 * Escape a value for use inside an XML element, so a name containing `&` or `<` cannot
 * break the request body.
 *
 * @param value the value to escape (stringified first — catalog writes are untyped)
 * @returns the escaped text
 */
export function escapeXmlText(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

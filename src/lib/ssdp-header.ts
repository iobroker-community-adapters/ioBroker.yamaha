/**
 * One header's value, trimmed — header names are case-insensitive (RFC 2616 / UPnP DA), and a header starts a line: the
 * one parser of the NOTIFY listener and the M-SEARCH answers (the search's own unanchored copy also matched
 * `X-LOCATION:` or a LOCATION inside another header's value — review 2026-10-05, E).
 *
 * @param message the datagram text
 * @param name the header name
 * @returns the value, or undefined
 */
export function ssdpHeader(message: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.*?)\\s*$`, "im").exec(message);
  return match?.[1] || undefined;
}

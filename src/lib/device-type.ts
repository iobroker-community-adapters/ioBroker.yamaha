/**
 * Device-type detection from the model name the device itself reports (YNCA MODELNAME,
 * YXC/XML model), mapped to one of five simple silhouette icons. Yamaha's model prefixes
 * identify the product line reliably across generations; an unrecognized or empty model
 * falls back to the AV-receiver silhouette (the by-far most common device class).
 *
 * The icons are original minimal silhouettes (no Yamaha trademarks), inlined as data
 * URLs so they render everywhere an object icon is shown (admin tree, device cards) without
 * serving files — and in the row's own colour, see {@link pictogram}.
 */

/** The five device classes the icons distinguish. */
export type DeviceType = "avReceiver" | "stereoReceiver" | "speaker" | "soundbar" | "cdSystem";

/**
 * Model-name prefixes per device class, most-specific first — `WXA`/`WXC` (streaming
 * amplifiers) must win over `WX` (wireless speakers). Sources: Yamaha product lines —
 * AV receivers RX-V/RX-A/TSR/HTR/RX-S plus AV pre/power amps CX-A/MX-A; stereo network
 * receivers/amps R-N/WXA/WXC; soundbars YSP/YAS/ATS/SRT/SR-B/SR-C; wireless speakers
 * WX/NX/ISX/MusicCast xx; CD systems/players CRX/MCR/CD-N.
 */
const TYPE_PREFIXES: ReadonlyArray<readonly [DeviceType, readonly string[]]> = [
  // NP- network players, TT-N network turntables, XDA- streaming amplifiers and the WXAD streaming
  // adapter: stereo network devices, none of them an AV receiver (audit 2026-09-24, D13). This list is
  // checked before the speakers', so WXAD never reads as a WX speaker.
  ["stereoReceiver", ["R-N", "RN-", "WXA", "WXC", "A-S", "R-S", "NP-", "TT-N", "XDA-", "WXAD"]],
  ["soundbar", ["YSP", "YAS", "ATS", "SRT", "SR-B", "SR-C", "MUSICCAST BAR"]],
  ["cdSystem", ["CRX", "MCR", "CD-N", "CD-NT"]],
  ["speaker", ["WX", "NX-", "ISX", "MUSICCAST 20", "MUSICCAST 50", "MUSICCAST 500"]],
  ["avReceiver", ["RX-V", "RX-A", "RX-S", "TSR", "HTR", "CX-A", "MX-A", "RX-D"]],
];

/**
 * Detect the device class from a reported model name.
 *
 * @param model the reported model name (e.g. "RX-V6A", "YSP-1600", "MusicCast 20")
 * @returns the device class; an empty/unknown model yields the AV-receiver default
 */
export function detectDeviceType(model: string | undefined): DeviceType {
  // Some firmware spells the dash as an underscore ("RX_V781").
  const normalized = (model ?? "").trim().toUpperCase().replace(/_/g, "-");
  if (normalized.length > 0) {
    for (const [type, prefixes] of TYPE_PREFIXES) {
      if (prefixes.some(prefix => normalized.startsWith(prefix))) {
        return type;
      }
    }
  }
  return "avReceiver";
}

/**
 * Encode an SVG source as the data URL an object's `common.icon` carries.
 *
 * @param svg the SVG markup
 * @returns the base64 data URL
 */
function svgUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * The root every pictogram shares, drawn for the 28 px the object tree renders it at. The
 * admin inlines a `data:image/svg+xml` value into the row (adapter-react-v5 `Icon.tsx`), so
 * `currentColor` inherits the row's text colour — the same file is dark on the light themes
 * and light on the dark ones; a fixed colour was invisible in one family. The row's CSS zeroes
 * the width of `rect`, `image` and `use` inside inlined markup (`cellId: '& *': width: initial`),
 * so bodies are ROUNDED-RECTANGLE PATHS, and only `path` and `circle` are used.
 *
 * @param strokeWidth the stroke width for the 64-unit viewBox
 * @param body the SVG elements inside the root
 * @returns the SVG markup
 */
function pictogram(strokeWidth: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

/**
 * A rounded rectangle as a path (see {@link pictogram} for why not `<rect>`).
 *
 * @param x left edge
 * @param y top edge
 * @param w width
 * @param h height
 * @param r corner radius
 * @returns the path element
 */
function roundedBox(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `<path d="M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}` +
    `h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z"/>`
  );
}

/** One minimal silhouette per device class (original artwork, 64x64 viewBox, approved 2026-09-15). */
export const DEVICE_TYPE_ICONS: Readonly<Record<DeviceType, string>> = {
  // Wide box, display window left, one big volume knob right, two feet.
  avReceiver: svgUrl(
    pictogram(
      4,
      `${roundedBox(4, 18, 56, 28, 5)}${roundedBox(12, 27, 18, 8, 2)}<circle cx="46" cy="32" r="7"/><path d="M14 46v6M50 46v6"/>`,
    ),
  ),
  // Wide box with a tuning scale line and two equal knobs.
  stereoReceiver: svgUrl(
    pictogram(
      4,
      `${roundedBox(4, 18, 56, 28, 5)}<path d="M12 26h40"/><circle cx="21" cy="37" r="5"/><circle cx="43" cy="37" r="5"/><path d="M14 46v6M50 46v6"/>`,
    ),
  ),
  // Upright cabinet: small tweeter above a large woofer.
  speaker: svgUrl(
    pictogram(4, `${roundedBox(17, 6, 30, 52, 5)}<circle cx="32" cy="19" r="4"/><circle cx="32" cy="40" r="9"/>`),
  ),
  // Flat long bar with a row of grille dots.
  soundbar: svgUrl(
    pictogram(
      4,
      `${roundedBox(4, 24, 56, 16, 8)}<path d="M17 32h.01M27 32h.01M37 32h.01M47 32h.01" stroke-width="5"/>`,
    ),
  ),
  // Box with a disc (ring + hub) and the tray slit.
  cdSystem: svgUrl(
    pictogram(
      4,
      `${roundedBox(4, 14, 56, 36, 5)}<circle cx="32" cy="32" r="10"/><circle cx="32" cy="32" r="2.5"/><path d="M11 44h8"/>`,
    ),
  ),
};

/** The volume indicator on the device card: a speaker with a percent sign, or the speaker alone. */
const VOLUME_INDICATOR_ICONS: Readonly<Record<"percent" | "device", string>> = {
  percent: svgUrl(
    pictogram(
      5,
      `<path d="M6 24h9l11-9v34l-11-9H6z"/><circle cx="41" cy="20" r="6"/><circle cx="55" cy="44" r="6"/><path d="M57 12L39 52"/>`,
    ),
  ),
  device: svgUrl(
    pictogram(
      5,
      `<path d="M12 24h9l11-9v34l-11-9h-9z"/><path d="M41 23a13 13 0 0 1 0 18"/><path d="M49 15a24 24 0 0 1 0 34"/>`,
    ),
  ),
};

/**
 * The glyph of the card's volume indicator. The device manager renders a data URL inline with
 * the indicator's colour (`react-inlinesvg`, `style={{ color }}`), so the same `currentColor`
 * rule as for the object-tree pictograms applies.
 *
 * @param percent whether the device's volume datapoints carry 0–100 %
 * @returns the data URL — speaker with a percent sign, or the speaker alone
 */
export function volumeIndicatorIcon(percent: boolean): string {
  return VOLUME_INDICATOR_ICONS[percent ? "percent" : "device"];
}

/**
 * The icon data URL for a reported model name — the one-call form the adapter uses.
 *
 * @param model the reported model name
 * @returns the data URL of the matching device-class silhouette
 */
export function iconForModel(model: string | undefined): string {
  return DEVICE_TYPE_ICONS[detectDeviceType(model)];
}

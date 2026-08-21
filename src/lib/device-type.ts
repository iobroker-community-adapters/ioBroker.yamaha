/**
 * Device-type detection from the model name the device itself reports (YNCA MODELNAME,
 * YXC/XML model), mapped to one of five simple silhouette icons. Yamaha's model prefixes
 * identify the product line reliably across generations; an unrecognized or empty model
 * falls back to the AV-receiver silhouette (the by-far most common device class).
 *
 * The icons are original minimal silhouettes (no Yamaha trademarks), inlined as data
 * URLs so they render everywhere an object icon is shown (admin tree, device cards,
 * visualizations) without serving files.
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
  ["stereoReceiver", ["R-N", "RN-", "WXA", "WXC", "A-S", "R-S"]],
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
  const normalized = (model ?? "").trim().toUpperCase();
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

/** Shared stroke styling: a mid grey that stays readable on light and dark admin themes. */
const S = 'fill="none" stroke="#8a8f98" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

/** One minimal silhouette per device class (original artwork, 24x24 viewBox). */
export const DEVICE_TYPE_ICONS: Readonly<Record<DeviceType, string>> = {
  // Wide box, display slit left, one big volume knob right.
  avReceiver: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}>` +
      `<rect x="2" y="7" width="20" height="10" rx="1.5"/>` +
      `<rect x="5" y="10" width="7" height="2.4"/>` +
      `<circle cx="17.5" cy="12" r="2.4"/>` +
      `<path d="M5 17v2M19 17v2"/></g></svg>`,
  ),
  // Box with two large knobs and a tuning scale line.
  stereoReceiver: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}>` +
      `<rect x="2" y="7" width="20" height="10" rx="1.5"/>` +
      `<path d="M5 10h14"/>` +
      `<circle cx="8" cy="13.5" r="1.8"/>` +
      `<circle cx="16" cy="13.5" r="1.8"/>` +
      `<path d="M5 17v2M19 17v2"/></g></svg>`,
  ),
  // Upright cabinet: small tweeter above a large woofer.
  speaker: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}>` +
      `<rect x="7" y="3" width="10" height="18" rx="1.5"/>` +
      `<circle cx="12" cy="8" r="1.3"/>` +
      `<circle cx="12" cy="15" r="3"/></g></svg>`,
  ),
  // Flat long bar with a speaker-grille dot row.
  soundbar: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}>` +
      `<rect x="2" y="10" width="20" height="5" rx="2.5"/>` +
      `<path d="M6 12.5h.01M9.5 12.5h.01M13 12.5h.01M16.5 12.5h.01" stroke-width="2"/></g></svg>`,
  ),
  // Box with a disc (ring + hub) and the tray slit.
  cdSystem: svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${S}>` +
      `<rect x="2" y="6" width="20" height="12" rx="1.5"/>` +
      `<circle cx="12" cy="12" r="3.2"/>` +
      `<circle cx="12" cy="12" r="0.8"/>` +
      `<path d="M5 15.5h4"/></g></svg>`,
  ),
};

/**
 * The icon data URL for a reported model name — the one-call form the adapter uses.
 *
 * @param model the reported model name
 * @returns the data URL of the matching device-class silhouette
 */
export function iconForModel(model: string | undefined): string {
  return DEVICE_TYPE_ICONS[detectDeviceType(model)];
}

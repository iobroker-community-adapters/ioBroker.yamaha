/** The transports the adapter speaks. Ordered most-modern-first — the default ownership rank. */
export type Transport = "yxc" | "ynca" | "xml";

/**
 * Ownership preference by modernity, used when a shared capability is equally good on each
 * transport (krobi: "wenn mehrere Protokolle dasselbe können, das modernste nutzen"). YXC is
 * push + structured JSON, YNCA the text-poll base, XML the pre-2010 fallback.
 */
const MODERNITY: readonly Transport[] = ["yxc", "ynca", "xml"];

/**
 * Per-capability ownership preference that OVERRIDES pure modernity — from the capability
 * census (`Ressourcen/yamaha/capability-census-2026-08-11.md` §3). These are the shared keys
 * where YXC is present but NOT equivalent: wrong scale, read-only, or a poorer type. Each list
 * is the preferred owner order for that key; the first present transport wins.
 */
const OWNER_OVERRIDES: Record<string, readonly Transport[]> = {
  // §3a scale conflict — YXC volume is the raw 0..161 device scale, YNCA/XML are dB. Keep dB.
  volume: ["ynca", "xml", "yxc"],
  // §3c write loss — YXC is read-only for these, YNCA (and often XML) is writable.
  maxVolume: ["ynca", "xml", "yxc"],
  extraBass: ["ynca", "xml", "yxc"],
  adaptiveDrc: ["ynca", "xml", "yxc"],
  surroundDecoder: ["ynca", "yxc"],
  "media.playback": ["ynca", "yxc"],
  "media.repeat": ["ynca", "yxc"],
  "media.shuffle": ["ynca", "yxc"],
  // §3d richness loss — YNCA carries an enum dropdown that YXC/XML flatten to a free string.
  input: ["ynca", "yxc", "xml"],
  soundProgram: ["ynca", "yxc", "xml"],
  sleep: ["ynca", "xml", "yxc"],
  "tuner.band": ["ynca", "yxc"],
};

/**
 * Decide which transport owns a capability, given the transports that actually offer it on
 * this device. Default is the most modern; a census-driven override wins where the modern
 * transport would be lossy. An override that lists none of the present candidates falls back
 * to modernity, so any non-empty candidate set resolves.
 *
 * @param key the transport-neutral capability key (the unified state id)
 * @param candidates the present transports that offer this key (non-empty)
 * @returns the owning transport
 */
export function pickOwner(key: string, candidates: readonly Transport[]): Transport {
  const preference = OWNER_OVERRIDES[key] ?? MODERNITY;
  const owner = preference.find(t => candidates.includes(t)) ?? MODERNITY.find(t => candidates.includes(t));
  return owner ?? candidates[0];
}

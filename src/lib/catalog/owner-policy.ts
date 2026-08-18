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
  "advanced.maxVolume": ["ynca", "xml", "yxc"],
  "sound.extraBass": ["ynca", "xml", "yxc"],
  "sound.adaptiveDrc": ["ynca", "xml", "yxc"],
  "sound.surroundDecoder": ["ynca", "yxc"],
  "sound.dialogueLift": ["xml", "yxc"],
  // §3d richness loss — YNCA carries an enum dropdown that YXC/XML flatten to a free string.
  input: ["ynca", "yxc", "xml"],
  soundProgram: ["ynca", "yxc", "xml"],
  sleep: ["ynca", "xml", "yxc"],
  "tuner.band": ["ynca", "yxc"],
};

/**
 * Per-transport state-id → canonical capability key, for the ids that drift between transports
 * (census §3f, verified against the catalogs). The canonical key is the census left column; the
 * transports not listed already use the canonical id. Zone prefixes are stripped separately.
 */
const ID_DRIFT: Partial<Record<Transport, Readonly<Record<string, string>>>> = {
  yxc: { subwooferVolume: "sound.subwooferTrim", "multiroom.partyEnable": "multiroom.party" },
  xml: { hdmiOut1: "hdmi.out1", hdmiOut2: "hdmi.out2" },
};

/**
 * The transport-neutral capability key for a transport's state id: strip a `zone2/3/4.` prefix
 * to the per-zone template, then resolve any id drift to the canonical key. Two transports that
 * express the same capability under different ids therefore map to the same key.
 *
 * @param transport the transport the state id comes from
 * @param stateId the transport's own state id (may carry a zone prefix)
 * @returns the canonical capability key
 */
export function capabilityKeyOf(transport: Transport, stateId: string): string {
  const template = stateId.replace(/^(?:multiroom\.)?zone[234]\./, "");
  return ID_DRIFT[transport]?.[template] ?? template;
}

/**
 * The drift-resolved, transport-neutral OBJECT id — like {@link capabilityKeyOf} but KEEPS the
 * zone prefix. capabilityKeyOf drops the zone to decide ownership per template; canonicalIdOf
 * keeps it to place the per-zone node in the unified tree. Two transports' zoned ids for the
 * same capability therefore collapse to one node id.
 *
 * @param transport the transport the state id comes from
 * @param stateId the transport's own state id
 * @returns the canonical object id (zone prefix kept, drift resolved)
 */
export function canonicalIdOf(transport: Transport, stateId: string): string {
  const zone = /^(?:multiroom\.)?zone[234]\./.exec(stateId)?.[0] ?? "";
  const template = stateId.slice(zone.length);
  const resolved = ID_DRIFT[transport]?.[template] ?? template;
  if (zone && !zone.startsWith("multiroom.")) {
    return `multiroom.${zone}${resolved}`;
  }
  return zone + resolved;
}

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

/**
 * Build the owner map for a device: given which capability keys each present transport offers,
 * resolve every key to exactly one owning transport (via {@link pickOwner}). This is the
 * dedup decision behind the unified object tree — each state is written by one transport only.
 *
 * @param offered the capability keys each present transport offers (absent transport = none)
 * @returns a map from capability key to its owning transport
 */
export function resolveOwnership(offered: Partial<Record<Transport, readonly string[]>>): Map<string, Transport> {
  const candidates = new Map<string, Transport[]>();
  // Iterate in modernity order so the candidate lists are deterministic.
  for (const transport of MODERNITY) {
    for (const key of offered[transport] ?? []) {
      const list = candidates.get(key);
      if (list) {
        list.push(transport);
      } else {
        candidates.set(key, [transport]);
      }
    }
  }
  const owners = new Map<string, Transport>();
  for (const [key, cands] of candidates) {
    owners.set(key, pickOwner(key, cands));
  }
  return owners;
}

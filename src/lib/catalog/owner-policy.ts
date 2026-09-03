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
  // §3c write loss on the unified player block (v2.0.0): YXC reads playback/repeat/
  // shuffle but cannot WRITE them (its API has only toggle/transport endpoints, which
  // stay YXC-owned buttons); YNCA sets all three directly. Zone mirrors collapse to
  // the same template, so this covers multiroom.zoneN.player.* too.
  "player.playback": ["ynca", "yxc"],
  "player.repeat": ["ynca", "yxc"],
  "player.shuffle": ["ynca", "yxc"],
  "sound.extraBass": ["ynca", "xml", "yxc"],
  "sound.adaptiveDrc": ["ynca", "xml", "yxc"],
  "sound.surroundDecoder": ["ynca", "yxc"],
  "sound.dialogueLift": ["xml", "yxc"],
  // Write-proof beats modernity rank for the scene TRIGGER (#615): YXC declares the
  // recall endpoint per zone (device-verified), XML declares the write value in its
  // Scene_Sel_Item list — but YNCA's claim rests on the scene NAMES being readable,
  // and the 2012 generation (RX-V473/V475) answers the YNCA scene put with
  // @RESTRICTED (ynca-python PRACTICALITIES). The proven writers go first.
  "scene.recall": ["yxc", "xml", "ynca"],
  // The scene LIST is presentation: number + title per slot. MusicCast knows the slot
  // COUNT but no titles; XML declares the titles per zone, YNCA the main zone's names.
  // By modernity MusicCast would own it and — connecting in seconds while the YNCA
  // names ride a 19 s sweep — publish a title-less list on the first contact that then
  // stands until the next restart. The title sources come first; a MusicCast-only
  // device still owns its list alone.
  "scene.list": ["xml", "ynca", "yxc"],
  // §3d richness loss — YNCA carries an enum dropdown that YXC/XML flatten to a free string.
  input: ["ynca", "yxc", "xml"],
  soundProgram: ["ynca", "yxc", "xml"],
  sleep: ["ynca", "xml", "yxc"],
  "tuner.band": ["ynca", "yxc"],
};

/**
 * A zoned state id's folder prefix. All three transports place their zones under
 * `multiroom.zoneN.` (`yxc/zones.ts` `zonePrefix`, the YNCA catalog's zone table, the XML zone
 * table) — the bare `zoneN.` form of the pre-v0.18.1 tree cannot be produced any more and is
 * therefore NOT matched here. It still lives on in `pure-helpers.renamedObjectIds`, which has to
 * recognise it to clean an upgraded instance's old tree; that is the one place it belongs.
 */
export const ZONE_PREFIX = /^multiroom\.zone[234]\./;

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
  const template = stateId.replace(ZONE_PREFIX, "");
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
  const zone = ZONE_PREFIX.exec(stateId)?.[0] ?? "";
  const template = stateId.slice(zone.length);
  return zone + (ID_DRIFT[transport]?.[template] ?? template);
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
  // The MODERNITY fallback is defence for a FUTURE override: every entry in the
  // current table lists at least two transports, so an override can never miss all
  // present candidates while more than one is present — today it is unobservable.
  const owner = preference.find(t => candidates.includes(t)) ?? MODERNITY.find(t => candidates.includes(t));
  return owner ?? candidates[0];
}

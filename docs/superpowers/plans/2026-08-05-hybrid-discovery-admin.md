# Hybride Geräteerkennung + Admin-Aufwertung — Implementierungsplan

> Umsetzung inline (superpowers:executing-plans), test-first, häufige Commits.
> Spec: `docs/superpowers/specs/2026-08-05-hybrid-discovery-admin-design.md`.

**Ziel:** Auto-Discovery bei leerer Geräte-Tabelle, manuelle Tabelle bleibt für
gezielte Kontrolle; Admin-UI auf Fleet-Standard; XML-Abfrage-Intervall nur sichtbar,
wenn ein XML-Gerät verbunden ist.

**Architektur:** Die Tabelle ist der Schalter (leer→auto, gefüllt→manuell). Der
Standby-Merker liegt als Datei im Instanz-Datenverzeichnis (kein Restart).
`native.hasXmlDevice` steuert das bedingte Admin-Feld (einmaliger Restart wie die
bestehende Alt-Geräte-Übernahme). Das XML-Intervall kommt aus der Config.

## Global Constraints (aus der Spec + Workspace)

- i18n Pattern B (flach `admin/i18n/<lang>.json`), **alle 11 Sprachen** (en/de/ru/pt/nl/fr/it/es/pl/uk/zh-cn).
- `onUnload` synchron; Timer via `this.setTimeout`/`this.setInterval`.
- Gates grün: `npm run build` · `check` · `lint` (0 Warnungen) · `npx vitest run` · `check-state-roles.mjs` · `test:integration`.
- Kein Suchknopf mehr (der `discover`-`onMessage`-Handler entfällt); `discoverYamaha`/`ssdpSearch` bleiben.
- Keine externe Runtime-Dependency (nur `@iobroker/adapter-core`).

## Tasks (test-first, je Task ein Commit)

### Task 1 — pure-helpers: Auto/Manuell + Discovered-Merge
- Files: `src/lib/pure-helpers.ts` (+ `pure-helpers.test.ts`)
- Produces:
  - `deviceSource(configDevices: unknown): "auto" | "manual"` — leere/keine Tabelle → `"auto"`, sonst `"manual"`.
  - `mergeDiscovered(known: DeviceRecord[], found: DeviceRecord[]): DeviceRecord[]` — dedup nach `ip`; bereits bekannte bleiben erhalten (Standby-Schutz), neue werden ergänzt; Namen aus `found` aktualisieren bekannte nicht (User-Sicht: stabil).
- Tests: leere Tabelle→auto · gefüllte→manual · Merge dedupt nach IP · known ohne found-Treffer bleibt · found ergänzt.

### Task 2 — discovered-store: Datei-Persistenz im dataDir
- Files: `src/lib/discovered-store.ts` (+ Test)
- Produces: `readDiscovered(deps)`, `writeDiscovered(deps, devices)` — JSON-Datei, injectable `readFile`/`writeFile`.
- Tests: fehlende Datei→`[]` · korruptes JSON→`[]` · write→read Roundtrip.

### Task 3 — xml-controller: Poll-Intervall aus Config
- Files: `src/lib/xml/device-controller.ts` (+ Test)
- Change: feste `KEEPALIVE_MS` → Konstruktor-/Deps-Parameter `pollIntervalMs` (Default 60000).
- Test: der Controller plant seinen Keepalive mit dem übergebenen Intervall.

### Task 4 — main.ts: Auto/Manuell-Verdrahtung + Merker
- Files: `src/main.ts`
- `onMessage(discover)`-Handler entfernen.
- `onReady`: `deviceSource(config.devices)` → bei `"auto"`: `discoverYamaha` beim Start, `mergeDiscovered` mit der Merker-Datei, Datei schreiben, diese Geräte fahren; bei `"manual"`: die konfigurierten Geräte (wie bisher). Auto-Geräte fließen in `cleanupStaleObjects` als bekannte ein (kein Löschen offline).
- `hasXmlDevice`: wenn ein Gerät auf den XML-Transport verbindet und `native.hasXmlDevice` noch nicht `true` ist → einmal via `extendForeignObject` setzen.
- `config.xmlPollInterval` (Default 60) an den XML-Controller durchreichen (über `attemptDevice`-Deps).
- Verify: `test:integration` (Boot) grün.

### Task 5 — admin/jsonConfig.json: neue Struktur
- Single-`panel`; Header `header_devices` (size 4); `_intro` staticText (Auto/Manuell + XML-Hinweis); `devices`-Tabelle (Name+IP, `uniqueColumns:["ip"]`); `xmlPollInterval` (number, min 30, max 300, default 60, `hidden:"!data.hasXmlDevice"`, `tooltip:"tooltip_xmlPollInterval"`); Header `supportHeader` (size 5, newLine); `_aboutInfo`; `_kofiLink`/`_paypalLink` (staticLink, button, outlined, primary). **Kein** `_discover`-Button.

### Task 6 — io-package.json native + i18n + README
- `io-package.json` `native`: `xmlPollInterval: 60`, `hasXmlDevice: false`.
- `admin/i18n/<lang>.json` (11 Sprachen): `header_devices`, `introText` (überarbeitet: Auto/Manuell + XML-manuell), `columnName`/`columnIp`/`devicesTable` (bestehende behalten), `label_xmlPollInterval`, `tooltip_xmlPollInterval` (**warum** das Feld da ist + Standard 60 s), `supportHeader`, `aboutInfo`, `donateKofi`, `donatePaypal`. Entfernte Keys (`discoverBtn`) raus.
- `README.md`: Abschnitt „Configuration" erklärt Hybrid (leer=auto / eintragen=nur diese), XML manuell, XML-Intervall (nur bei XML-Geräten, Standard 60 s).

### Task 7 — Voll-Gate + Konsistenz
- `build` · `check` · `lint` · `vitest` · `check-state-roles.mjs` · `test:integration` grün.
- i18n-Coverage: jeder jsonConfig-Key in allen 11 Sprachen (der pre-release-Self-Audit prüft das).

## Self-Review-Notiz
Spec-Abdeckung: Verhalten (T1/T4) · Standby-Datei (T2/T4) · XML-Intervall (T3/T5) ·
Admin-Struktur (T5) · native/i18n/README (T6) · Gates (T7). `hasXmlDevice` (native,
Restart) vs. Discovered (Datei, kein Restart) sind bewusst getrennt.

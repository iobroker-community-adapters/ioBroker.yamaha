# Hybride Geräteerkennung + Admin-Aufwertung — Design

Datum: 2026-08-05

## Ziel

Geräte müssen nicht mehr zwingend manuell angelegt werden (Auto-Discovery als
Standard), die manuelle Option bleibt für gezielte Kontrolle. Die Admin-UI wird
auf den Fleet-Standard (Single-Panel + Header-Sektionen + Support) gehoben.

## Geräteerkennung — die Tabelle ist der Schalter

- **Tabelle leer → Auto-Modus:** Beim Adapter-Start läuft eine Netzwerksuche
  (SSDP); alle gefundenen MusicCast/YNCA-Geräte werden in Betrieb genommen. Der
  Nutzer trägt nichts ein.
- **Tabelle gefüllt → Manuell-Modus:** Nur genau die eingetragenen Geräte werden
  genutzt, keine automatische Suche.
- **Such-Rhythmus:** nur beim Start (kein periodisches Suchen — krobi-Entscheid).
- **Standby-Schutz:** einmal automatisch gefundene Geräte werden in einer
  Merker-Datei im Instanz-Datenverzeichnis persistiert (Muster wie der
  govee-SKU-Cache — **kein** Instanz-Restart, anders als ein `native`-Schreib),
  damit das Start-Aufräumen ihre Objekte nicht löscht, wenn ein Gerät beim Start
  offline (tiefer Standby ohne Netzwerk) ist; der Supervisor reconnectet es.
- **XML-Altgeräte (vor ~2010):** sprechen kein SSDP → werden von der Suche nie
  gefunden, immer manuell mit IP einzutragen.

## Admin-UI (Vorbild parcelapp / homewizard)

- `type: "panel"` (Single-Page), Header-Sektionen: **Geräte** · **Support**.
- **Suchknopf entfällt** — durch den Auto-Modus redundant; damit entfällt auch
  der `discover`-`onMessage`-Handler in `main.ts`. Die Suchlogik (`discovery.ts`,
  `ssdpSearch`) bleibt, sie treibt nun den Auto-Start.
- **Intro-Text** über der Tabelle: erklärt Auto (leere Tabelle) vs. Manuell
  (Geräte eintragen) **und** den Hinweis, dass alte XML-Receiver manuell mit IP
  einzutragen sind.
- **Geräte-Tabelle** (Name + IP, `uniqueColumns: ["ip"]`) bleibt.
- **XML-Abfrage-Intervall** (`xmlPollInterval`, number, 30–300 s, Standard 60):
  - `hidden: "!data.hasXmlDevice"` — nur sichtbar, wenn ein XML-Gerät da ist.
  - Der Adapter setzt `native.hasXmlDevice = true`, sobald ein Gerät auf den
    XML-Transport fällt (einmaliger Instanz-Restart, dasselbe Muster wie die
    bestehende Alt-Geräte-Übernahme `migrateLegacyDevice`).
  - Hilfetext (Tooltip) erklärt: **warum** das Feld erscheint (ein Gerät ist über
    das alte XML-Protokoll verbunden, das abgefragt statt gepusht wird) **und**
    den Standard (60 s, für einen AV-Receiver ausreichend).
- **Support-Sektion:** Ko-fi + PayPal als `staticLink`-Buttons (Fleet-Standard).

## README

Ein Abschnitt erklärt in Nutzer-Sprache: Tabelle leer = automatische Suche beim
Start; Geräte eintragen = nur diese; alte XML-Receiver manuell mit IP; das
XML-Abfrage-Intervall (erscheint nur bei XML-Geräten, Standard 60 s).

## i18n

Pattern B (flach, `admin/i18n/<lang>.json` — der bevorzugte, adapter-core-konforme
Standard). Alle neuen Texte (Header, Intro, Tabellen-Spalten, XML-Intervall-Label +
Tooltip, Support, Donation-Links) in allen 11 Sprachen.

## Code-Änderungen

- `main.ts`: `onMessage(discover)` raus; `onReady` erhält die Auto/Manuell-Logik
  (leere Tabelle → `discoverYamaha` beim Start → Supervisoren) inkl.
  Merge mit der Standby-Merker-Datei (dataDir); `native.hasXmlDevice` setzen, wenn
  ein Gerät auf XML verbindet; XML-Poll-Intervall aus `config.xmlPollInterval`
  durchreichen.
- `xml/device-controller.ts`: `KEEPALIVE_MS` aus der Config statt fester Konstante
  (Default 60 000 ms bleibt).
- `admin/jsonConfig.json`: neue Struktur (s. o.).
- `io-package.json`: `native` um `xmlPollInterval` + `hasXmlDevice` (die
  Discovered-Liste liegt als Datei im Instanz-Datenverzeichnis, nicht in `native`).
- `README.md` + `admin/i18n/*`.

## Tests

- `pure-helpers`: Auto/Manuell-Entscheidung (leere vs. gefüllte Tabelle),
  `discovered`-Merge (Dedup nach IP, Standby-Erhalt).
- XML-Controller: Intervall aus Config wird verwendet.
- Boot-Integrationstest bleibt grün.

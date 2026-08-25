# CLAUDE.md — ioBroker.yamaha

Adapter-spezifischer Kontext. Globale Dev-Standards: `../CLAUDE.md` + `../CLAUDE_*.md`.
Recherche + Konzept + Plan: `../../Ressourcen/yamaha/` · Projekt-Memory: `project_yamaha_greenfield`.

## Projekt

Greenfield-Neubau in TypeScript, der die zwei funktional toten Adapter **yamaha** (soef, alte
XML-API) und **musiccast** (foxthefox, MusicCast/YXC) durch **einen** lebenden Adapter ersetzt.
Echte Übernahme des community-`iobroker.yamaha` (durchgehende npm-Linie seit 2015) — Copyright-Kette
soef + community + krobi bleibt erhalten (`reference_copyright_credits_rewrite`).

Leitziel: max. Geräte-Kompatibilität (jedes netzwerkfähige Yamaha ab ~2010) **und** max.
Funktionalität (voller MusicCast-Reichtum). Vorbild-Adapter (Multi-Transport): `govee-smart`.

## Die 3-Protokoll-Landschaft (Kern)

- **YNCA** (Text `@SUBUNIT:FUNC=VAL`, TCP :50000) — Steuer-Basis aller Netz-AVRs 2010–2020. In Node
  **keine reife Lib** → **TS-Eigenbau**, Python-`ynca` als Protokoll-Spec. Nur **1** Verbindung/Gerät.
- **YXC / MusicCast** (JSON-HTTP + UDP-Push :41100) — MusicCast-Geräteklasse + Reichtum
  (Medien/Tuner/CD/Multiroom), via `yamaha-yxc-nodejs`. Re-Subscribe-Keepalive Pflicht (der musiccast-Bug).
- **XML/YNC** (`<YAMAHA_AV>`, HTTP :80) — Steuer-API der Geräte vor ~2010; **dritter, gleichberechtigter
  Transport** (Fallback, wenn weder YNCA noch YXC antworten).
- YNCA + YXC laufen auf einem MusicCast-AVR **parallel** (kein Konflikt) — pro Gerät/Fähigkeit geroutet.

## Architektur (Ist-Stand, Multi-Transport pro Gerät)

Pro konfiguriertem Gerät ein `DeviceSupervisor` (`lib/lifecycle/`), der EINEN `ConnectionHandle` online hält —
nach dem Multi-Transport-Neubau ist das ein `MultiTransportHandle`, der ALLE antwortenden Transporte auf EINEM
Objektbaum vereint (keine „erster gewinnt"-Kaskade mehr). `lib/attempt-device.ts` (`connectTransports`) baut
jeden der drei Transporte über eine **Factory** hinter einem `lib/lifecycle/transport-connection-adapter.ts`,
verbindet alle drei **parallel** (`Promise.all` — ein YNCA-Timeout verzögert YXC/XML nicht mehr) und übergibt
die lebende Menge + die Factories dem Handle. Die drei Controller (`lib/device-controller.ts` = YNCA,
`lib/yxc/device-controller.ts`, `lib/xml/device-controller.ts`) bleiben UNVERÄNDERT hinter dem Adapter — er
fängt ihre `upsertObject`/`setStateAck`-deps ab, kanonisiert die IDs und filtert jeden Transport auf die ihm
zugeteilten Datenpunkte. Owner je Datenpunkt = das modernste ANWESENDE, aber verlustfreie Protokoll
(`lib/catalog/owner-policy.ts`: Rang YXC > YNCA > XML, überstimmt vom reicheren/schreibbaren/korrekt-skalierten
Transport laut Zensus); `lib/catalog/object-tree-coordinator.ts` berechnet daraus EINEN Baum, jeder State genau
einmal, jeder Write an den Owner. **Reconnect ist zweistufig:** Der Ausfall EINES Transports schließt nur ihn —
das Handle baut ihn über seine Factory mit eigenem Backoff neu auf und re-koordiniert danach den Baum
(idempotente Upserts, Ownership neu), während die anderen Transporte durchlaufen. Erst wenn der LETZTE lebende
Transport wegfällt, meldet das Handle den Drop an den Supervisor, der die ganze Menge neu verbindet. YXC/XML
melden Drop nach mehreren erfolglosen Keepalive-Polls, YNCA über das echte Socket-Drop-Event (Drops vor der
Handler-Registrierung werden gelatcht — im Client wie im Handle).

**YNCA-Init ist ein 2-Pass-Sweep** (`device-controller.ts` `sweepDevice`): erst eine `AVAIL=?`-Probe je
Katalog-Subunit (~2 s; SYS antwortet nie auf AVAIL und wird immer gesweept), dann der gezielte Sweep nur über
die anwesenden Subunits — statt ~39 s Blind-Sweep. Antwortet KEIN Subunit auf AVAIL, fällt er auf den vollen
Blind-Sweep zurück (kein Feature-Verlust bei unbekannter Firmware; an allen 10 Fixtures verifiziert: jedes
Func-Subunit antwortet auch auf AVAIL). Das Probe-Ergebnis wird pro Gerät gecacht (`lib/ynca/subunit-cache.ts`,
in-memory über Reconnects + persistiert im **Device-Objekt** `native.yncaAvail` — nicht im Instanz-Objekt, das
würde restarten), Schlüssel = model+firmware; bei Abweichung wird neu geprobt. Die Admin-Gruppenschalter
filtern die Katalog-Entries VOR dem Sweep (`isEntryEnabled` → `isGroupEnabled`): eine abgeschaltete Gruppe wird
gar nicht mehr abgefragt.

Datenpunkte: ein gemeinsamer Katalog je Transport (`ynca/catalog.ts`, `yxc/catalog.ts`, `xml/catalog.ts`) liefert
Objekt-`common` UND Wert-Mapping aus EINER Liste; die `common` werden über `catalog/value-coerce.ts` intelligent
typisiert (onoff→boolean, enum→Dropdown, number→unit/range). **Numerische YNCA-Schreibwerte tragen ein
PFLICHT-Zahlenformat** (`NumberSpec.decimals` + Step-Raster in `encode`, Referenz ynca-python
`number_to_string_with_stepsize`): ohne Dezimalpunkt liest die Receiver-Firmware die Ziffern als Zehntel —
`VOL=-38` kam als −3,8 dB an (Issue #612; MAXVOL hat den 16.5-Sonderfall per `wireEncode`, FMFREQ ist MHz mit
zwei Nachkommastellen). **Preset-/Favoriten-Oberfläche (#613, Parität zum alten musiccast-Adapter):** YNCA
`TUN.PRESET` lesbar+schreibbar (Sentinel „No Preset"→0 via `wireDecode`) + Up/Down-Buttons, DAB-/FM-Presets
schreibbar, Quellen-Abruf `player.<src>.preset` nur auf den Preset-fähigen Subunits (`PRESET_SUBUNITS`, Spec
ynca-python-Mixins; write-only, PLAYBACKINFO-gegated). YXC: Favoriten-/Zuletzt-Listen als JSON-States +
Abruf-Nummern, Tuner-Presets je Band (`getFeatures tuner.preset.type` common/separate steuert Abruf-Band),
Geräte-eigene Wertelisten aus `getFeatures` werden Dropdowns (`YxcZone.valueLists`), Wecker-Block `clock.*`
read-only (der Alt-Adapter hatte auch keinen funktionierenden Schreibweg) mit eigener Admin-Gruppe
`group_clock`. Die YXC-DAB-Felder speisen die YNCA-DAB-IDs (`DAB_FIELDS`, eine Quelle für Anlage+Parse);
Owner-Override `tuner.dab.preset`→YNCA (dort schreibbar, bei YXC nur Anzeige). Der Objektbaum ist thematisch gruppiert
(`catalog/groups.ts`, `groupOf(id)` bucketet nach zonenbereinigtem erstem Kanal-Segment, HDMI-Routing/Lippensynchron
gewinnt dabei explizit VOR dem Zonen-Präfix): die Wiedergabe-Quellen unter `player.*`, DAB unter `tuner.dab`,
Multiroom statt `dist`. **Der `multiroom`-Ordner trägt den Geltungsbereich selbst** (v1.0.0-Schnitt): direkt im
Ordner nur Gerät-weites mit „(all zones)"-Namen (masterPower/party/partyMute), die MusicCast-Link-States im
Unterordner `multiroom.group` (role/id/name/serverZone/linkedDevices/linkDevice/leave/streamingEnabled —
`streamingEnabled` = „Zone DARF streamen", live belegt true ohne Gruppe), Zonen als `multiroom.zoneN`-Unterordner.
Die zwei gerätweiten YXC-Katalog-Einträge (`multiroom.partyEnable`/`multiroom.group.streamingEnabled` aus dem
Zonen-Status) werden von Objekt-Mapper UND Status-Parser NUR für die Main-Zone emittiert — sonst entstehen
`multiroom.zoneN.multiroom.*`-Duplikate (der v1.0.0-Bugfund). Sieben Datenpunktgruppen
(Wiedergabe/Tuner/Multiroom/HDMI/Szenen/Klang/Erweitert) sind
im Admin per `group_*`-Schalter abschaltbar — Zone 2/3/4, Zone B und masterPower gehören zur Multiroom-Gruppe — `isGroupEnabled` gated `upsertObject`+`setStateAck`,
`cleanupStaleObjects` räumt eine abgeschaltete Gruppe weg (beszel-Muster); der Verstärker-Kern (Power/Volume/Mute/
Input/Sound-Programm/Sleep/Info) ist immer an, ohne eigenen Schalter (wie beszels `info.online`/`.status`). Alt-IDs
aus der Vor-Gruppierung (`pure-helpers.ts` `RENAMED_CHANNELS`/`renamedObjectIds`) werden beim Update weggeräumt.
**Geräte-Typ-Icons:** `lib/device-type.ts` erkennt die Geräteklasse am gemeldeten Modellnamen
(Präfix-Matrix AV-Receiver/Stereo/Speaker/Soundbar/CD, unbekannt→AV-Receiver) und liefert eigene
Inline-SVG-Silhouetten (KEINE Yamaha-Marke); gesetzt am Device-Objekt über den zentralen
`setStateAck`-Hook in `main.ts` (jeder `info.model`-Write, Änderungs-Cache) und auf der
Geräte-Karte (`device-management.ts` liest das Modell in `loadDevices`). `ensureDeviceHeader`
sät die Standard-Silhouette schon beim Anlegen — aber nur wenn noch KEINE gesetzt ist, sonst
fiele eine Soundbar bei jedem Start bis zum ersten Modell-Report auf den Receiver zurück.
**Anzeigename am Device-Objekt** (`updateDeviceLabel` + `pure-helpers.nextDeviceLabel`): der
Migrationspfad taufte das Gerät auf seine IP (der Alt-Adapter kannte nichts anderes), und aus
dem Namen entsteht die Objekt-ID — die bleibt für immer, sonst löscht `staleObjects` den ganzen
Baum samt Historie/VIS-Bindungen. Deshalb wird NUR `common.name` nachgezogen: MusicCast-Zonenname
(`yxc/device-controller.zoneNameFrom` aus `system/getNameText`, generische Zonennamen gefiltert)
schlägt Modell. Überschrieben wird ausschließlich der eigene Platzhalter (= die ID) oder der zuletzt
selbst geschriebene Name — ein User-Name bleibt, deshalb dort bewusst OHNE `preserve`, die
Vorbedingung prüft `nextDeviceLabel`. Die Geräte-Karte titelt nach dem Objektnamen, nicht nach dem
Tabelleneintrag (der bleibt unangetastet, er bildet die ID). Das Adapter-Logo
`admin/yamaha.svg` behält das etablierte Kreis-Stimmgabel-Motiv (krobi-Entscheidung — Ersatzmotiv
abgelehnt) mit THEME-FESTEN Farben: dunkle Striche als Basis, helle via Medien-Abfrage im SVG —
nie `currentColor` (rendert als `<img>` schwarz, unsichtbar im Dunkel-Modus; der Alt-Fehler).
YXC-HTTP über den eigenen `yxc/http-client.ts`
(keine externe Lib; die Command-URLs sind unit-verifiziert). **Jede YXC-Anfrage trägt die Kopfzeilen
`X-AppName`/`X-AppPort` (`YXC_SUBSCRIPTION_HEADERS`) — DAS ist die UDP-Push-Anmeldung; ohne sie sendet kein
Gerät je ein Event** (beim Lib-Ersatz v0.9.0 verloren gegangen, per Referenz-Test gegen einen echten
HTTP-Server abgesichert). Der 5-Minuten-Keepalive-Poll erneuert die Anmeldung. YXC-Schreibbefehle laufen
direkt über `write.apply`-Funktionen im Katalog (kein Methodennamen-Switch mehr; nur Equalizer/Tuner-Frequenz
bleiben deklarativ, weil sie Controller-Zustand brauchen). YXC-Push: ein geteilter UDP-Empfänger
(`yxc/push-receiver.ts`) auf :41100, per Quell-IP geroutet. Discovery: SSDP-M-SEARCH + HTTP-`fetch` in `main.ts`
(adapter-Timer, sonst S5005), reine Logik in `lib/discovery.ts`.

## Stand

Alle sieben Aufbauphasen abgeschlossen, danach der Multi-Transport-Neubau (alle antwortenden Protokolle
parallel auf einem Objektbaum statt „erster Transport gewinnt"), der thematisch gruppierte Objektbaum mit
abschaltbaren Datenpunktgruppen und die Wiedergabe als Media-Player (Alexa/Google/VIS). Der Adapter ist
funktional vollständig (3 Protokolle, Discovery, Migration, Härtung). Versionshistorie im README
`## Changelog` (nicht hier dupliziert).

## Portierungs-Referenz (`../../Ressourcen/yamaha/legacy/`, NICHT im Adapter-Repo)

Alt-Code der Übernahme als Portierungs-Quelle — 2026-08-01 aus dem publizierten Adapter ausgelagert
(erzeugte sonst repochecker-Findings: fehlende Abhängigkeiten, altes `utils.adapter`-Muster, native Timer);
per git-Historie + dort weiter abrufbar:

- `main.js` — XML-Befehle (via `yamaha-nodejs-soef`) + YNCA-Echtzeit-Events (via `y5`).
- `discover.js` — SSDP-Discovery (Quelle Phase 6).
- `soef.js` / `tools.js` — Alt-Helfer.

## Community-Status (seit 2026-08-18 — ÜBERNOMMEN)

Der Adapter lebt im Community-Repo `iobroker-community-adapters/ioBroker.yamaha` (krobi = Maintainer,
push/triage — Repo-Einstellungen/About nur via mcm/Org). **Community-Standard gilt:** Release-Branch
**`master`** (Arbeit auf `developing`, die CI prüft seit 2026-08-23 BEIDE Zweige — vorher fiel ein nur
unter Windows roter Test erst am Release-Tag auf und verbrannte v1.1.0; `deploy` hängt am Tag, aus
einem Push auf `developing` wird nie ein Release), Changelog-Bullets mit `(krobipd)`-Präfix, Community-CI (KEINE Fleet-Härtungen
repochecker-version-gate/workflow-lint; Bots `automerge-iobroker-bot`/`auto-merge.yml`/dependabot in
Community-Form), Asset-URLs auf `iobroker-community-adapters/…@master`. Das Fleet-Tooling erkennt das
automatisch an `package.json repository.url` (`scripts/_community.py`). Der alte krobipd-Fork ist
archiviert; Historie beider Linien steckt via ours-Merge im master.

**v1.0.0 = Übernahme-Release** mit `common.messages`-Update-Warndialog (oldVersion<1.0.0, warn,
agree/cancel): Komplett-Neubau, Objektbaum neu, Alt-Datenpunkte werden entfernt, IP wird übernommen.
Der Upgrade-Pfad vom Ur-Adapter 0.5.4 ist test-bewiesen (`pure-helpers.test.ts` „upgrade path"):
`migrateLegacyDevice` (config.ip/IP, Hostname ok, `:port`-Suffix wird gestrippt) + `cleanupStaleObjects`
räumt den KOMPLETTEN Alt-Baum (47 Instanz-Objekte + dynamische `Realtime.*`/`SystemConfig.*`/`inputEnum`).

## Design-Entscheidungen (belegt, nicht wieder aufmachen)

- **Objektbaum = sauberer Neuschnitt** (Greenfield), yamaha-Nutzer per one-shot-Migration; musiccast-Nutzer
  nicht migrierbar (fremder Namensraum) → freiwilliger Umstieg + Doku.
- **Manifest bleibt auf der released Version** — den Bump macht `npm run release`.
- **Kein Sentry** bis eigenes Projekt (der geerbte community-DSN wurde entfernt).

## Tests

- vitest, `src/**/*.test.ts` — Unit + Boot-Integrationstest (startet den Adapter real).
- **HW-freies Testen:** `ynca`-Python bringt debug-server + echte Geräte-Logs → YNCA-Client dagegen testbar.

## Befehle

- `npm run build` · `npm test` · `npm run lint` · `npm run check` · `npm run release`.

## Versionshistorie

Changelog im README (`## Changelog`) + `CHANGELOG_OLD.md` + `io-package.json` `news`, nicht hier dupliziert.
Die Vorgänger-Historie (soef 2015 → Community-Wartung bis 0.5.4) bleibt erhalten — s. README `## History`.

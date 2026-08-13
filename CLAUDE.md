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
jeden der drei Transporte hinter einem `lib/lifecycle/transport-connection-adapter.ts`, verbindet jeden, der
antwortet, und übergibt die lebende Menge dem Handle. Die drei Controller (`lib/device-controller.ts` = YNCA,
`lib/yxc/device-controller.ts`, `lib/xml/device-controller.ts`) bleiben UNVERÄNDERT hinter dem Adapter — er
fängt ihre `upsertObject`/`setStateAck`-deps ab, kanonisiert die IDs und filtert jeden Transport auf die ihm
zugeteilten Datenpunkte. Owner je Datenpunkt = das modernste ANWESENDE, aber verlustfreie Protokoll
(`lib/catalog/owner-policy.ts`: Rang YXC > YNCA > XML, überstimmt vom reicheren/schreibbaren/korrekt-skalierten
Transport laut Zensus); `lib/catalog/object-tree-coordinator.ts` berechnet daraus EINEN Baum, jeder State genau
einmal, jeder Write an den Owner. Reconnect liegt im Supervisor (ein Drop meldet aktuell die ganze Menge,
per-Transport ist die nächste Verfeinerung); YXC/XML melden Drop nach mehreren erfolglosen Keepalive-Polls,
YNCA über das echte Socket-Drop-Event (bis `onDrop` registriert ist, wird ein Drop gelatcht).

Datenpunkte: ein gemeinsamer Katalog je Transport (`ynca/catalog.ts`, `yxc/catalog.ts`, `xml/catalog.ts`) liefert
Objekt-`common` UND Wert-Mapping aus EINER Liste; die `common` werden über `catalog/value-coerce.ts` intelligent
typisiert (onoff→boolean, enum→Dropdown, number→unit/range). Der Objektbaum ist thematisch gruppiert
(`catalog/groups.ts`, `groupOf(id)` bucketet nach erstem Kanal-Segment): die Wiedergabe-Quellen unter `player.*`,
DAB unter `tuner.dab`, Multiroom statt `dist`. Sechs Datenpunktgruppen (Wiedergabe/Tuner/Zonen/Multiroom/HDMI/
Szenen) sind im Admin per `group_*`-Schalter abschaltbar — `isGroupEnabled` gated `upsertObject`+`setStateAck`,
`cleanupStaleObjects` räumt eine abgeschaltete Gruppe weg (beszel-Muster); der Verstärker-Kern ist immer an. Alt-IDs
aus der Vor-Gruppierung (`pure-helpers.ts` `RENAMED_CHANNELS`/`renamedObjectIds`) werden beim Update weggeräumt.
YXC-HTTP über den eigenen `yxc/http-client.ts`
(keine externe Lib; die Command-URLs sind unit-verifiziert). YXC-Push: ein geteilter UDP-Empfänger
(`yxc/push-receiver.ts`) auf :41100, per Quell-IP geroutet. Discovery: SSDP-M-SEARCH + HTTP-`fetch` in `main.ts`
(adapter-Timer, sonst S5005), reine Logik in `lib/discovery.ts`.

## Stand

Alle sieben Aufbauphasen abgeschlossen, danach der Multi-Transport-Neubau (alle antwortenden Protokolle
parallel auf einem Objektbaum statt „erster Transport gewinnt"), zuletzt (v0.15.0) der thematisch gruppierte
Objektbaum mit abschaltbaren Datenpunktgruppen und die Wiedergabe als Media-Player (Alexa/Google/VIS). Der
Adapter ist funktional vollständig (3 Protokolle, Discovery, Migration, Härtung). Versionshistorie im README
`## Changelog` (nicht hier dupliziert).

## Portierungs-Referenz (`../../Ressourcen/yamaha/legacy/`, NICHT im Adapter-Repo)

Alt-Code der Übernahme als Portierungs-Quelle — 2026-08-01 aus dem publizierten Adapter ausgelagert
(erzeugte sonst repochecker-Findings: fehlende Abhängigkeiten, altes `utils.adapter`-Muster, native Timer);
per git-Historie + dort weiter abrufbar:

- `main.js` — XML-Befehle (via `yamaha-nodejs-soef`) + YNCA-Echtzeit-Events (via `y5`).
- `discover.js` — SSDP-Discovery (Quelle Phase 6).
- `soef.js` / `tools.js` — Alt-Helfer.

## Design-Entscheidungen (belegt, nicht wieder aufmachen)

- **Objektbaum = sauberer Neuschnitt** (Greenfield), yamaha-Nutzer per one-shot-Migration; musiccast-Nutzer
  nicht migrierbar (fremder Namensraum) → freiwilliger Umstieg + Doku.
- **Manifest bleibt auf npm-latest-Version** (aktuell 0.5.4) bis zum Release — den Bump macht `npm run release`.
- **npm-Publish erst nach Übernahme-Freischaltung** durch die Community; Tag + GitHub-Release gehen davor.
- **Kein Sentry** bis eigenes Projekt (der geerbte community-DSN wurde entfernt).

## Tests

- vitest, `src/**/*.test.ts` — Unit + Boot-Integrationstest (startet den Adapter real).
- **HW-freies Testen:** `ynca`-Python bringt debug-server + echte Geräte-Logs → YNCA-Client dagegen testbar.

## Befehle

- `npm run build` · `npm test` · `npm run lint` · `npm run check` · `npm run release`.

## Versionshistorie

Changelog im README (`## Changelog`) + `CHANGELOG_OLD.md` + `io-package.json` `news`, nicht hier dupliziert.
Die Vorgänger-Historie (soef 2015 → Community-Wartung bis 0.5.4) bleibt erhalten — s. README `## History`.

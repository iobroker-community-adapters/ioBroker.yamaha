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

## Architektur (Ist-Stand, govee-Pattern-first)

Pro konfiguriertem Gerät ein `DeviceSupervisor` (`lib/lifecycle/`), der EINEN Transport-Controller online
hält — Reihenfolge YNCA > YXC > XML, direkt in `main.ts` (`attemptDevice`) verdrahtet (kein Router/Registry).
Die drei Controller (`lib/device-controller.ts` = YNCA, `lib/yxc/device-controller.ts`, `lib/xml/device-controller.ts`)
implementieren die gemeinsame `ConnectionHandle`-Form (`lib/controller.ts`), sodass der Supervisor alle gleich
behandelt: verbinden → Fähigkeiten → Objektbaum → seeden → bei Drop reconnecten → synchron schließen. Der
Reconnect-Automat liegt im Supervisor (eine Ebene über den Clients); YXC/XML melden einen Drop nach mehreren
erfolglosen Keepalive-Polls, YNCA über das echte Socket-Drop-Event.

Datenpunkte: ein gemeinsamer Katalog je Transport (`ynca/catalog.ts`, `yxc/catalog.ts`, `xml/catalog.ts`) liefert
Objekt-`common` UND Wert-Mapping aus EINER Liste; die `common` werden über `catalog/value-coerce.ts` intelligent
typisiert (onoff→boolean, enum→Dropdown, number→unit/range). YXC-HTTP über den eigenen `yxc/http-client.ts`
(keine externe Lib; die Command-URLs sind unit-verifiziert). YXC-Push: ein geteilter UDP-Empfänger
(`yxc/push-receiver.ts`) auf :41100, per Quell-IP geroutet. Discovery: SSDP-M-SEARCH + HTTP-`fetch` in `main.ts`
(adapter-Timer, sonst S5005), reine Logik in `lib/discovery.ts`.

## Stand

Alle sieben Aufbauphasen abgeschlossen; der Adapter ist funktional vollständig (3 Protokolle, Discovery,
Migration, Härtung). Versionshistorie im README `## Changelog` (nicht hier dupliziert).

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

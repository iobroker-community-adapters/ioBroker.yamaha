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
- **XML/YNC** (`<YAMAHA_AV>`, HTTP :80) — **tot**, nur Geräte vor ~2010 → optionaler Legacy-Zweig.
- YNCA + YXC laufen auf einem MusicCast-AVR **parallel** (kein Konflikt) — pro Gerät/Fähigkeit geroutet.

## Architektur (geplant, govee-Pattern-first)
`command-router` (`resolveTransport(dev,cmd)`) + `device-registry` (Fähigkeiten/Gerät) +
`capability-mapper` (einheitlicher State-Baum) + drei Transport-Clients mit gemeinsamer
`TransportClient`-Form. **Reconnect-Automat im Transport-Layer** = der Kern-Fix beider Alt-Adapter.

## Stand + Roadmap
- **Phase 0 (Gerüst) — DONE:** Fork krobipd/ioBroker.yamaha (Standard-Branch `main`), Fleet-Toolchain,
  minimales `src/main.ts` (bootet), Copyright-Kette, Changelog-Historie erhalten, CI grün.
- **Phase 1:** `main.ts`-Lifecycle + `command-router`/`device-registry` + `TransportClient`-Interface (test-first).
- **Phase 2:** YNCA-TS-Client (Encoder/Decoder, Subunit-Modell, Reconnect) — Tests gegen `ynca`-debug-Logs.
- **Phase 3:** YXC-Client um `yamaha-yxc-nodejs` + UDP-Push + Re-Subscribe.
- **Phase 4:** capability-mapper + einheitlicher Objektbaum + Routing end-to-end.
- **Phase 5:** XML-Legacy-Client (aus `legacy/`).
- **Phase 6:** Discovery (SSDP + manuell), Admin-UI, Migration yamaha→neu.
- **Phase 7:** Härtung, repochecker, Konsistenz-Audit, README/Wiki + Umstiegs-Doku musiccast→yamaha, Release.

## legacy/ — Referenzcode (NICHT gelintet/gebaut)
Alt-Code der Übernahme als Portierungs-Quelle, aus eslint + tsc + prettier ausgeschlossen:
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

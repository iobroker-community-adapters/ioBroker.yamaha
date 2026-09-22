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

## Befehls-Schleuse (`lib/lifecycle/command-gate.ts`) — JEDER Gerätebefehl geht hier durch

**Eine Schleuse pro Gerät UND Transport** (krobi 2026-08-26: „global im adapter verankert, wo jeder
befehl durch muss" — pro Geräteverbindung, weil der Takt eine Eigenschaft DER VERBINDUNG ist; eine
adapterweite Schleuse ließe den 19-s-Sweep von Receiver A den Tastendruck an Receiver B blockieren).
Erzeugt in `attempt-device.ts` (`gateFor`), durchgereicht an Client UND Controller. Eigenschaften:
**serialisiert** (ein Vorgang je Verbindung), **taktet** (`COMMAND_SPACING_MS`: YNCA 100 ms =
Yamaha-Spezifikation via ynca-python `protocol.py`; YXC/XML 0 ms, aber serialisiert — Embedded-Geräte
vertragen keine parallelen Anfragen), **Vorrang** (`"user"` überholt `"background"`, sonst wartet ein
Tastendruck hinter dem Sweep; Nutzerbefehle behalten untereinander ihre Reihenfolge), **Abbruch**
(`close()` leert die Warteschlange, bricht `signal` ab, `gate.delay()` löst sofort auf → EIN
Abschalt-Kennzeichen statt drei Eigenbauten; `gate.closed` gated jeden `emit()` der Controller).
YNCA schleust in `writeLine` (send=user, get=background), YXC/XML im Client-Konstruktor
(Schreibbefehle am Endpunkt-Verb erkannt: `set|recall|toggle|start|stop|manage|prepare`). Deshalb
brauchen die Browse-Treiber KEINE eigene Pause mehr. Vorbild: nut2 `nut-client.ts`-Warteschlange.

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
einmal, jeder Write an den Owner. **Wiederkehrende Antworten werden pro Gerät gemerkt** (`lib/lifecycle/probe-memory.ts`, gehalten in
`main.ts` neben dem Subunit-Cache, seit 2.0.0 PERSISTIERT im Geräteobjekt `native.probeCache` —
s. „Schnellstart" unten): YXC-`getFeatures`/Modell/Name
und die XML-Browse-Quellen-Probe sind über die Gerätelaufzeit konstant — ein Reconnect fragt sie nicht
erneut. Der YNCA-Subunit-Cache prüft die Identität jetzt ZUERST (2 Abrufe Modell+Firmware, ~0,2 s) und
sweept erst danach; vorher kostete ein veralteter Cache Sweep→Probe→Sweep (~40 s, langsamer als ohne
Cache). Die Ausfall-Erkennung der beiden Poll-Transporte liegt gemeinsam in
`lib/lifecycle/poll-drop-detector.ts`, die YXC-Zonen-Präfixe in `lib/yxc/zones.ts` (die frühere
Dreifach-Pflege hatte den Zonen-Equalizer-Cache gebrochen). `coordinate()` schreibt nur noch
GEÄNDERTE Objekt-Definitionen (Fingerabdruck je Id) — ein flackerndes Gerät schrieb sonst alle paar
Minuten ~250 unveränderte Objekte neu. **Reconnect ist zweistufig:** Der Ausfall EINES Transports schließt nur ihn —
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
`VOL=-38` kam als −3,8 dB an (Issue #612; MAXVOL hat den 16.5-Sonderfall per `wireEncode`, FMFREQ ist auf dem DRAHT MHz mit
zwei Nachkommastellen — der Datenpunkt `tuner.frequency` ist seit v2.0.0 einheitlich kHz). **Preset-/Favoriten-Oberfläche (#613, Parität zum alten musiccast-Adapter):** YNCA
`TUN.PRESET` lesbar+schreibbar (Sentinel „No Preset"→0 via `wireDecode`) + Up/Down-Buttons, DAB-/FM-Presets
schreibbar, Quellen-Abruf `player.<src>.preset` nur auf den Preset-fähigen Subunits (`PRESET_SUBUNITS`, Spec
ynca-python-Mixins; write-only, PLAYBACKINFO-gegated). YXC: Favoriten-/Zuletzt-Listen als JSON-States +
Abruf-Nummern, Tuner-Presets je Band (`getFeatures tuner.preset.type` common/separate steuert Abruf-Band),
Geräte-eigene Wertelisten aus `getFeatures` werden Dropdowns (`YxcZone.valueLists`), Wecker-Block `clock.*`
read-only (der Alt-Adapter hatte auch keinen funktionierenden Schreibweg) mit eigener Admin-Gruppe
`group_clock`. **Abruf-Zone (2026-08-26):** `recallPreset`/`recallRecentItem`/`recallTunerPreset` schalten die
ZIELZONE auf die Quelle — deshalb ging ein Favorit früher immer in die Hauptzone und riss sie von
ihrem Programm weg. Die Kommandos sind jetzt deklarativ (`netusbPreset`/`netusbRecent`/`tunerPreset`),
der Controller setzt die Zone über `zoneListeningTo(source)`: er merkt je Zone den Eingang (aus dem
Status) und die aktive Netzwerk-Quelle (`player.netPlayer.source`), Hauptzone gewinnt bei Gleichstand,
Rückfall main (= jedes Einzonen-Gerät). Der Client-Vertrag `yxc/client-contract.ts` ist seit demselben
Tag KEINE Hand-Kopie mehr, sondern aus der Klasse abgeleitet (`{ [K in keyof YamahaYxcClient]: … }` —
öffentliche Oberfläche, strukturell, damit Test-Doppelgänger sie ohne Vererbung erfüllen); der
Controller-Test nutzt einen aufzeichnenden Stellvertreter statt 51 handgeschriebener Methoden.
Die gemeinsame Browse-Verdrahtung (Objekte + Maschine + Treiber verbinden) liegt in
`browse/surface.ts` — vorher dreimal fast gleich in den Controllern. XML-Sonderzeichen laufen
über `xml/entities.ts` (dekodieren beim Lesen, escapen beim Schreiben — der Vorgänger bekam das
von seiner XML-Bibliothek geschenkt, unser Regex-Weg braucht es explizit; sonst erscheint ein
Ordner „Rock & Pop" verstümmelt und der Pfad-Datenpunkt findet ihn nie).
Die YXC-DAB-Felder speisen die geteilten `tuner.dab.*`-Detail-IDs (`DAB_FIELDS`, eine Quelle für
Anlage+Parse); preset/audioMode liegen seit v2.0.0 FLACH (Band-Parse), der frühere
Owner-Override `tuner.dab.preset` ist weg — `tuner.preset` ist auf beiden Transporten schreibbar.
**Menü-Browsing (#613, `lib/browse/`):** transport-neutrale `BrowseEngine` (besitzt die
`player.browse.*`-States: 8 Zeilen-Fenster mit 📁/♪-Präfix, selectLine=OK, page/back/home,
`path`-Auto-Lauf mit Seiten-Suche + Timeout, `rows`-JSON, busy) + drei Treiber:
YNCA `LISTINFO/LISTSEL/LISTPAGE/LISTCURSOR` (Quelle: offizielle Befehlsliste
`Ressourcen/yamaha/ynca-command-list-rx-v671.txt` — ynca-python implementiert die
List-Funktionen NICHT; Fenster kommt als Zeilen-Burst + Auto-Feedback über die stehende
Verbindung, Burst-Debounce im Treiber; open() schaltet den MAIN-Eingang um wie die
Fernbedienung), YXC `netusb/getListInfo+setListControl` (Pull, absoluter Index,
Attribut-Bitmaske b1=Select/b2=Play, Thumbnails), XML `List_Info/List_Control`
(Busy-Polling; Start-Probe NET_RADIO/SERVER/USB entscheidet die Quellen). Jeder fähige
Transport steuert IDENTISCHE `player.browse.*`-Objekte bei → Koordinator dedupt, Modernität
wählt den einen Owner, Schreibrouting läuft wie überall; Ordner-Präfix `player.` = der
gebündelte Admin-Schalter „Wiedergabe & Browsen" (`group_player`, krobi-Entscheidung
2026-08-25 — kein eigener Browse-Schalter). Engine/Treiber brauchen die `delay`-Dep der
Controller (adapter-Timer via `attempt-device`); fehlt sie (alte Tests), entsteht kein
Browse-Baum. Der Objektbaum ist thematisch gruppiert
(`catalog/groups.ts`, `groupOf(id)` bucketet nach dem ERSTEN Kanal-Segment — Zonen-States fallen damit
in die multiroom-Gruppe, test-verankert in groups.test.ts): die Wiedergabe-Quellen unter `player.*`, DAB unter `tuner.dab`,
Multiroom statt `dist`. **Der `multiroom`-Ordner trägt den Geltungsbereich selbst** (v1.0.0-Schnitt): direkt im
Ordner nur Gerät-weites mit „(all zones)"-Namen (masterPower/party/partyMute), die MusicCast-Link-States im
Unterordner `multiroom.group` (role/id/name/serverZone/linkedDevices/linkDevice/leave/streamingEnabled —
`streamingEnabled` = „Zone DARF streamen", live belegt true ohne Gruppe), Zonen als `multiroom.zoneN`-Unterordner.
Die zwei gerätweiten YXC-Katalog-Einträge (`multiroom.partyEnable`/`multiroom.group.streamingEnabled` aus dem
Zonen-Status) werden von Objekt-Mapper UND Status-Parser NUR für die Main-Zone emittiert — sonst entstehen
`multiroom.zoneN.multiroom.*`-Duplikate (der v1.0.0-Bugfund). Acht Datenpunktgruppen
(Wiedergabe/Tuner/Multiroom/HDMI/Szenen/Klang/Erweitert/Uhr) sind
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
**Seit 2.10.0** sind die Silhouetten Piktogramme nach Flotten-Rezept (`currentColor`, nur
path/circle), und `ensureDeviceHeader` HEILT ein Icon, das keines der fünf aktuellen ist, aus
dem im Profil gemerkten Modell — Details im Abschnitt „Audit 2026-09-15 (v2.10.0)".
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
abgelehnt) mit THEME-FESTEN Farben — nie `currentColor` (rendert als `<img>` schwarz, unsichtbar
im Dunkel-Modus; der Alt-Fehler). Bis 2.9.2 dunkle Striche plus helle via Medien-Abfrage im SVG;
**seit 2.10.0 EINE feste Farbe `#78869a`** ohne `<style>`, weil die Media-Query dem OS folgt, nicht
dem Admin-Theme (Abschnitt „Audit 2026-09-15").
YXC-HTTP über den eigenen `yxc/http-client.ts`
(keine externe Lib; die Command-URLs sind unit-verifiziert). **Jede YXC-Anfrage trägt die Kopfzeilen
`X-AppName`/`X-AppPort` (`YXC_SUBSCRIPTION_HEADERS`) — DAS ist die UDP-Push-Anmeldung; ohne sie sendet kein
Gerät je ein Event** (beim Lib-Ersatz v0.9.0 verloren gegangen, per Referenz-Test gegen einen echten
HTTP-Server abgesichert). Der 5-Minuten-Keepalive-Poll erneuert die Anmeldung. YXC-Schreibbefehle laufen
direkt über `write.apply`-Funktionen im Katalog (kein Methodennamen-Switch mehr; nur Equalizer/Tuner-Frequenz
bleiben deklarativ, weil sie Controller-Zustand brauchen). YXC-Push: ein geteilter UDP-Empfänger
(`yxc/push-receiver.ts`) auf :41100, per Quell-IP geroutet. Discovery: SSDP-M-SEARCH + HTTP-`fetch` in `main.ts`
(adapter-Timer, sonst S5005), reine Logik in `lib/discovery.ts`.

## Chroniken — verlegt nach `.claude/dev-history.md` (2026-09-21)

Die datierten Audit-, Umbau-, Plan- und Stand-Abschnitte stehen wörtlich in `.claude/dev-history.md`, Eintrag „2026-09-21 — Aus CLAUDE.md verlegt“ (lokal, gitignored). Dort liegen:

- Geräte-Wahrheit statt Alt-Adapter-Erbe (Umbau nach der RX-V6A-Komplett-Ernte 2026-09-01)
- Objektbaum 2.0.0 — „Läuft gerade" statt 16 Kopien (2026-09-01)
- In-Depth-Audit 2026-09-03 (v2.2.0) — Regeln, die im Code stehen müssen
- Voll-Audit 2026-09-06 — Regeln, die im Code stehen müssen
- Voll-Audit 2026-09-02 (v2.0.4) — Regeln, die im Code stehen müssen
- Aufräumen, Identität und Ruheform (Fehler-Audit 2026-09-02)
- Audit-Umsetzung 2026-09-12 (v2.9.0) — Regeln, die im Code stehen müssen
- Bugfix 2.9.1 — die Netzsuche abzuschalten ist KEIN Löschbefehl
- In-depth 2026-09-17 (v2.11.0) — Regeln, die im Code stehen müssen
- Audit 2026-09-15 (v2.10.0) — Regeln, die im Code stehen müssen
- Stand
- Die Bildschirm-Fernbedienung auf allen drei Protokollen (v2.4.0, #613)
- Fähigkeiten kommen vom Gerät (v2.6.0, Audit + Plan 2026-09-09)
- Phase 2 des Fähigkeits-Plans (v2.7.1): ein Profil, schnellerer Erst-Sweep, Baum folgt dem Gerät

## Identität, Löschen, Wiederfinden (developing nach 2.11.0, 2026-09-22)

**Ein Gerät ist seine Seriennummer, nicht sein Name und nicht seine Adresse.** `lib/device-identity.ts`:
`DeviceIdentity { serial?, mac? }`, `identityFrom` (hex, nie nur Nullen — die bereinigten Fixtures tragen
`00000000`/`RXV6A0000`, zwei solche Geräte sind NICHT eines), `sameDevice` (serial ODER mac gleich, beide
gesetzt), `mergeIdentity`. Drei Quellen liefern dieselbe Nummer (am RX-V6A gemessen): UPnP `<serialNumber>`

- UDN-MAC (die Suche, `discovery.ts` `parseYamahaDescription`), YXC `getDeviceInfo.system_id`/`device_id`
  (ProbeMemory `yxcDeviceIds`, NICHT Teil des Validierungs-Strings `yxcIdentity`), XML `System_ID` (schon in
  `xmlIdentity`); `DeviceProfileStore.identity()` leitet sie ab, `main.ts` `learnIdentity` schreibt sie an
  `deviceRecords`, `native.identity` und — bei gefundenen Geräten — in `discovered.json`. **Die Objekt-Id bleibt
  für immer** (`staleObjects` löscht jeden Baum, dessen Id wandert); die Identität ist der Abgleichsschlüssel
  DANEBEN. `mergeDiscovered` matcht zuerst nach Identität (Umbenennung + Umzug halten den Baum), dann nach Id.

**Drei Herkünfte** (`DeviceSource`): `manual` = getippt → Adresse gilt, volle Konsequenz, der Adapter folgt
nicht (eine `warn`-Zeile je neuer Adresse, `warnedElsewhere`); `migrated` = die Zeile der 0.5.4-Migration
(`isDottedQuad(name)` — nur `legacyDeviceRow` schreibt so) → folgt dem Gerät und schreibt die neue Adresse in
die Tabelle (`updateTableAddress`, Neustart); `discovered` → folgt. Unter `auto` zählt nur eine GETIPPTE Zeile
als „Liste gefüllt" (`searchesTheNetwork`), sonst wäre eine migrierte Anlage nie zu finden. **Eine Suche
läuft nie vor den Tabellenzeilen** (`autoDiscover` mit gefüllter Tabelle: Hintergrund) — ein Fund wird gegen
die LAUFENDE Menge gelesen, sonst würde ein umgezogenes Gerät als Fremder ein zweites Mal gestartet.
`absorbFinds` ist der EINE Merge-Pfad (Suche und NOTIFY): Fund an der eigenen Adresse einer Zeile lehrt ihr
die Identität; Fund mit der Identität einer migrierten Zeile woanders = Umzug; einer manuellen = Warnung;
**Waise gleichen Modells** (`orphanOfModel`): ein Fremder gehört zur einzigen migrierten Zeile ohne Identität,
die BEWIESEN offline ist (`failedOnce` — ein Versuch scheiterte, keiner gelang seither; „noch nicht
verbunden" ist nicht offline) und deren gemerktes Modell (`DeviceProfileStore.model()`) passt.

**Offline in Sekunden, nicht Minuten** (Server-Test 2026-09-22 10:41, stromloser RX-V6A stand 2 min später noch
„verbunden"): `info.connection` fällt erst mit dem LETZTEN Transport, und MusicCast urteilt nach drei
Fünf-Minuten-Polls — bis 15 min. Seit demselben Tag fragt `MultiTransportHandle.handleTransportDrop` beim ersten
Abriss die übrigen Transporte sofort (`TransportConnection.verifyAlive?()`, optional; YXC + XML: EINE Statusabfrage
der ersten Zone, Fehlschlag = `dropDetector.report()`, gleichzeitige Frager teilen eine Frage; YNCA urteilt selbst
über sein Keepalive) — ein stromloses Gerät ist damit ~95 s nach dem Stecker offline (YNCA 90 s + eine Abfrage),
und die schnelle Suche hängt sich dahinter. Nadeln Y30–Y32.

**Umgezogen oder aus:** Der Verlust EINES Transports (`setTransports` schrumpft) stellt die Suche mit kurzer
Drossel scharf (`REDISCOVER_QUICK_INTERVAL_MS` 20 s, danach die 5 Minuten) — vorher meldete das Handle „weg"
erst nach dem LETZTEN Transport (YXC: 15 min). Der passive Hörer `lib/ssdp-listener.ts` (Port 1900,
`reuseAddr`, Membership je Such-Interface, Muster fakeroku) hört `NOTIFY ssdp:alive`: bekannte Adresse →
nichts; unbekannte → höchstens einmal je Minute (`NOTIFY_PROBE_THROTTLE_MS`) `probeDescription` → derselbe
Merge-Pfad — scheitert der Abruf (Boot-Alive vor dem HTTP-Server), nach 5 s erneut (`NOTIFY_RETRY_MS`). **Der Umzug
wartet auf den laufenden Versuch der alten Adresse** (`awaitSettled`, wie das Löschen) — sonst schreiben zwei
Supervisoren dasselbe `info.*`. Code-Nachweis des IP-Pfads mit dem Advisor 2026-09-22 (kein Hardware-Test). Bind-Fehler = eine `warn`-Zeile, weiter mit periodischer Suche. Findet eine Suche ein offlines
Gerät nirgends, sagt EINE `debug`-Zeile je Ausfall „not found on the network — keeping its objects"
(`reportedMissing`), nichts ändert sich. **Läuft KEIN Gerät, sucht der Adapter alle 5 min weiter** (`scheduleIdleSearch`,
derselbe Timer wie die Wiedersuche) — sonst hinge ein später eingeschaltetes oder gerade wieder zugelassenes Gerät allein
am NOTIFY. **Log-Regel für Suchen:** was auf `info` angekündigt wird, meldet auf `info` sein Ergebnis — die Startsuche
schließt mit „network search finished — found N / no Yamaha device answered", eine vom Nutzer ausgelöste Suche
(`rediscoverNow`) sagt „searching the network for X" und „X: not on the network right now — admitted again …"; die
Hintergrund-Polls bleiben `debug`. **Ein Gerät, das aus ist, ist aus** (krobi 2026-09-22: kein Adapter der Flotte
meldet ein offlines Gerät im Log): „no reachable transport" ist seit demselben Tag `debug` statt `warn`, die
Dedup-Klasse `ReachabilityDedup` (warn einmal, dann debug) ist mit ihrer Nadel W8 (Welle 3 + Sammeltabelle)
entfernt — `info.connection` trägt den Zustand.

**Löschen ist endgültig** (`device-management.ts` `deleteDevice`): Bestätigung in der UI VOR dem Handler
(dm-utils `confirmation` am Deskriptor, Text nennt die Datenpunkte — `showConfirmation` im Handler wartete
ohne Timeout, und der Tabellen-Write des manuellen Zweigs startete die Instanz mitten im Handler neu: der
Balken), dann Ausschluss ZUERST (`excluded.json` `{id, ip, identity}` neben dem rollback-sicheren `string[]`
`ignored.json`; `isExcluded`: Id, Identität, oder Adresse NUR bei Eintrag ohne Identität), Fund-Speicher,
`removeDevice` (Stopp + Baum, beide Zweige; EINE `info`-Zeile „device deleted — removed N datapoint(s)", gezählt wie
die Bilanz: nur `state`-Objekte — krobi 2026-09-22 nach dem Server-Test), Antwort `{ delete }`, und der Tabellen-Write erst DANACH per
`setTimeout(0)`. `main.ts` `removed` hält ein in dieser Sitzung gelöschtes Gerät aus einer bereits laufenden
Suche heraus. Rückweg: „+ Hinzufügen" (hebt Id- und Adress-Ausschluss auf) oder die Instanz-Aktion
„Ausgeschlossene Geräte…" (`excludedDevices`, Häkchen → beide Listen bereinigt → `rediscoverNow(lifted)`
räumt `removed` und sucht sofort).

**Nicht blind probieren** (`attempt-device.ts`): innerhalb einer Serie fehlgeschlagener Versuche probieren die
Wiederholungen nur die Transporte, die die UPnP-Beschreibung belegt (`services` — YXC/XML; YNCA steht nie
drin und wird immer probiert); der ERSTE Versuch nach jedem Erfolg (Start, erster Reconnect nach Abriss) ist
voll (`failedInARow` in `startDevice`) — ein Firmware-Update, das MusicCast bringt, reißt die Verbindung und
wird genau dort gesehen. Ohne Beschreibung (getippt, migriert) immer alle drei.

**Der Start-Pfad konsultiert die Ausschlussliste ebenfalls** (`autoDiscover` filtert `known` durch `isExcluded`,
Nadel Y29): `writeDiscovered` schluckt Fehler, ein als ausgeschlossen vermerktes Gerät kann also noch im Fund-Speicher
stehen — ohne den Filter liefe es beim nächsten Start wieder, Löschen per Neustart rückgängig.

**Wiki-Stil (krobi 2026-09-22, govee als Maß):** Startseite = Begrüßung, Themen, Issue-Link — keine Protokoll-Tabelle
(die steht auf Protocols); im Fließtext keine Versions-Marker („seit 2.x", „(ab 2.12.0)") und keine Rückblicke („bis
2.11.0 …"), keine Zahlen ohne Nutzen (Anfragen/s, Datenpunkt-Zahl, „90 % der Skripte"), keine Port-/Hörer-Mechanik
(41100, 1900, `SSDP listener unavailable`). Das Wiki beschreibt den heutigen Stand; die Historie ist der Changelog.

Beleg: Chat-Analyse 2026-09-22 + drei Advisor-Runden + Server-Test, Mutationswelle 19 (Y1–Y39), Chronik in `.claude/dev-history.md`.

## Erreichbarkeit + Anspruch: zwei Regeln, die v1.5.0 eingezogen hat

**1) Kein Anspruch ohne Nachweis (#613).** Der YNCA-Browse-Treiber beanspruchte `player.browse.*`,
sobald das Gerät die Quellen-Subunits führte — ohne je zu prüfen, ob es die Listen-Befehle kann. Da
`owner-policy.ts` nach Modernität vergibt (yxc > ynca > xml), verdrängte dieser ungeprüfte Anspruch
den XML-Treiber, der seit jeher probt (`List_Info` → `<Menu_Status>`). Folge: Auf einem RX-V473
(2012, kein MusicCast) blieb das Menü leer, obwohl der alte Adapter es über XML konnte.
`probeBrowseSubunits` fragt jetzt je Kandidat `LISTINFO=?` und meldet nur die Subunits, die mit
Listen-Feldern antworten (`LIST_PROOF`). **Zwei Fallen, die im Code stehen müssen:** (a) Die beiden
Absagen `@UNDEFINED` und `@RESTRICTED` tragen KEINEN Subunit, sind also keiner Anfrage zuzuordnen —
es zählt allein das AUSBLEIBEN einer Antwort. (b) Im Bereitschaftszustand antworten Medien-Subunits
`@RESTRICTED`, was von „kann keine Listen" nicht zu unterscheiden ist → bei `MAIN:PWR != On` wird
NICHT geprobt, sonst verlöre ein schlafendes Gerät seine Menüs. Beleg für die Notwendigkeit:
Das RX-A810-Referenzprotokoll beantwortet `@SERVER:LISTINFO=?` mit `@UNDEFINED`, während NETRADIO/PC/USB
desselben Geräts ein volles Fenster liefern.

**2) Gemerktes darf keine Verbindung vortäuschen.** `yxc/device-controller.start()` holte die
Fähigkeiten über `ProbeMemory` (kein Netzabruf beim Neuverbinden), Modell/Name sind „best-effort",
`refreshZone` verschluckte jeden Fehler — am Ende `return true` ohne Bedingung. Ein Receiver, der im
laufenden Betrieb vom Strom ging, wurde deshalb weiter als `ready — MusicCast ✓` gemeldet, während
YNCA/XML ehrlich scheiterten (krobis RX-V6A, 2026-08-26, am Log mit gleicher Prozess-ID belegt).
Jetzt wird das Ergebnis von `refreshZone` ausgewertet: antwortet KEINE Zone, ist der Transport tot.
Der Zonen-Status ist die einzige Anfrage des Starts, die immer wirklich ans Gerät geht.

**Prüfstand dafür:** `Ressourcen/yamaha/test-harness/` fährt den echten YNCA-Treiber hardwarefrei
gegen einen Simulator, der aus den 16 aufgezeichneten Geräteprotokollen antwortet (drei Varianten:
wie aufgezeichnet / Gerät ein / Listen-Antworten eingepflanzt).

## Datenpunkt-Bilanz im Log (v1.5.0, beszel-Form)

EINE `info`-Zeile `Object tree updated: created N datapoint(s), removed M datapoint(s)`, still bei
0/0 — die drei früheren Lösch-Zeilen (vorherige Konfiguration / umbenannt / abgeschaltete Gruppe)
stehen jetzt auf `debug`. Zwei Eigenheiten gegenüber beszel: (a) Es wird ein Startschnappschuss
gebraucht (`snapshotExistingDatapoints`, VOR Aufräumen und Verbinden), weil `upsertObject` bei jedem
Anfassen `extendObject` fährt — sonst meldete jeder Neustart den ganzen Baum als neu. (b) Geräte
verbinden asynchron und parallel, deshalb ein 5-Sekunden-Nachlauf (`DATAPOINT_BALANCE_SETTLE_MS`)
statt einer Zeile je Gerät: EINE Umschaltung, EIN Ergebnis. Gezählt werden NUR `state`-Objekte,
nicht die Kanäle/Geräteknoten drumherum. Regel-Herkunft: Memory `feedback_datenpunkt_bilanz_im_log`.

## Namen sind Übersetzungsobjekte (2026-09-02, Gate-Pflicht)

`common.name` jedes States und Kanals ist ein Objekt über **elf Sprachen**, nie ein fester String
(Kernteam-Linie mcm1957, nut2 #15; ioBroker löst selbst in die Sprache des Lesers auf). Umgesetzt
in `lib/i18n.ts`: `tName(key, …args)` baut das Objekt aus **`admin/i18n/<lang>.json`** — denselben
Dateien, aus denen die Konfigurationsseite liest. **Der Schlüssel IST der englische Name**, deshalb
liest ein Schlüssel ohne Übersetzungseintrag trotzdem richtig, und der Typ `I18nKey` macht einen
Tippfehler zum Compile-Fehler.

- **Bewusst NICHT adapter-core `I18n`:** dessen `getTranslatedObject` **wirft**, solange `init()`
  nicht lief — damit hinge jeder Objektname an der Startreihenfolge, und die reinen Katalogmodule
  (samt ihrer Unit-Tests) zögen die ganze Adapter-Laufzeit mit herein. Der `I18n.init()`-Aufruf in
  `onReady` ist deshalb entfallen.
- **Zwei Wege, je nachdem WANN der Name gebraucht wird.** Die drei Protokoll-Kataloge sind
  Modul-Konstanten (vor jedem Adapterstart ausgewertet) → sie tragen den **Schlüssel** (`nameKey`
  auf `CatalogEntry`, `common.nameKey` bei XML/YXC, `CHANNEL_NAME_KEYS`), und die Objekt-Bauer
  (`catalogToObjects`, `xml/device-controller`, `yxc/object-mapper`) lösen ihn auf. Alles, was zur
  **Verbindungszeit** gebaut wird, umschließt sein Literal direkt mit `tName(...)`.
- **`io-package.json` instanceObjects** tragen das fertige Objekt; der zentrale
  `sync-iopackage-from-i18n.py` hält sie an `admin/i18n` (yamaha ist dort eingetragen).
- **Plain string bleibt, was vom GERÄT kommt:** die Id eines gefundenen Geräts, ein
  MusicCast-Wochentag-Weckkanal, der großgeschriebene Id-Rest eines nicht gelisteten Kanals. Da
  gibt es nichts zu übersetzen.
- **⚠️ Der Quelltext ist nur die halbe Miete — der Name muss auch BESTEHENDE Objekte erreichen**
  (live gemessen nach dem 2.1.0-Update, Gate/Lint/Tests/Mutation alle grün, im echten Baum trugen
  trotzdem NEUN Datenpunkte den alten festen Namen). Zwei Ursachen derselben Form: ein mit
  `setObjectNotExistsAsync` angelegtes Objekt wird nie wieder angefasst (der Geräte-Kopf —
  `info.model`/`info.firmware` kamen nur richtig heraus, weil ein Katalog-Eintrag sie überschreibt),
  und der js-controller lässt das `common` eines BESTEHENDEN `instanceObjects`-Objekts bei jedem
  Update in Ruhe (die eigenen `info.*` des Adapters). Beide werden seit 2.1.1 bei jedem Start per
  `extendObject` geschrieben (merged → Aufzeichnungs-Einstellungen des Nutzers überleben).
  **Prüfung dafür: `python3 Entwicklung/scripts/check-live-tree.py yamaha` nach dem Server-Update** —
  das ist die Hälfte, die kein statisches Gate sehen kann.

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
- **Sentry seit v1.5.0** auf krobis eigenem power-dreams-Projekt (de.sentry.io, EU) — dieselbe DSN wie die übrigen Adapter, NICHT der geerbte community-DSN (der wurde bei der Übernahme entfernt). Details: Memory `reference_sentry_integration`.

## Objekt-Inventar aus Fixtures (`npm run test:inventory`)

Der Nachweis, dass ein Update JEDEN Datenpunkt einer bestehenden Installation erreicht — ohne
Server, für alle Gerätetypen (Flottenstandard, `Entwicklung/CLAUDE_TEMPLATES.md`). Acht
Fixture-Geräte decken die fünf Geräteklassen aus `device-type.ts` UND alle Transport-Kombinationen
ab: MusicCast+YNCA (RX-A2070), alle drei auf EINEM Receiver (RX-V6A), YNCA allein (RX-V473, R-N500),
XML allein (RX-V3900, der 2008er Dialekt), MusicCast allein (WX-030, YSP-1600, CD-NT670D).
Die Antworten sind echte Geräteantworten aus den gebündelten
Mitschnitten, destilliert nach `test/fixtures/inventory/` — die XML-Hälfte ist von krobis eigener
Konfiguration bereinigt (Eingangsnamen auf Werkseinstellung, System-ID genullt), sie gehört nicht
in ein öffentliches Repo.

- **Der Adapter bekommt KEINE Test-Naht.** `XmlClient`/`YamahaYxcClient` nehmen zwar einen
  einspeisbaren Transport, aber `attempt-device.ts` baut sie mit den Vorgaben, und von der
  Konfiguration führt kein Weg dorthin. Statt einen zu legen, biegt `test/inventory-hook.cjs` die
  ZIELADRESSE außerhalb des Adapters um (`NODE_OPTIONS=--require`, Routing-Tabelle über die
  Umgebung). Unbekannte Geräteadressen werden abgewiesen: eine vergessene Route fällt auf, statt
  still ins echte Netz zu gehen.
- **Drei Fallen, alle am echten Fehlversuch belegt:** (a) `net.connect(options)` reicht Node's
  normalisiertes `[options, cb]`-Array als EIN Argument weiter und markiert es mit einem internen
  Symbol — ein neu gebautes Array wird mit `ERR_MISSING_ARGS` abgelehnt, es muss an Ort und Stelle
  geändert werden. (b) MusicCast adressiert per URL-Zeichenkette, XML per Options-Objekt; wer nur
  eine Form erkennt, bekommt einen halb verbundenen Baum. (c) Was der Haken nicht sicher als
  Geräteaufruf erkennt, geht UNVERÄNDERT durch — der Adapter spricht über dieselben APIs mit der
  Zustands-/Objektdatenbank, und ein „normalisierendes" Argument dort beendet die Instanz vor dem
  ersten Gerätekontakt.
- **Der Lautstärke-Schalter wird in BEIDEN Stellungen inventarisiert** (seit 2.8.0): der Lauf fährt
  die acht Fixtures ein zweites Mal mit `volumeAsPercent: true` am INSTANZ-Objekt — seit 2.9.0 ist das
  der Umstiegs-Weg, den ein Gerät ohne eigene Antwort einmal erbt, und der Lauf sichert seit demselben
  Release ausdrücklich, dass jedes Gerät ihn als EIGENE Antwort festgeschrieben hat. Er sichert, dass JEDER
  `volume`-Datenpunkt jedes Geräts und jeder Zone dann 0…100 %, Schritt 0,5, Rolle `level.volume` und
  die Prozent-Erklärung trägt — und dass die Prozent-Stellung GENAU dieselben Datenpunkte baut wie die
  Vorgabe-Stellung. Ohne den zweiten Vergleich ginge die erste Zusicherung leer durch, sobald eine
  Geräteklasse in der Prozent-Stellung gar kein `volume` mehr bauen würde. In der Vorgabe-Stellung
  sichert derselbe Lauf: kein Gerät trägt zwei Lautstärke-SKALEN über seine Zonen (Einheit + Schritt;
  die GRENZEN dürfen je Zone abweichen, der RX-V6A meldet main 0…97 und Zone 2 0…90,5), jede Grenze
  ist die DEKLARIERTE der Zone, und die drei mit 2.8.0 entfernten Ids stehen nirgends mehr im Baum.
- **Gewartet wird auf einen BAUM, nicht auf eine Zahl.** Der Gerätekopf (`info.*`) existiert lange
  vor der ersten Transportantwort, also sieht ein Baum aus lauter Köpfen „stabil" aus und das
  Inventar käme leer heraus. Erst wenn jedes Gerät mehr als seine Kopfobjekte trägt, wird auf Ruhe
  gewartet (Bilanz-Nachlauf 5 s). ⚠️ **Der ADAPTER-eigene Zweig `yamaha.0.info.*` liegt auf
  derselben Tiefe wie ein Gerätekopf** und muss am ERSTEN Segment ausgeschlossen werden — als Gerät
  mitgezählt erhöht er den Stand um eins: die Schleife steigt aus, während ein echtes Gerät noch
  fehlt, und die Zusicherung schlägt fehl, sobald alle da sind (`only 8 of 7 …`, Gate D06 rot beim
  2.5.1-Vorlauf; das Inventar selbst blieb heil, weil die Ruhe-Schleife danach den Baum fertig
  werden lässt).
- **⚠️ Auf einem GESÄTEN Baum log dieses Wartekriterium (2.5.2 repariert).** Die Aufstiegs-Suite legt
  das Vorgänger-Inventar vorab an — damit sind beide alten Bedingungen nach EINER Sekunde erfüllt:
  jedes Gerät trägt schon Datenpunkte, und `extendObject` auf ein vorhandenes Objekt ändert die
  Zeilenzahl nicht. Der Abzug entstand also, während die drei YNCA-Receiver noch sweepten; 75 von 174
  neuen Beschreibungen fehlten im Vergleich, und vorher verglich die Suite den Abzug schlicht mit sich
  selbst. Zwei Bedingungen schließen das: ein Gerät zählt erst als gebaut, wenn es **verbunden**
  meldet (`device-supervisor.ts` setzt das nach `attempt()`, und `multi-transport-handle.ts` schreibt
  die Objekte VOR `onTransports`; die Zustandsdatenbank startet leer, auch wenn die Objekte gesät
  sind), und die Ruhe-Schleife vergleicht den INHALT der verglichenen Felder statt der Zeilenzahl.
- **`npm run build` gehört von Hand davor** — der Lauf startet den Adapter aus `build/`.
- **Zwei Fehler fand schon der erste Lauf**, beide unsichtbar für Quelltext-Gate, Rollen-Gate und
  906 Tests, weil beide erst im GEBAUTEN Baum entstehen: (a) `player.browse` trug einen festen
  englischen Ordnernamen — Namens- und Erklärungstabelle sind unabhängig, `browse` stand nur in der
  zweiten; die Invariante „ein Ordner mit Erklärung hat einen übersetzten Namen" steht jetzt im
  Test. (b) Die Id-Drift `hdmiOut1` → `hdmi.out1` erzeugt einen Elternpfad, für den keine
  Eltern-Schleife zuständig ist (der XML-Katalogeintrag hat kein Segment) — der Datenpunkt stand
  ohne Elternobjekt im Baum (E3009). Geschlossen im **Baum-Koordinator**: er kennt als Einziger die
  kanonischen Ids, also gilt die Reparatur für jede künftige Drift.

## Tests

- **Zwei getrennte Läufe, und `npm test` fährt seit 2.2.0 BEIDE.** `test:ts` = vitest über
  `src/**/*.test.ts` + `test/standards/` (851 Tests) — darin ist auch `src/main.test.ts`, das den
  Adapter GEMOCKT hochfährt, nicht echt. Der echte Boot-Test ist `test/integration.js`
  (`@iobroker/testing` startet js-controller + Instanz, ~30 s) und hängt an `test:integration`;
  bis 2.1.1 lief er lokal nie mit, obwohl die CI ihn fährt (`testing-action-adapter` ruft
  `test:unit` UND `test:integration`). `passWithNoTests` ist raus — ein nicht mehr greifendes
  `include` muss rot melden, nicht grün.
- **Mutationstabellen** (`../../Ressourcen/iobroker-entwicklung/mutation-testing/`) — **ZWANZIG Dateien (seit
  Welle 19, 2026-09-22), und das Gate prüft ALLE.** ⚠️ Die fünf Wellen-Originale `mutations_yamaha.py` · `…2.py` · `…3.py` · `…4.py` ·
  `…5.py` (36/32/26/11/11 Nadeln) leben NEBEN der Sammeltabelle `mutations_yamaha_all.py`, die dieselben
  Regeln zusammenfasst — sie sind kein Altbestand. Wer nur die datierten Tabellen nachzieht, lässt fünf
  Nadeln ins Leere zeigen und merkt es erst, wenn D09 den Release stoppt (2026-09-07: R5, R7, V7, V8, X4 —
  in `_all.py` nachgezogen, in den Originalen vergessen). Die Äquivalenz-Vermerke (`EQUIVALENT`) gehören in
  JEDE Tabelle, die den Mutanten führt. Im Einzelnen: `mutations_yamaha_all.py`
  (116 Regelbrüche, Wellen 1–5 vom 22.08., Nadeln am 02.09. nachgezogen, vier tote entfernt) + `mutations_yamaha_2026-09-02.py`
  (24, Welle 6 = die Audit-Fixes; IDs Z1–Z24, W gehört Welle 5) + `mutations_yamaha_2026-09-03.py`
  (18, Welle 7 = die Fehlerbehebungen des Fehler-Audits, IDs Z1–Z18 in eigener Tabelle; 18/18 gefangen) +
  `mutations_yamaha_2026-09-03-w8.py` (Welle 8, IDs A1–A24; A7 am 03.09. neu verankert auf die Regel: `back` sendet
  immer das Protokoll-Wort) + `mutations_yamaha_2026-09-04-w9.py` (Welle 9 = die Bildschirm-Fernbedienung, IDs B1–B3;
  3/3 gefangen) + `mutations_yamaha_2026-09-06-w10.py` (Welle 10 = das Voll-Audit vom 06./07.09., IDs C1–C13;
  13/13 gefangen — darunter C10 der Override, den der eigene Katalog-Zuwachs aushebelte, und C12/C13 die
  beiden Funde des Objekt-Inventars) + `mutations_yamaha_2026-09-09-w11.py` (Welle 11 = Phase 1 des
  Fähigkeits-Plans, IDs D1–D24) + `mutations_yamaha_2026-09-09-w12.py` (Welle 12 = Phase 2, IDs P1–P14)
  - `mutations_yamaha_2026-09-11-w13.py` (Welle 13 = die Lautstärke auf
    der Geräteskala und der Prozent-Schalter, IDs Q1–Q22; im ersten Lauf 16/20, die vier Überlebenden waren
    echte Testlücken und sind geschlossen → 20/20, dann Q21/Q22 für die zwei Regeln nachgezogen, die der
    Inventar-Lauf beider Schalterstellungen noch aufdeckte → 22/22)
  - `mutations_yamaha_2026-09-12-w14.py` (Welle 14 = die Audit-Funde vom 12.09. und der Prozent-Schalter
    pro Gerät, IDs R1–R16; 16/16 gefangen — zwei Überlebende im ersten Lauf waren echte Testlücken und
    sind geschlossen: die Doppel-Id-Sperre der Kartenliste und „die eigene Antwort eines Geräts schlägt
    den geerbten Instanz-Schalter")
  - `mutations_yamaha_2026-09-12-w15.py` (Welle 15 = der Bugfix 2.9.1 „die Netzsuche abzuschalten ist
    kein Löschbefehl", IDs R17–R22; 6/6 gefangen im ersten Lauf)
  - `mutations_yamaha_2026-09-12-w16.py` (Welle 16 = 2.9.2: EINE Setz-Stelle für den Prozent-Schalter
    plus die Kachel-Anzeige, IDs R23–R24; 2/2 gefangen)
  - `mutations_yamaha_2026-09-15-w17.py` (Welle 17 = das Audit 2026-09-15 / 2.10.0, IDs W1–W37; 37/37
    gefangen — W4 fällt nur, weil die Test-Attrappe `setStateChangedAsync` WIRKLICH vergleicht, W36/W37
    halten die Icon-Heilung; vier Bestandsnadeln neu verankert: N7, V6, R23, Z3)
  - `mutations_yamaha_2026-09-17-w18.py` (Welle 18 = In-depth 2026-09-17 / 2.11.0, IDs X1–X24 in eigener
    Tabelle — das Präfix X ist dort NICHT das der Äquivalenz-Vermerke X2/X4 aus Welle 1; 24/24, zwei
    Überlebende des ersten Laufs waren toter Code und sind entfernt)
  - `mutations_yamaha_2026-09-22-w19.py` (Welle 19 = Identität/Löschen/Wiederfinden auf `developing`, IDs
    Y1–Y39 in eigener Tabelle; 39/39 gefangen — die zwei Überlebenden des ersten Laufs, Y24 „Zeile auf dem
    ersten Versuch ist nicht offline" und Y19 „XML belegt, MusicCast nicht", waren Testlücken und sind
    geschlossen). Läufer `mutation-test.py`. Nadeln sind
    exakte Quellzeilen — nach Prettier-Umbrüchen oder Refactorings ZUERST den Nadel-Vorab-Check (jede Nadel
    genau 1×), sonst misst der Lauf nichts. Zwei äquivalente Mutanten (X2, X4 — unerreichbare
    Invarianten-Wächter, im Quelltext begründet); die vier anderen vom 22.08. (M9, X1, Y1, Y13) waren toter
    bzw. doppelter Code und sind am 02.09. samt Zwillingen entfernt — ein Überlebender außerhalb X2/X4 ist eine Testlücke.
- **HW-freies Testen:** `ynca`-Python bringt debug-server + echte Geräte-Logs → YNCA-Client dagegen testbar.

## Befehle

- `npm run build` · `npm test` · `npm run lint` · `npm run check` · `npm run format:check` (muss 0 melden) · `npm run release`.

## Doku-Flächen (seit 2026-09-11)

Drei Flächen, jede Aussage lebt an genau EINER Stelle:

| Fläche                                     | Rolle                                                                                                                     | Gate                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `README.md`                                | Schaufenster: was ist das, Voraussetzungen, Konfiguration in Kurzform, Wiki-Tabelle                                       | Konsistenz-Audit (Pflicht-Abschnitte + Reihenfolge), Prüfbot E6006 |
| `docs/en/README.md` · `docs/de/README.md`  | der Kurzweg, den ioBroker über `common.docs` ausliefert und der Admin anzeigt — kanonisch für Einrichtung und Fehlersuche | `audit_common_docs`, Konsistenz-Stufe 2                            |
| Wiki (`Entwicklung/iobroker.yamaha.wiki/`) | die Tiefe: Umstieg, Protokolle, Datenpunkte, Geräte, Fehlersuche — 14 Inhaltsseiten = 7 Paare EN+DE, handgeschrieben      | **KEINS**                                                          |

⚠️ **Das Wiki sieht kein Gate.** Es ist ein eigenes git-Repo (`…/ioBroker.yamaha.wiki.git`), der
Release-Commit fasst es nicht an, und es gibt hier keinen Generator, der die Drift auffinge. Nach
jedem Release, das Datenpunkte, Verhalten oder die Admin-Oberfläche ändert, gehören die betroffenen
Wiki-Seiten von Hand nachgezogen — besonders `Datapoints`/`Datenpunkte` und `Upgrade`/`Umstieg`.
Das Wiki trägt bewusst KEIN Einrichtungs-Kapitel; das steht in `docs/` und stünde sonst doppelt.

## Versionshistorie

Changelog im README (`## Changelog`) + `CHANGELOG_OLD.md` + `io-package.json` `news`, nicht hier dupliziert.
Die Vorgänger-Historie (soef 2015 → Community-Wartung bis 0.5.4) bleibt erhalten — s. README `## History`.

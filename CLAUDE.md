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
`main.ts` neben Subunit-Cache und Reachability-Dedup, seit 2.0.0 PERSISTIERT im Geräteobjekt `native.probeCache` —
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

## Geräte-Wahrheit statt Alt-Adapter-Erbe (Umbau nach der RX-V6A-Komplett-Ernte 2026-09-01)

Auslöser #615 (scene.recall tot auf RX-V473) + krobis Ansage „der Adapter ist eine
Neuentwicklung": Die blind vom Alt-Adapter portierten XML-Wege sind ersetzt, jede
Antwort des Geräts wird gelesen. Belege: `Ressourcen/yamaha/device-captures/rx-v6a-2026-09-01/`
(README + AUSWERTUNG), Memory `reference_yamaha_rx_v6a_ernte_funde`.

- **XML liest jetzt jede Antwort** (`xml-client.ts`): HTTP-Status ≠2xx und `RC≠0`
  werfen (`assertXmlOk`) — eine Geräte-Ablehnung landet als Warnung im Log statt im
  Nichts. `getXml` bleibt roh (die Treiber parsen selbst), `send`/`getStatus` prüfen.
- **YNCA-Schreib-Ablehnungen werden geloggt** (`ynca-client.ts` `onRefusal`):
  `@RESTRICTED`/`@UNDEFINED` ≤2 s nach einem User-PUT (Gate serialisiert) wird dem
  Befehl zugeordnet → `device refused "@MAIN:SCENE=Scene 1" (@RESTRICTED)`. Sweep-GETs
  werden nie beschuldigt. (YXC hatte den Ablehnungs-Check schon: `assertOk`.)
- **Szenen sind geräte-deklariert, drei Wege** (#615): XML fragt je Zone
  `Scene_Sel_Item` (deklariert Existenz+Titel+Schreibwert) und schreibt das dort
  deklarierte **`Scene_Sel`** — `Scene_Load` (Alt-Adapter-Erbe, nie belegt) ist weg;
  openHAB nutzt auf der klassischen Generation ebenfalls Scene_Sel. YXC:
  `recallScene` je Zone (Endpunkt+Parameter am RX-V6A verifiziert; scene_num aus
  getFeatures = max). YNCA bleibt letzter Weg (`@MAIN:SCENE=Scene N`, auf der
  2012er-Generation `@RESTRICTED` — ynca-python PRACTICALITIES).
  Owner-Override `scene.recall: yxc > xml > ynca` (Schreib-Beweis schlägt Modernität).
  Titel seit v2.0.0 NICHT mehr als eigene Datenpunkte: sie stehen als Beschriftung im
  recall-Dropdown (Koordinator-„dropdown borrowing": der Owner erbt `common.states`
  eines nicht-besitzenden Anspruchs) und gesammelt in EINEM `scene.list`-JSON;
  recall nimmt Nummer ODER Titel (Auflösung via `catalog/scene-titles.ts` aus dem
  ProbeMemory — XML `Scene_Sel_Item` je Zone, YNCA SCENExNAME für main).
  Zonen-Szenen unter `multiroom.zoneN.scene.*`.
- **Per-Gerät-Schreibkarte YNCA** (`presentYncaEntries` + `writeMap` im Controller):
  geschrieben wird nur mit einer Funktion, die DIESES Gerät im Sweep beantwortet hat.
  Damit koexistieren Generationen-Dialekte unter einer Id: `sound.bass` = SPBASS
  (klassisch) ODER TONEBASS (MusicCast-Gen; Katalog-Reihenfolge: TONE nach SP, damit
  im statischen Fallback die neuere gewinnt). `yncaCommand` verweigert zudem
  Nur-Lese-Einträge (vorher ging jeder Katalog-Id-Write auf den Draht).
- **Menü-zurück-Rückfall** (#613, `xml-browse-driver.ts`): `Cursor=Return`, bei
  Ablehnung einmalig auf `Cursor=Left` (Melder-Messwert der 2012er-Generation)
  und für die Verbindung gemerkt; `home`-Ablehnung wird sichtbar (Engine-warn).
- **Klassik-Tuner über XML** (nur Geräte, deren einziger Transport XML ist):
  Existenz-Probe `<Tuner><Play_Info>`, Preset-Schreibweg openHAB-verifiziert
  (`Play_Control>Preset>Preset_Sel`), Frequenz/RDS/Tuned lesend; Eingangs-Dropdown je
  Zone aus `Input_Sel_Item` (Geräte-eigene Liste). Beide über `probeXml`+ProbeMemory.
- **YXC-Ausbau:** `remote.cursor`/`remote.menu` (Endpunkte `controlCursor`/`controlMenu`
  am Gerät verifiziert — fehlen in BEIDEN öffentlichen Spezifikationen; Vokabular per
  Parameter-Validierung: cursor up/down/left/right/select/return, menu
  on_screen/top_menu/menu/option/display/home), `getSignalInfo` je Zone
  (sound.signal*), MusicCast-Wiedergabelisten (`getMcPlaylistName`, Namen als JSON,
  bewusst ohne Abspiel-Schreibweg — nirgends dokumentiert) und `getPlayQueue`
  (JSON). YNCA-Katalog +18 Funktionen (Tone-Dialekt, DIALOGUELVL, DAB-Details,
  BT:DEVICENAME, AIRPLAY:VOLINTERLOCK, SPPATTERN1AMP, TRIG1MANUAL; `YNCAPORT`
  bewusst NUR lesend — ein Schreib-Unfall würde die eigene Verbindung kappen).
- **`info.ip` je Gerät** (`ensureDeviceHeader`): die Adresse stand nirgends —
  Diagnose brauchte eine Netzsuche; jetzt Datenpunkt, je Start aufgefrischt.

**Schnellstart (krobi 2026-09-01: „warum arbeiten wir hier nicht mit caches"):**

- **ProbeMemory ist PERSISTENT** (Geräteobjekt `native.probeCache`, als JSON-STRING —
  extendObject MERGED verschachtelte Objekte, gelöschte Schlüssel stünden sonst wieder
  auf; `loadProbeMemory` in main.ts). Frische-Wächter je Transport, jeder validiert
  SEINE Schlüssel mit einer LIVE-Identitäts-Lesung und droppt bei Abweichung: YNCA
  Modell+Firmware (2 Reads, sowieso da), YXC `getDeviceInfo` model+system_version
  (Schlüssel features/name/model/yxcIdentity), XML `getModelName` (alle `xml*`-Schlüssel).
- **YNCA-Schnellpfad** (`resolveCapabilities` + `refreshInBackground`): Identität IMMER
  zuerst (Lebend-Beweis der ready-Zeile — Ehrlichkeits-Regel v1.5.0 bleibt); passt der
  persistierte `yncaCapabilities`-Layer (Modell+Firmware), steht der Baum aus der Form
  SOFORT, es wird NICHT mit alten Werten geseedet (die States tragen sie ohnehin), und
  die volle Fragerunde läuft als Hintergrund-Werte-Auffrischung durch den Live-Handler —
  inkl. Statics (Umbenennungen heilen in Sekunden statt beim Neustart). FORM-Änderungen
  werden nur persistiert (Objekte erscheinen beim nächsten Start): der Baum wird EINMAL
  pro Verbindung koordiniert, ein später `interceptUpsert` würde nie materialisiert.
- **Netzsuche blockiert Bekannte nicht mehr:** `autoDiscover` gibt gemerkte Geräte
  sofort zurück; `discoverAdditionalDevices` sucht im Hintergrund und startet NUR
  Neuzugänge (`startDevice` aus der onReady-Schleife ausgelagert).

## Objektbaum 2.0.0 — „Läuft gerade" statt 16 Kopien (2026-09-01)

Beschlossene Vorlage: Artefakt-Seite „Yamaha-Objektbaum 2.0" (Gesamtvorschlag, krobis Go).
Migration: `pure-helpers.ts` (`RENAMED_STATE_IDS`/`RENAMED_CHANNELS`, v2.0.0-Block) räumt beim
ersten Start ALLE Alt-Pfade selbst weg; `common.messages`-Warndialog (oldVersion<2.0.0) kündigt es an.
Der Zonen-Präfix-Strip in `renamedObjectIds` kennt seit v2.0.0 auch `multiroom.zoneN.`.

- **Player = EIN Block je Zone** (`player.*`, Zonen als `multiroom.zoneN.player.*`): source ·
  playback · artist/album/track/albumArt · elapsed/totalTime · repeat/shuffle · Transport-Buttons.
  Gefüttert von der Quelle, auf die die ZONE hört: YXC routet netusb/cd-PlayInfo über den
  Zonen-Eingang (`routePlayerBlock`, Clear-on-Switch einmalig beim Verlassen, `player.cd.*`-
  Laufwerks-Eigenes bleibt geräteweit), YNCA mappt je Zone `INP`→Quellen-Subunit
  (`INPUT_SUBUNITS`, normalisiert) und filtert Sweep-Seed UND Live-Pushes darüber
  (`routePlayerUpdate`); Eingangswechsel = Block leeren + Quelle anzeigen + gezielte GETs.
  Schreibwege: YXC `playerTransport` (deklarativ, Controller kennt die Quelle der Zone),
  YNCA `handlePlayerWrite` (Entry des GEHÖRTEN Subunits aus `presentEntries` — claim-with-proof).
  Owner-Overrides `player.playback/repeat/shuffle → ynca` (YXC liest nur; seine Toggle-Buttons
  bleiben YXC). Quell-Ordner behalten NUR Eigenes: netRadio/server/usb-Presets(+bookmark),
  `player.netPlayer`-Listen (preset/presets/recent/recallRecent/playlists/queue), cd-Laufwerk,
  bluetooth-Kopplung, airplay.volumeInterlock; spotify/deezer/tidal/ipod/ipodUsb/musicCastLink
  sind als Ordner WEG (ihr Playback läuft im flachen Block).
- **Tuner vereinheitlicht:** EIN `tuner.band`/`tuner.frequency` (kHz auf jeder Generation:
  YNCA-FMFREQ `wireDecode` ×1000, XML `frequencyUnit`-Normalisierung, YXC nativ kHz)/
  `tuner.preset`. Band-abhängige Schreibwege routet der YNCA-Controller VOR dem generischen
  Pfad (`handleTunerWrite`: TUN AM/FM → AMFREQ/FMFREQ; DAB-Gerät FM → DAB:FMFREQ, DAB-Band-
  Frequenz wird verworfen — DAB stimmt auf Dienste; Preset → DABPRESET/FMPRESET nach Band).
  Die DAB-FM-Hälfte liegt auf den flachen tuner.*-Ids, nur echt DAB-Eigenes unter `tuner.dab`.
- **Feinschliff:** `sound.equalizer.{mode,low,mid,high}` · `sound.signal.{format,sampling,bits,bitrate}`
  · `hdmi.lipSyncOut1/2` (lipSync-Ordner weg) · `advanced.speakers.speakerA/B`.

**v2.0.1 — „kein wertloses Lese-Feld" (Live-Feld-Audit, drei Mechanismen):**

- **XML claim-with-proof** (der letzte Transport ohne Beweis-Pflicht): AMP-Katalog-Objekte
  entstehen nur für Basic_Status-Felder, die DIESES Gerät liefert; gelieferte Feldmenge je Zone
  als persistierte UNION im ProbeMemory (`xmlStatusFields:<zone>` — Standby-Start schrumpft den
  Baum nicht); taucht ein Feld erstmals im Poll auf, wird es GEMERKT statt objektlos geschrieben
  (`createdStates`-Gate; Live-Nachanlage bewusst nicht — späte Upserts materialisiert der
  Koordinator nicht), der nächste Start legt es an.
- **Verwaisten-Sweep einmal pro Adapter-Version, NACH dem Verbinden** (`purgeNeverFilled` im
  Bilanz-Settle, `pure-helpers.neverWrittenStateIds`): löscht Lese-States ohne je-Wert (kein val,
  kein lc) unter verbundenen Geräten, minus im Lauf beanspruchte (`touchedThisRun`), minus
  info-Header. **`common.custom` ist seit v2.0.3 bewusst KEIN Faktor** (krobi: Aufzeichnung ist
  User-Sache und sagt nichts darüber, ob der Datenpunkt in den Baum gehört — das verantwortet
  allein der Adapter; die frühere Ausnahme war eine nie besprochene Eigenmächtigkeit);
  Marker `native.purgeVersion` am GERÄTE-Objekt. Offline-Gerät bleibt samt altem Marker unberührt.
- **Ruheform-Seeds**: Player-Block einer Zone ohne Medienquelle startet mit Leerwerten (beide
  Seiten — der jeweilige Besitzer schreibt durch den Filter); DAB-Suchlauf-Zähler starten mit 0.
- **Tuner-Router mit Beweis** (`sendProven`): band-geroutete Schreibwege senden nur Funktionen,
  die dieses Gerät im Sweep beantwortet hat — ein Gerät ohne Tuner bekommt keinen blinden PUT.

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

## Voll-Audit 2026-09-02 (v2.0.4) — Regeln, die im Code stehen müssen

16-Dimensionen-Audit + Speicher/Leaks + Sicherheit + Test-Audit mit Mutationstests; Bericht
`../../Ressourcen/yamaha/test-audit-2026-09-02.md`. Zehn Funde, alle umgesetzt (krobi: „kein Filter").

- **Jeder Datenbank-Schreibvorgang wird BEOBACHTET** — `writeState(id, value)` /
  `persistDeviceNative(deviceId, native)` in `main.ts`, nie `void this.setState(...)`. Grund
  (js-controller-Quelle gelesen): eine unbehandelte Promise-Ablehnung wird zu
  `_exceptionHandler(err, true)` → Instanz-Stopp; `setState` ohne Callback lehnt ab, sobald die
  States-DB gerade nicht erreichbar ist (`ERROR_DB_CLOSED`, Redis-Reconnect). Neun nackte
  Writes hätten bei einem Schluckauf die Instanz neu gestartet. Fehler: EINE Warnung, Wiederholungen
  auf debug bis ein Write gelingt (`stateWritesFailing`), still während `unloading`. Gleiche Regel
  für den YNCA-Socket: `writeLine` lehnt nie ab — ein Schreibfehler wird `lastError` (Drop-Grund).
- **Protokoll-Flaggen `info.transports.<proto>` sind kein Letztwert:** `startDevice` setzt sie VOR
  dem ersten Versuch auf false (die Karte zeigte nach einem Absturz „YNCA ✓" neben rotem Punkt —
  für immer, wenn das Gerät nie wieder antwortet), `onUnload` nimmt sie mit der Verbindung herunter.
- **Netzsuche überlebt den Stopp:** `onReady` prüft `unloading` NACH der blockierenden Erstsuche
  (sonst kamen UDP-Empfänger, Abos und Geräte auf einer toten Instanz hoch — niemand schließt sie
  mehr), `discoverAdditionalDevices` nach der Hintergrundsuche; `timers.schedule`/`scheduleKeepalive`
  verweigern nach `unloading`. `startDevice` selbst hat KEINEN Wächter mehr — beide Aufrufer prüfen.
- **`scene.list` gehört dem Titel-Lieferanten** (Owner-Override `xml > ynca > yxc`): MusicCast kennt
  nur die Slot-ANZAHL; als Owner nach Modernität hätte es beim ersten Kontakt eine titellose Liste
  veröffentlicht, die bis zum Neustart stand (YNCA-Namen kommen erst mit dem 19-s-Sweep).
- **Körper-Kappe 1 MiB** (`MAX_HTTP_BODY_BYTES`, `util.ts`) auf allen drei HTTP-Wegen
  (Gerätebeschreibung, YXC, XML) — Abbruch per `res.destroy(err)` (landet im `res`-Fehlerhandler;
  `req` ist in `onResponse` noch nicht definiert → `no-use-before-define`). Echte Antworten: wenige KB,
  größte `getFeatures` ~5 KB.
- **XML-Sonden merken nur ENDGÜLTIGE Urteile** (`probeXml`, Browse-Quellen-Probe im
  `xml/device-controller.ts`): endgültig = körperloses HTTP 400 (`XmlHttpError`,
  `isPermanentXmlRefusal`) oder `RC=2` (Knoten existiert nicht — Ernte RX-V6A 2026-09-01);
  vorübergehend = Timeout, anderer HTTP-Status, `RC 3/4` → wirft, `once()` merkt nichts, nächster
  Connect fragt neu. Vorher merkte sich ein Timeout beim Verbinden dauerhaft „keine Szenen/Menüs".
  Die Ernte lief am EINGESCHALTETEN Gerät — das Standby-Verhalten ist unbelegt, deshalb die
  Asymmetrie (nur beweisbar Negatives wird gemerkt).
- **Equalizer-Cache wird nur aus einem VOLLSTÄNDIGEN Tripel gesät** (`cacheEqualizer`): ein
  Erst-Status mit nur zwei Bändern darf keine erfundene 0 hinterlassen, die ein späterer
  Band-Write mit auf das Gerät schreibt; Teil-Updates mergen per `??` in den bestehenden Cache.
- **Kanäle entstehen NUR in der Eltern-Schleife je Datenpunkt**, benannt aus `CHANNEL_NAMES` — keine
  ausdrücklichen Kanal-Anlagen daneben. Die vier am 22.08. als „Deklaration" behaltenen Blöcke (XML-Zonenkanal,
  MusicCast-Zonenkanal, `multiroom`/`multiroom.group`-Wächter) waren am vollständigen Code nachgewiesen tot:
  eine Zone existiert nur mit mindestens einem Datenpunkt, und dessen Eltern-Schleife legt denselben Kanal
  mit demselben Namen an. Ebenso weg: der wirkungslose `!group_multiroom`-Teil der Migration und die
  Reihenfolge-Liste im Baum-Koordinator (Map-Iteration ist Einfügereihenfolge). krobi 02.09.: „nicht dass
  sie eine Ausrede sind" — äquivalent ist ein Zwischenurteil, toter Code wird entfernt, nicht dokumentiert.
- **Reconnect-Streuung nach UNTEN** (`delay · (1 − jitter·rand)`): die Obergrenze ist eine
  Obergrenze — vorher konnte der Jitter sie um 20 % überschreiten.
- **Formatierung: das Repo ist seit 2026-09-02 prettier-sauber** (`npm run format:check` = 0) und
  bleibt es — `npm run format` ist gefahrlos. Ausschlussmuster in den beiden `format`-Skripten
  (KEINE `.prettierignore` — Repochecker W0084/W5048): `build/` (Compiler-Ausgabe),
  `io-package.json` (Release-Skript, i18n-Sync und Konsistenz-Autofix schreiben aufgeklapptes JSON),
  `.github/**` (Community-/Bot-Vorlagen von mcm1957 und iobroker-bot — einfache Anführungszeichen,
  eigene Formen; der Konsistenz-Audit vergleicht sie im Community-Zweig, unsere Formatierungshoheit
  endet dort). `.releaseconfig.json` ist die Master-Kopie (Master seit 2026-09-02 auf Zeilenbreite
  120 formatiert). CI-Gate bleibt `npm run lint`.

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

## Aufräumen, Identität und Ruheform (Fehler-Audit 2026-09-02)

- **Kein Ordner ohne Datenpunkt.** `purgeChildlessChannels` (`pure-helpers.childlessChannelIds`)
  entfernt im selben eingeschwungenen Moment wie der Verwaisten-Sweep jeden Kanal, unter dem
  NIRGENDWO ein State liegt — beide Vorgänger fassen nur Datenpunkte an (`neverWrittenStateIds`
  filtert auf `type === "state"`), weshalb `player.server` seit dem 2.0.0-Umbau als leeres
  Versprechen im Baum stand (#617). Verschachtelte Leere löst sich selbst auf, Ordner zählen nicht
  in die Datenpunkt-Bilanz, und ein Gerät, das in diesem Lauf nicht geantwortet hat, bleibt
  unangetastet (kein Datenbank-Lesen, wenn nichts bereit ist).
- **Ein Gerät ist seine Id, nicht seine Adresse.** `mergeDiscovered` schlüsselt nach Geräte-Id;
  eine neue Adresse wird übernommen, und `discoverAdditionalDevices` verbindet ein umgezogenes
  Gerät dort neu (`stopDevice` + `startDevice`, `knownDeviceIps` nachgeführt). Vorher warf der
  Adress-Schlüssel den Fund als Id-Kollision weg und das Gerät blieb für immer offline. Solange
  ein automatisch gefundenes Gerät offline ist, ist EINE gedrosselte Netzsuche scharf
  (`REDISCOVER_MIN_INTERVAL_MS`, ein Zeitgeber für beliebig viele Geräte) — nur sie findet ein
  umgezogenes Gerät wieder.
- **Löschen löscht.** Die Gerätekarte eines gefundenen Geräts schreibt nur eine Datei (kein
  Neustart), deshalb erledigt `removeDevice` selbst, was sonst erst ein späterer Start täte:
  Wächter beenden, Teilbaum entfernen. Die Id landet zusätzlich in `ignored.json`, sonst legt die
  nächste Suche das Gerät wieder an; ein manuelles Hinzufügen derselben Id hebt den Ausschluss auf.
- **Ruheform auch für das Menü.** `BrowseEngine.seed()` setzt beim Verbinden das GANZE Fenster
  zurück (acht Zeilen, Menüname, Ebene, Anzahl, Zeile, `rows`) — vorher nur `busy`/`path`, sodass
  nach einem Neustart das Menü der letzten Sitzung stehen blieb (live gemessen: Zeilen sechs Tage
  älter als die Verbindung).
- **Kein Geräte-Platzhalter als Inhalt:** die DAB-Uhrzeit wird getrimmt und leer, wenn sie keine
  Ziffer außer Null und keinen Monatsnamen trägt; die Senderliste veröffentlicht nur belegte
  Fächer; `sound.signal.*` wird leer statt „---".
- **`tuner.band` wird von zwei Einheiten gespeist** (TUN {AM,FM}, DAB {DAB,FM}). Einträge mit
  derselben State-Id teilen sich die VEREINIGUNG ihrer Auswahl (`unionSharedDropdowns`), und ein
  Band-Schreibvorgang wird nach dem WERT geroutet (AM→TUN, DAB→DAB, FM→DAB wo vorhanden). Vorher
  gewann die zuletzt geschriebene Definition und AM verschwand.
- **Auch das State-Abo ist ein Datenbank-Aufruf:** `subscribeStatesAsync` wird abgewartet; sein
  Sternchen-Zweig gibt im Fehlerfall ein abgelehntes Promise zurück, und eine unbehandelte
  Ablehnung stoppt die Instanz. Ein Fehler ist laut, aber nicht tödlich — der Baum füllt sich
  weiter, nur Schreibvorgänge greifen nicht mehr.

## Stand

Alle sieben Aufbauphasen abgeschlossen, danach der Multi-Transport-Neubau (alle antwortenden Protokolle
parallel auf einem Objektbaum statt „erster Transport gewinnt"), der thematisch gruppierte Objektbaum mit
abschaltbaren Datenpunktgruppen und die Wiedergabe als Media-Player (Alexa/Google/VIS). Der Adapter ist
funktional vollständig (3 Protokolle, Discovery, Migration, Härtung). Versionshistorie im README
`## Changelog` (nicht hier dupliziert).

**Erledigt 2026-09-02 (abends):** die Namens-Sperre des State-Rollen-Prüfers ist aufgehoben — 248 Namen laufen
über `admin/i18n`, das Gate meldet „kein fester String in common.name/desc" (s. Abschnitt „Namen sind
Übersetzungsobjekte"). Im selben Durchgang die Funde des Fehler-Audits nach #617/#618 (s. „Aufräumen, Identität
und Ruheform"); Bericht `../../Ressourcen/yamaha/bugplan-2026-09-02.md`.

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

## Tests

- vitest, `src/**/*.test.ts` — Unit + Boot-Integrationstest (startet den Adapter real). 825 Tests.
- **Mutationstabellen** (`../../Ressourcen/iobroker-entwicklung/mutation-testing/`): `mutations_yamaha_all.py`
  (116 Regelbrüche, Wellen 1–5 vom 22.08., Nadeln am 02.09. nachgezogen, vier tote entfernt) + `mutations_yamaha_2026-09-02.py`
  (24, Welle 6 = die Audit-Fixes; IDs Z1–Z24, W gehört Welle 5) + `mutations_yamaha_2026-09-03.py`
  (18, Welle 7 = die Fehlerbehebungen des Fehler-Audits, IDs Z1–Z18 in eigener Tabelle; 18/18 gefangen). Läufer `mutation-test.py`. Nadeln sind
  exakte Quellzeilen — nach Prettier-Umbrüchen oder Refactorings ZUERST den Nadel-Vorab-Check (jede Nadel
  genau 1×), sonst misst der Lauf nichts. Zwei äquivalente Mutanten (X2, X4 — unerreichbare
  Invarianten-Wächter, im Quelltext begründet); die vier anderen vom 22.08. (M9, X1, Y1, Y13) waren toter
  bzw. doppelter Code und sind am 02.09. samt Zwillingen entfernt — ein Überlebender außerhalb X2/X4 ist eine Testlücke.
- **HW-freies Testen:** `ynca`-Python bringt debug-server + echte Geräte-Logs → YNCA-Client dagegen testbar.

## Befehle

- `npm run build` · `npm test` · `npm run lint` · `npm run check` · `npm run format:check` (muss 0 melden) · `npm run release`.

## Versionshistorie

Changelog im README (`## Changelog`) + `CHANGELOG_OLD.md` + `io-package.json` `news`, nicht hier dupliziert.
Die Vorgänger-Historie (soef 2015 → Community-Wartung bis 0.5.4) bleibt erhalten — s. README `## History`.

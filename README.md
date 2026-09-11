# <img src="https://cdn.jsdelivr.net/gh/iobroker-community-adapters/ioBroker.yamaha@master/admin/yamaha.svg" width="48" align="top" /> ioBroker.yamaha

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha) ![stable](https://iobroker.live/badges/yamaha-stable.svg) ![Installations](https://iobroker.live/badges/yamaha-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha)

**Build:** [![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.yamaha/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/iobroker-community-adapters/ioBroker.yamaha/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Controls [Yamaha](https://www.yamaha.com/) AV receivers and MusicCast devices from
ioBroker over the local network. It unites the three protocols Yamaha speaks —
YNCA (the text control protocol of the networked receivers), MusicCast / Yamaha
Extended Control (the richer JSON protocol of the MusicCast generation), and the
legacy XML protocol of the oldest pre-2010 models — behind one object tree.

## Features

- **Three protocols, one adapter** — YNCA, MusicCast (Yamaha Extended Control) and the legacy XML
  protocol of the pre-2010 models, used in parallel on one object tree
- **Instant updates** — MusicCast pushes its changes, YNCA reports over its live connection
- **Capability-driven** — the object tree is built from what each device reports, no hardcoded model list
- **Now playing, per zone** — one player block per zone, whatever that zone is listening to, with
  menu browsing, presets and favourites
- **Multi-zone and multiroom** — zones 2–4 with their own player and scenes, party mode, MusicCast groups
- **Automatic discovery** — an empty device list finds and sets up MusicCast devices at startup
- **Self-healing connections** — a single protocol reconnects on its own while the others keep running

## Documentation

The **[Wiki](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki)** has the full
documentation in English and German:

| | |
|---|---|
| **[Upgrade](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Upgrade)** | coming from yamaha 0.5.x, from `musiccast`, or from an earlier 2.x — **read this first if you already run one of them** |
| **[Setup](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Setup)** | finding your device, manual entry, what happens on the first start |
| **[Protocols](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Protocols)** | why your device can more or less than someone else's |
| **[Datapoints](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Datapoints)** | what is in the object tree and where to find it |
| **[Devices](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Devices)** | which Yamaha devices work, and what each class can do |
| **[Troubleshooting](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Troubleshooting)** | sorted by symptom |

A short version ships with the adapter and is shown in the admin ([English](docs/en/README.md) ·
[Deutsch](docs/de/README.md)).

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting only happens if you have enabled error reporting in the ioBroker diagnostics (**System settings → Diagnostics and error reporting**). Only an anonymous installation ID is transmitted — no name, e-mail address or IP address.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- admin >= 8.0.11

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

## Configuration

Devices are managed in the admin as cards. **Leave the list empty** and the adapter finds MusicCast
devices on the network by itself at startup, or add devices by IP via the **"+" dialog**. Older
receivers (before ~2010) do not announce themselves and must be added by hand.

The **Data points** section switches whole groups of datapoints on or off; the amplifier core (power,
volume, mute, input, sound program, sleep) always stays on. The **Volume as 0–100 %** switch turns
every volume datapoint into a percentage — the range most VIS widgets expect.

Details on all settings, the object tree and the ports the adapter uses are in the
[Wiki](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Setup).

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 2.8.0 (2026-09-11)

- (krobipd) Fixed: A volume written to a MusicCast receiver now arrives exactly — the adapter reads the receiver's own step declaration instead of guessing a ratio (#623)
- (krobipd) Fixed: Every zone of a receiver now carries the same volume scale — a third zone used to show a raw 0…161 count next to decibels in the other two
- (krobipd) Changed: The volume datapoint now carries the minimum, maximum and step the receiver reports for that zone — a receiver whose zones differ gets a different range per zone
- (krobipd) New: Setting "Volume as 0–100 %" turns every volume datapoint, in every zone, into a percentage — what most VIS widgets expect. Off by default; the receiver's own scale stays the truth
- (krobipd) Changed: The datapoints actualVolume, actualVolumeMode and inputText are gone — volume and input carry the same information
- (krobipd) Changed: After this update every receiver is asked about its abilities once more, so the first start takes a little longer than usual
- (krobipd) Fixed: A DAB receiver no longer logs a warning on every tuner poll — the frequency datapoint was limited to the FM band while the receiver reported DAB frequencies

### 2.7.2 (2026-09-09)

- (krobipd) Fixed: The volume readout now follows the scale the receiver is actually showing, so a receiver set to numbers no longer reports them as decibels.
- (krobipd) New: Inputs now appear under the names the receiver carries for them, so a socket named “Apple TV” reads that way instead of HDMI1.
- (krobipd) Changed: After this update every receiver is asked about its abilities once more, so the first start takes a little longer than usual.

### 2.7.1 (2026-09-09)

- (krobipd) Improved: The first connection asks a receiver only what its generation can answer, so zones, trigger sockets and per-input settings follow the device, not a catalogue.
- (krobipd) New: A datapoint the receiver reveals later now appears at once — a function it starts answering, a value it reports for the first time, a status field it begins delivering.
- (krobipd) Changed: A datapoint that never carried a value is removed only after two starts confirm it, so a receiver left in standby no longer loses datapoints it still has.

### 2.6.0 (2026-09-09)

- (krobipd) Fixed: input and sound program lists now offer only what the receiver itself declares or proves it has, instead of every value any Yamaha may have (#619)
- (krobipd) Fixed: the 2008 receiver generation gets volume, mute and sound program back; HDMI output, aspect, resolution and decoder lists carry the values the receiver reports
- (krobipd) New: HD Radio and Sirius on the US models, zone balance, pre-out mode and zone scenes, party volume keys, HDMI video mode, lip sync, a second trigger output and speaker pattern
- (krobipd) New: on older XML receivers the enhancer, CINEMA DSP 3D, speaker A/B, Zone B, a zone-wide cursor pad, transport keys and zone names; MusicCast gains standby-through and speaker pattern
- (krobipd) Improved: a receiver is set up from its own declaration of zones and inputs, so it comes online faster and is learned again by itself after an update that changes how it is read
- (krobipd) Improved: the first connection to a YNCA receiver asks fewer questions, so its datapoints appear sooner

### 2.5.2 (2026-09-07)

- (krobipd) Improved: 174 more datapoints explain themselves — volume and tone now say which scale they use, the stored lists say what is inside them, and the menu rows say what they are for
- (krobipd) Improved: a receiver's "Connected" now says what it means — a device on network standby answers as well, so it is not the same as being switched on

[Older changelogs can be found there](CHANGELOG_OLD.md)

## History

The yamaha adapter has a long lineage on ioBroker, and this version continues it —
for existing users it is simply a new version of the same adapter:

- **[soef](https://github.com/soef)** created the adapter in 2015 and built the
  original control over Yamaha's XML network protocol, with realtime state updates
  and multi-zone support.
- **[Garfonso](https://github.com/Garfonso)**, **[Sneak-L8](https://github.com/Sneak-L8)**
  and **[Apollon77](https://github.com/Apollon77)** contributed over the following
  years — admin compatibility, fixes and Sentry crash reporting.
- The **[ioBroker Community Adapters](https://github.com/iobroker-community-adapters)**
  team — notably [foxriver76](https://github.com/foxriver76) and
  [mcm1957](https://github.com/mcm1957) — maintained the adapter from 2020 to 2026,
  releasing versions up to 0.5.4.
- Since 2026, [krobi](https://github.com/krobipd) maintains the adapter in the community
  organisation and rebuilt it from the ground up, uniting the YNCA, MusicCast (YXC)
  and legacy XML protocols behind one object tree.

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/iobroker-community-adapters/ioBroker.yamaha/issues)

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

## License

The MIT License (MIT)

Copyright (c) 2015-2024 soef <soef@gmx.net>  
Copyright (c) 2026 iobroker-community-adapters <iobroker-community-adapters@gmx.de>  
Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

# <img src="https://cdn.jsdelivr.net/gh/iobroker-community-adapters/ioBroker.yamaha@master/admin/yamaha.svg?v=2.10.0" width="48" align="top" /> ioBroker.yamaha

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha) ![stable](https://iobroker.live/badges/yamaha-stable.svg) ![Installations](https://iobroker.live/badges/yamaha-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha)

**Build:** [![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.yamaha/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/iobroker-community-adapters/ioBroker.yamaha/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

> [!IMPORTANT]
> This adapter cannot be installed from github

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
- **Automatic discovery** — an empty device list finds and sets up Yamaha network devices at startup
- **Self-healing connections** — a single protocol reconnects on its own while the others keep running

## Documentation

The **[Wiki](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki)** has the full
documentation in English and German: 

| | |
|---|---|
| **[Upgrade](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Upgrade)** | coming from yamaha 0.5.x, from `musiccast`, or from an earlier version — **read this first if you already run one of them** |
| **[Setup](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Setup)** | finding your device, manual entry, what happens on the first start |
| **[Protocols](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Protocols)** | why your device can more or less than someone else's |
| **[Datapoints](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Datapoints)** | what is in the object tree and where to find it |
| **[Devices](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Devices)** | which Yamaha devices work, and what each class can do |
| **[Troubleshooting](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Troubleshooting)** | sorted by symptom |

A short version ships with the adapter and is shown in the admin ([English](docs/en/README.md) ·
[Deutsch](docs/de/README.md)).

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting is active by default. It stays off when the ioBroker diagnostics setting is `none` (`diag` in the system configuration), when data reporting is disabled for this instance or its host (`disableDataReporting`), and on CI systems. A report contains the error with its stack trace and technical context such as versions and platform, plus an anonymous installation ID.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- admin >= 8.0.14

## Ports

| Port | Protocol | Direction | Purpose |
|---|---|---|---|
| 41100 | UDP | incoming | MusicCast devices report their changes |
| 1900 | UDP | incoming, shared with other UPnP services | devices announcing themselves — only while the network search is on |
| 1900 (multicast 239.255.255.250) | UDP | outgoing | the network search |
| 50000 | TCP | outgoing | YNCA control of the receivers |
| 80 and the port a device announces | TCP | outgoing | MusicCast and XML control, the device description |

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (krobipd) New: Diagnostics report on the new Expert tab of the instance settings — reads the receiver over every protocol (read only), adds its datapoints, the recent log lines and whether the musiccast adapter is installed, switched on and running, and saves it as one file for a GitHub issue; addresses, serial numbers and names are replaced by markers

### 3.2.0 (2026-10-02)

- (krobipd) Fixed: Dropdown lists such as sound program, sleep timer and Adaptive DRC no longer go empty when the receiver loses power; lists emptied that way come back
- (krobipd) Changed: Your datapoints stay exactly as they are while the adapter runs, also when a receiver goes offline; they change only after an adapter or firmware update
- (krobipd) New: A command the receiver refuses over one protocol, or one sent while that protocol is offline, goes out over another protocol that understands it
- (krobipd) New: A firmware update of the receiver is noticed and logged; the adapter reads the receiver again and reports it ready once that is done
- (krobipd) Fixed: Datapoints of found receivers are no longer deleted at adapter start when the receiver list cannot be read or an entered receiver has the same address

### 3.1.3 (2026-10-02)

- (krobipd) Fixed: Menu lines fill again after switching player.browse.source, also on receivers that were in standby when the adapter started
- (krobipd) Fixed: On receivers that offer their menus only over XML (models from before 2010), the menu lines no longer stay empty after a source switch
- (krobipd) Changed: A new instance starts switched off and waits until you have set it up; existing instances keep their own setting

### 3.1.2 (2026-09-30)

- (krobipd) Fixed: The sleep timer lists the receiver's own values again (Off, 30 min …) instead of MusicCast's minutes, so a picked value is one the receiver accepts

### 3.1.1 (2026-09-30)

- (krobipd) Fixed: A receiver that replaces another at the same address is asked again whether zones 2 and 3 have an on-screen remote, instead of inheriting the old answer

### 3.1.0 (2026-09-30)

- (krobipd) Changed: player.playback follows the ioBroker standard now — 0 pause, 1 play, 2 stop; repeat and shuffle can be set directly where the device allows it
- (krobipd) New: Receivers from before 2010 show what is playing — artist, album, track, station, status and cover — and 2008 models get their zone names
- (krobipd) New: Every favourite, recent item, playlist, stored station and scene title is a datapoint of its own, next to the list
- (krobipd) New: Volume up/down keys, a mute level, storing and clearing tuner presets, station search, and a settable clock and alarm on MusicCast clock radios
- (krobipd) Fixed: A protocol that does not answer at start is connected again later, and its datapoints keep their type in the meantime
- (krobipd) Fixed: On older receivers only what the device declares can be written, with its own limits; 2008 tuner presets A1–E8, band and frequency work
- (krobipd) New: More menu sources on older receivers, TIDAL on MusicCast, menus in your ioBroker language, and remote pads for zones 2 and 3 of 2011/2012 AVENTAGE
- (krobipd) Fixed: A MusicCast Zone B shows as Zone B and joins a group with Zone A, and the cover changes with the track
- (krobipd) Fixed: Deleting a device, renaming it in the dialog or stopping the adapter no longer loses a name or leaves a network search running
- (krobipd) Improved: Dropdowns show readable names in your ioBroker language, the playing source shows the input's name, and each queued track is its own datapoint

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

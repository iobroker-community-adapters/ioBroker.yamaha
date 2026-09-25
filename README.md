# <img src="https://cdn.jsdelivr.net/gh/iobroker-community-adapters/ioBroker.yamaha@master/admin/yamaha.svg?v=2.10.0" width="48" align="top" /> ioBroker.yamaha

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
- **Automatic discovery** — an empty device list finds and sets up Yamaha network devices at startup
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

## Ports

| Port | Protocol | Direction | Purpose |
|---|---|---|---|
| 41100 | UDP | incoming | MusicCast devices report their changes |
| 1900 | UDP | incoming, shared with other UPnP services | devices announcing themselves — only while the network search is on |
| 1900 (multicast 239.255.255.250) | UDP | outgoing | the network search |
| 50000 | TCP | outgoing | YNCA control of the receivers |
| 80 and the port a device announces | TCP | outgoing | MusicCast and XML control, the device description |

## Configuration

Devices are managed in the admin as cards. **Leave the list empty** and the adapter finds Yamaha
network devices by itself at startup, or add devices by IP via the **"+" dialog**. Older
receivers (before ~2010) do not announce themselves and must be added by hand.

The network search runs **Automatically** (while the list is empty), **Always** (next to the devices
you entered) or **Never**. With **Never** the adapter opens no listener on UDP port 1900 and controls
the devices in your list by their address.

The **Data points** section switches whole groups of datapoints on or off; the amplifier core (power,
volume, mute, input, sound program, sleep) always stays on. **Volume as 0–100 %** is set per device,
in the add/edit dialog of its card, and turns that receiver's volume datapoints into a percentage —
the range most VIS widgets expect.

Details on all settings and the object tree are in the
[Wiki](https://github.com/iobroker-community-adapters/ioBroker.yamaha/wiki/Setup).

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (krobipd) Changed: Every device gets a new object ID once — its model and the end of its serial number, e.g. `wx-030-2b3c`; scripts and VIS need the new IDs
- (krobipd) Changed: The move carries values, recording settings, rooms, functions and aliases along, and recorded history continues in its old series
- (krobipd) Fixed: A second device of the same model and name is no longer skipped — every device gets its own object tree
- (krobipd) Fixed: After a restart, the input list of a YNCA receiver offers only the sources the receiver has again, not the whole catalog
- (krobipd) New: A device added by hand is asked for its model and serial number, and the name you type is its display name from the start
- (krobipd) New: The device card shows the object ID, the MAC address and the serial number under its details

### 2.13.0 (2026-09-25)

- (krobipd) Fixed: A value a receiver refuses no longer stays on the datapoint — every write is read back, and the log names the device's reason
- (krobipd) Fixed: MusicCast values stay current in Docker or next to a second MusicCast app — missing events are noticed, then the adapter polls and reads writes back
- (krobipd) New: MusicCast devices write every setting the specification gives a setter for: dialogue level, 3D surround, tone mode, speaker A/B, dimmer, group name and more
- (krobipd) Fixed: MusicCast Link groups are built and left as Yamaha specifies — the joining zone switches to MusicCast Link, multiroom.group.status shows the progress
- (krobipd) Fixed: Names you give inputs, sound programs and zones in the app or on the receiver show up at the next connection instead of staying frozen
- (krobipd) Fixed: Umlauts in names and titles arrive intact on all three protocols, and YNCA zone names are written in the character set the receiver expects
- (krobipd) Fixed: When one protocol of a receiver drops, a live one takes over every datapoint it serves the same way, so power and volume keep working
- (krobipd) Fixed: true, a hex string or "1e2" written to a level, preset or scene no longer reaches the receiver; in percent mode "50" counts like 50
- (krobipd) Fixed: Back and Home work on 2012-and-later YNCA receivers, and a refused key no longer switches the remote pad to another command set for good
- (krobipd) Fixed: YNCA reads every word the official lists declare — an attenuated mute reads as muted, and repeat-one is written in the receiver's own word
- (krobipd) Fixed: A deleted device carried over from yamaha 0.5.x stays deleted, and a hostname in the device list works like an IP address
- (krobipd) New: Menus on the 2008 XML receivers (RX-V3900 generation); XML zones write tone and dialogue level the way the receiver declares them
- (krobipd) Changed: The first start after this update asks every receiver again what it can do — up to half a minute on a YNCA receiver, as on a first contact
- (krobipd) Improved: The README lists the ports the adapter uses; with the network search set to Never it opens no listener on UDP port 1900
- (krobipd) Changed: Settings left over from older versions are removed from the instance once after the update; the instance restarts once for it

### 2.12.0 (2026-09-22)

- (krobipd) Fixed: Deleting a device is final: the card asks first and names the datapoints, the device stays out of the search until you admit it again, and the log says how many datapoints went
- (krobipd) New: A device is known by its serial number: a receiver with a new IP address or a new name keeps its objects and is reconnected at the new address within seconds
- (krobipd) New: "Excluded devices…" above the device list shows the deleted devices and lets the network search admit a ticked one again — it says what it looks for and what it found
- (krobipd) Improved: A receiver that lost power is offline in about 90 seconds instead of up to 15 minutes: the first protocol that notices asks the others at once
- (krobipd) Improved: The adapter hears devices announcing themselves on the network, and while no device runs it keeps searching every five minutes
- (krobipd) Changed: A row carried over from the old adapter (name = IP) follows the receiver to a new address; a device entered by hand stays where it was typed, the log says if it answers elsewhere
- (krobipd) Improved: Switching a receiver off no longer fills the log with warnings, and every search the log announces also tells you what it found — or that nothing answered
- (krobipd) Improved: Less network noise while a receiver stays unreachable: the retries knock only on the protocols that device actually speaks, not on all three

### 2.11.0 (2026-09-17) — stable

- (krobipd) Fixed: The adapter no longer stops when the object database is briefly unavailable while a receiver reports a change
- (krobipd) Fixed: A datapoint whose value range a receiver no longer reports keeps its value, its history and its room and function assignments
- (krobipd) Fixed: A receiver that is switched off keeps its name after a restart
- (krobipd) Fixed: A name you type on a device card now wins over every name the receiver reports for itself
- (krobipd) Improved: When something goes wrong, the log names the cause instead of a placeholder

### 2.10.0 (2026-09-15)

- (krobipd) Fixed: A receiver the search found is searched for again after it moved to another address — until now that only worked for receivers found at start-up
- (krobipd) Fixed: A receiver that is unplugged or switched off at the mains now shows as disconnected within about 90 seconds instead of staying green for many minutes
- (krobipd) Fixed: A MusicCast device that stops answering a command is checked right away and shown as disconnected — until now that took up to 15 minutes
- (krobipd) Fixed: On receivers without live updates, a value you write is confirmed as soon as the receiver took it, instead of up to five minutes later
- (krobipd) Fixed: A zone name you changed on an older receiver stays after a reconnect — until now the previous name came back
- (krobipd) Fixed: Deleting a device from its card while it is still connecting no longer leaves parts of its object tree behind
- (krobipd) Fixed: Writing false, off or 0 to a switch datapoint now switches it off — until now any text, even the word false, switched it on
- (krobipd) Improved: The history of a datapoint only records values the receiver actually changed — a restart or a lost connection no longer adds identical entries
- (krobipd) Improved: MusicCast live updates now start on their own once a port another program held at start-up becomes free — before, only a restart helped
- (krobipd) New: Device pictograms in the object tree and on the device cards — receiver, stereo receiver, speaker, soundbar or CD system, readable in every theme, also for a device that is off
- (krobipd) Changed: The device card shows a speaker symbol; with the percent switch on it also shows the current volume as a percentage. The pencil and magnifier markers are gone
- (krobipd) Fixed: The adapter logo is readable in the Admin's dark themes as well — until now its dark strokes vanished on a dark background
- (krobipd) Changed: The instance settings show the fixed MusicCast event port, so the Admin warns when a second instance on the same host would take it

### 2.9.2 (2026-09-12)

- (krobipd) New: The device card shows a 0–100 % badge while that receiver's volume is in percent, so you can tell the two scales apart at a glance
- (krobipd) Fixed: The percent setting is made in one place again — the device's edit dialog; the extra switch on the card showed the wrong position and is gone

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

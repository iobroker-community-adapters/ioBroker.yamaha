# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.yamaha@main/admin/yamaha.svg" width="48" align="top" /> ioBroker.yamaha

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha) ![stable](https://iobroker.live/badges/yamaha-stable.svg) ![Installations](https://iobroker.live/badges/yamaha-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.yamaha/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.yamaha/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Controls Yamaha AV receivers and MusicCast devices from ioBroker over the local
network. It unites the three protocols Yamaha speaks — YNCA (the text control
protocol of the networked receivers), MusicCast / Yamaha Extended Control (the
richer JSON protocol of the MusicCast generation), and the legacy XML protocol
of the oldest pre-2010 models — behind one object tree.

## Features

- **One adapter for three protocols** — classic Yamaha AV receivers over YNCA, MusicCast devices over Yamaha Extended Control, and pre-2010 receivers over the legacy XML protocol, replacing the separate yamaha and musiccast adapters.
- **Self-healing connection** — a receiver that is off when the adapter starts joins on its own once it answers, and every connection recovers after a reboot or network drop, with a per-device connection indicator.
- **Rich, intelligently typed datapoints** — amplifier, tone control, HDMI output, DSP and decoder modes, sound programs, party mode, tuner with RDS, and network/USB/server/Spotify players; on/off is a boolean, fixed choices are dropdowns, numbers carry their unit and range.
- **Capability-driven object tree** — states are generated from what each device actually reports over its protocol, not from a hardcoded model list, and only for the functions it offers.
- **One transport chosen per device** — YNCA where the receiver speaks it, MusicCast for speakers and soundbars, XML for the oldest models.
- **Network discovery** — a search button finds Yamaha devices over SSDP and fills the device table.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- admin >= 7.8.23

## Installation

Install the adapter from the ioBroker admin.

## Configuration

Add each Yamaha device with a name and its IP address.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 0.8.0 (2026-08-04)
- Every value now arrives in a form you can use directly: on/off states are switches, fixed choices are dropdowns, and measurements are numbers with their unit — not raw text to interpret.
- Your receiver now shows and controls far more of what it can do — tone, DSP, HDMI and surround modes, AM/FM and DAB radio with RDS, and network, USB, server and CD playback with track details.
- MusicCast devices now show and control their tuner, CD player and the full amplifier — bass, treble, balance, direct and sleep — not just power, volume and input.
- Fixed the playback status never updating on network and USB sources, so play, pause and stop are now shown correctly, not just controllable.
- Track title, station and playback state now update the moment they change on the device, instead of only every minute or so.
- A receiver offline at adapter start joins on its own once it answers and reconnects after a drop, and each device shows its own connection state.

### 0.7.0 (2026-08-03)
- An existing receiver from the previous adapter is now carried over into the device table on upgrade instead of being lost.
- Receivers report and fill more datapoints at startup: added straight, enhancer, pure direct and the sleep timer, and existing states are now populated from the initial query.

### 0.6.0 (2026-08-01)
- Rebuilt from the ground up as one adapter for classic Yamaha AV receivers, MusicCast devices and the oldest pre-2010 receivers, replacing the separate yamaha and musiccast adapters.
- Each device is driven over the protocol it actually speaks — YNCA (with automatic reconnect after a reboot or network drop), MusicCast, or the legacy XML control protocol.
- Every device exposes power, volume, mute and input per zone, generated from what it actually reports rather than a hardcoded model list.
- Finds Yamaha devices on the network by itself: a search button in the settings fills the device table over SSDP.
- Now requires Node.js 22, js-controller 7 and admin 7.

### 0.5.4 (2024-06-14)
* (foxriver76) updated packages

### 0.5.3 (2022-06-17)
* (Apollon77) Fix crash cases reported by Sentry

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
- From this version on, [krobi](https://github.com/krobipd) rebuilds the adapter from
  the ground up in TypeScript, uniting the YNCA, MusicCast (YXC) and legacy XML
  protocols behind one object tree.

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

---

_Developed with assistance from Claude.ai_

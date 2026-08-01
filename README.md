# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.yamaha@main/admin/yamaha.svg" width="48" align="top" /> ioBroker.yamaha

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha) ![stable](https://iobroker.live/badges/yamaha-stable.svg) ![Installations](https://iobroker.live/badges/yamaha-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.yamaha)](https://www.npmjs.com/package/iobroker.yamaha)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.yamaha/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.yamaha/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Controls Yamaha AV receivers and MusicCast devices from ioBroker over the local
network. It unites the two protocol families Yamaha speaks — YNCA (the text
control protocol of the networked receivers) and MusicCast / Yamaha Extended
Control (the richer JSON protocol of the MusicCast generation) — behind one
object tree.

## Features

- **One adapter for two protocol families** — classic Yamaha AV receivers over YNCA and MusicCast devices over Yamaha Extended Control, replacing the separate yamaha and musiccast adapters.
- **Automatic reconnect** — the YNCA connection recovers on its own after a receiver reboot or a network drop, so control keeps working without restarting the adapter.
- **Per-zone amplifier control** — power, volume, mute, input and sound program for the main zone and each additional zone a device reports.
- **Capability-driven object tree** — states are generated from what each device actually reports over its protocol, not from a hardcoded model list.
- **One transport chosen per device** — YNCA where the receiver speaks it, MusicCast for the speakers and soundbars that do not.

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
### **WORK IN PROGRESS**
- Rebuilt from the ground up as one adapter for both classic Yamaha AV receivers (YNCA) and MusicCast devices, replacing the separate yamaha and musiccast adapters.
- Network AV receivers are controlled over YNCA with an automatic reconnect that recovers the connection on its own after a receiver reboot or a network drop.
- MusicCast speakers, soundbars and receivers are controlled over the MusicCast protocol with power, volume, mute, input and sound program per zone.
- Now requires Node.js 22, js-controller 6 and admin 7.

### 0.5.4 (2024-06-14)
* (foxriver76) updated packages

### 0.5.3 (2022-06-17)
* (Apollon77) Fix crash cases reported by Sentry

### 0.5.2 (2022-04-23)
* (Apollon77) Fix crash cases reported by Sentry

### 0.5.1 (2022-03-29)
* (Apollon77) Fix crash cases reported by Sentry
* (Sneak-L8) fix type of pureDirect

### 0.5.0 (2022-03-08)
* IMPORTANT: js-controller 2.0 is needed at least
* (Apollon77) Add Sentry for crash reporting

### 0.4.1
* (Sneak-L8) "toggleMute" now toggle mute state (instead of always muting)

### 0.4.0
* (Garfonso) added admin 3 compatibility and more meta-data stuff.
* (Garfonso) added compact mode support.

### 0.3.20
* (Garfonso) adjusted local copy of soef.js to js-controller 3.0
* (Garfonso) updated meta information (links etc) to iobroker-community-adapters

### 0.3.19
* (soef) Changelog added to readme

### 0.3.18
* (Apollon77) Update utils.js and usage, CI Testing and deps

### 0.3.17
* (Apollon77) update basic package-file testing

### 0.3.16
* (soef) node 0.12 removed from testing

### 0.3.15
* (soef) Enhance CI testing

### 0.3.14
* (soef) Possible exception in reconnect fixed

### 0.3.12
* (soef) Version incr. for npm

### 0.3.11
* (soef) reconnect overworked

### 0.3.10
* (soef) realtime Ping now configurable

### 0.3.8
* (soef) realtime states optimized

### 0.3.7
* (soef) fix typo in creating realtime states

### 0.3.6
* (soef) timeout to connect reduced

[Older changelogs can be found here](CHANGELOG_OLD.md)

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

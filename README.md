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
- **Capability-driven object tree** — states are generated from what each device actually reports over its protocols, not from a hardcoded model list, and only for the functions it offers.
- **Every protocol a device speaks runs together** — a MusicCast receiver keeps its YNCA amplifier control and adds its Yamaha Extended Control richness (multiroom, equalizer, media) on one object tree, instead of only one protocol being used per device.
- **Automatic discovery** — leave the device table empty and MusicCast devices are found on the network and set up on their own at startup; fill the table to pin specific devices instead.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- admin >= 7.8.23

## Installation

Install the adapter from the ioBroker admin.

## Configuration

**Leave the device table empty** and the adapter finds MusicCast devices on the network by itself at startup — nothing to enter. **Add devices** (name and IP address) to the table to use only those instead.

Older Yamaha receivers (before ~2010, the XML protocol) do not announce themselves on the network and must always be added to the table manually with their IP address. Once such a device is connected, an **XML query interval** field appears in the settings — these devices are polled rather than pushing their changes, and the default of 60 seconds is plenty for an AV receiver.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 0.13.0 (2026-08-12)

- For a MusicCast receiver, amplifier control and the MusicCast features — multiroom grouping, graphic equalizer and media playback — now appear together, where before only one side showed up.
- The amplifier connection now recovers on its own if it drops in the first moments after startup — previously such an early drop could leave it disconnected until the next restart.

### 0.12.0 (2026-08-11)

- Much more of your MusicCast device answers to ioBroker now — repeat and shuffle, the CD tray, the tuner, party mode and your saved presets all switch straight from the object tree.
- The graphic equalizer is yours to set now, not just to read — dial in its low, mid and high from ioBroker.
- Group your MusicCast speakers from ioBroker: see who is in a group, drop a device out of one, or pull another in so they play together.
- Streaming services such as Spotify, Tidal and Deezer now show the track you are playing, the same as your other sources.
- Older receivers can send a remote-control code again, so a scene can reach a button that has no datapoint of its own.

### 0.11.0 (2026-08-11)

- Scenes can now be triggered from ioBroker, not just shown by name — recall any scene on your receiver.
- Far more of the receiver is controllable now, from tone and subwoofer to the HDMI outputs and party mode, and MusicCast devices add repeat, shuffle, play time and cover art.
- Classic receivers can skip to the next or previous track on their network and USB players.
- Older pre-2010 receivers can again control their tone, subwoofer, Extra Bass, YPAO and HDMI outputs.
- The object tree is tidier: model and firmware now sit under the device's info, and the cluttered system folder is gone.
- Every device shows a green or red online symbol in the admin now, and leaving a device's name blank no longer makes it vanish.

### 0.10.0 (2026-08-05)

- You no longer have to add every device by hand — leave the device table empty and the adapter finds MusicCast receivers on its own at startup and sets them up.
- The settings page is clearer and follows the standard layout; the manual search button is gone because discovery now runs by itself.
- An older receiver from before 2010 can now have its update rate set, controlling how often it is checked for changes.

### 0.9.0 (2026-08-05)

- MusicCast and older XML receivers now report their connection correctly and reconnect on their own after a drop — as YNCA already did — instead of staying stuck on "connected".
- A multi-zone MusicCast receiver now keeps every zone up to date, not just the main one, so zones 2–4 no longer freeze when live updates pause.
- Datapoints are more consistent however a device connects, channel names read properly instead of raw ids, and volume carries its dB range everywhere.
- A stray empty or invalid write is no longer sent to the receiver as a bogus command, and the XML volume is read from the correct field instead of an unrelated value.

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

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
- **Automatic discovery** — leave the device list empty and MusicCast devices are found on the network and set up on their own at startup; add devices to run only those instead. The search covers every network interface, so a receiver is found even on a multi-homed host; an optional selector can confine it to one.
- **Device manager** — every receiver appears as a card in the admin showing its model, IP address and the protocols it is currently connected over, with a dialog to add one by IP.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- admin >= 7.8.23

## Installation

Install the adapter from the ioBroker admin.

## Configuration

Devices are managed in the admin as cards. **Leave the list empty** and the adapter finds MusicCast devices on the network by itself at startup — nothing to enter. Use the **"+" dialog** to add a device by IP address to run only those instead; each card shows the device's model, IP and the protocols it is connected over. Discovery searches on every network interface by default, so a receiver is found even on a host with several interfaces; the optional **network interface** selector confines the search to one if you prefer.

Older Yamaha receivers (before ~2010, the XML protocol) do not announce themselves on the network and must always be added manually with their IP address. The **XML query interval** in the settings sets how often these older receivers are polled — they push no changes of their own, and the default of 60 seconds is plenty for an AV receiver.

The **Data points** section switches whole groups of datapoints on or off — playback sources, tuner, extra zones, multiroom, HDMI, scenes, sound processing and advanced setup datapoints. Turn off what your receiver doesn't have or you don't use, and those objects are removed from the tree; the amplifier core (power, volume, mute, input, sound program, sleep) always stays on.

## Changelog

### **WORK IN PROGRESS**

- New Sound and Advanced datapoint groups, switchable like the others — tone/DSP controls and setup-only datapoints (initial/max volume, input labels) are no longer always on.
- Zone B, the all-zones power switch, party mode and per-zone HDMI/lip-sync now follow their matching Zones/Multiroom/HDMI toggle instead of always staying on.

### 0.15.0 (2026-08-13)

- The object tree is organised by theme now: streaming and playback sources sit under one player branch, DAB stays with the tuner, and multiroom is named clearly — far less to scroll through.
- You can switch whole datapoint groups off in the admin — the players, tuner, extra zones, multiroom, HDMI or scenes — so a receiver only carries the datapoints you actually use.
- Playback now shows up as a proper media player, so voice assistants and visualizations can read what is playing and drive transport, repeat and shuffle straight from ioBroker.
- Device discovery runs on every network interface now and uses all of them by default, so a receiver on a second network segment is found without picking an interface by hand.

### 0.14.0 (2026-08-12)

- The admin now shows your receivers as cards, each with the device's model, IP address and the protocols it is connected over, and a dialog to add a receiver by its IP.
- Every receiver reports its model now — MusicCast over Yamaha Extended Control and older sets over the XML protocol, not only the YNCA models.
- Discovery is steadier: the search repeats and can be confined to a chosen network interface, so a receiver on a multi-homed host or behind a dropped packet is still found.

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

# Older changes
## 0.9.0 (2026-08-05)

- MusicCast and older XML receivers now report their connection correctly and reconnect on their own after a drop — as YNCA already did — instead of staying stuck on "connected".
- A multi-zone MusicCast receiver now keeps every zone up to date, not just the main one, so zones 2–4 no longer freeze when live updates pause.
- Datapoints are more consistent however a device connects, channel names read properly instead of raw ids, and volume carries its dB range everywhere.
- A stray empty or invalid write is no longer sent to the receiver as a bogus command, and the XML volume is read from the correct field instead of an unrelated value.

## 0.8.0 (2026-08-04)

- Every value now arrives in a form you can use directly: on/off states are switches, fixed choices are dropdowns, and measurements are numbers with their unit — not raw text to interpret.
- Your receiver now shows and controls far more of what it can do — tone, DSP, HDMI and surround modes, AM/FM and DAB radio with RDS, and network, USB, server and CD playback with track details.
- MusicCast devices now show and control their tuner, CD player and the full amplifier — bass, treble, balance, direct and sleep — not just power, volume and input.
- Fixed the playback status never updating on network and USB sources, so play, pause and stop are now shown correctly, not just controllable.
- Track title, station and playback state now update the moment they change on the device, instead of only every minute or so.
- A receiver offline at adapter start joins on its own once it answers and reconnects after a drop, and each device shows its own connection state.

## 0.7.0 (2026-08-03)

- An existing receiver from the previous adapter is now carried over into the device table on upgrade instead of being lost.
- Receivers report and fill more datapoints at startup: added straight, enhancer, pure direct and the sleep timer, and existing states are now populated from the initial query.

## 0.6.0 (2026-08-01)

- Rebuilt from the ground up as one adapter for classic Yamaha AV receivers, MusicCast devices and the oldest pre-2010 receivers, replacing the separate yamaha and musiccast adapters.
- Each device is driven over the protocol it actually speaks — YNCA (with automatic reconnect after a reboot or network drop), MusicCast, or the legacy XML control protocol.
- Every device exposes power, volume, mute and input per zone, generated from what it actually reports rather than a hardcoded model list.
- Finds Yamaha devices on the network by itself: a search button in the settings fills the device table over SSDP.
- Now requires Node.js 22, js-controller 7 and admin 7.

## 0.5.4 (2024-06-14)

- (foxriver76) updated packages

## 0.5.3 (2022-06-17)

- (Apollon77) Fix crash cases reported by Sentry

## 0.5.2 (2022-04-23)
* (Apollon77) Fix crash cases reported by Sentry

## 0.5.1 (2022-03-29)
* (Apollon77) Fix crash cases reported by Sentry
* (Sneak-L8) fix type of pureDirect

## 0.5.0 (2022-03-08)
* IMPORTANT: js-controller 2.0 is needed at least
* (Apollon77) Add Sentry for crash reporting

## 0.4.1
* (Sneak-L8) "toggleMute" now toggle mute state (instead of always muting)

## 0.4.0
* (Garfonso) added admin 3 compatibility and more meta-data stuff.
* (Garfonso) added compact mode support.

## 0.3.20
* (Garfonso) adjusted local copy of soef.js to js-controller 3.0
* (Garfonso) updated meta information (links etc) to iobroker-community-adapters

## 0.3.19
* (soef) Changelog added to readme

## 0.3.18
* (Apollon77) Update utils.js and usage, CI Testing and deps

## 0.3.17
* (Apollon77) update basic package-file testing

## 0.3.16
* (soef) node 0.12 removed from testing

## 0.3.15
* (soef) Enhance CI testing

## 0.3.14
* (soef) Possible exception in reconnect fixed

## 0.3.12
* (soef) Version incr. for npm

## 0.3.11
* (soef) reconnect overworked

## 0.3.10
* (soef) realtime Ping now configurable

## 0.3.8
* (soef) realtime states optimized

## 0.3.7
* (soef) fix typo in creating realtime states

## 0.3.6
* (soef) timeout to connect reduced

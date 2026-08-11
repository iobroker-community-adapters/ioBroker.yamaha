# Older changes
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

# Older changes
## 0.5.0 (2022-03-08)

- IMPORTANT: js-controller 2.0 is needed at least
- (Apollon77) Add Sentry for crash reporting

## 0.4.1

- (Sneak-L8) "toggleMute" now toggle mute state (instead of always muting)

## 0.20.0 (2026-08-18)

- MusicCast changes now arrive instantly again: the adapter registers for the devices' push events — track, volume and multiroom updates no longer wait for the next 5-minute poll.
- Much faster startup and reconnects: the adapter first asks the receiver which sections it has and queries only those; switched-off datapoint groups are skipped entirely.
- A short outage of one protocol no longer tears down the whole device — the affected protocol reconnects on its own while the others keep running.
- The Next/Previous buttons of the classic receivers' streaming sources (Spotify, USB, Net Radio, …) are now actually created — they were missing on real devices.
- Pre-2010 (XML) receivers: bass, treble and subwoofer trim now read and write real decibels — values were off by a factor of 10 (untested on hardware, feedback welcome).
- A failed multiroom link/leave and a device skipped over a duplicate name no longer pass silently, and the add-device dialog tells a name clash apart from an invalid IP address.

## 0.19.0 (2026-08-18)

- Zone 2/3/4, Zone B and party mode datapoints now sit in the Multiroom folder — scripts using old paths like zone2.power need updating to multiroom.zone2.power.
- You now see at startup which devices are being set up and when each one is ready.

## 0.18.0 (2026-08-17)

- Zone 2/3/4 and Zone B now sit under the Multiroom toggle — the separate Zones checkbox is gone, because zone switching was always part of multiroom.
- Dialogue lift is adjustable again on receivers that report it — a routing issue had left it read-only.
- MusicCast speakers without a classic amplifier connection now get the Sound and Advanced folders they were missing.
- Subwoofer trim shows its dB unit, and playback labels are now consistently capitalized.

## 0.17.0 (2026-08-13)

- Sound and Advanced datapoints now sit in a real folder matching their admin toggle, the same way playback, tuner, HDMI, multiroom and scenes already do — no longer visually stuck next to power/volume.
- Fixed: switching the Zones toggle off did not remove the `zone2`/`zone3`/`zone4` folder.

## 0.16.0 (2026-08-13)

- New Sound and Advanced datapoint groups, switchable like the others — tone/DSP controls and setup-only datapoints (initial/max volume, input labels) are no longer always on.
- Zone B, the all-zones power switch, party mode and per-zone HDMI/lip-sync now follow their matching Zones/Multiroom/HDMI toggle instead of always staying on.
- A receiver that stays offline no longer spams the log — the first drop still warns, repeated retries stay quiet until it reconnects.

## 0.15.0 (2026-08-13)

- The object tree is organised by theme now: streaming and playback sources sit under one player branch, DAB stays with the tuner, and multiroom is named clearly — far less to scroll through.
- You can switch whole datapoint groups off in the admin — the players, tuner, extra zones, multiroom, HDMI or scenes — so a receiver only carries the datapoints you actually use.
- Playback now shows up as a proper media player, so voice assistants and visualizations can read what is playing and drive transport, repeat and shuffle straight from ioBroker.
- Device discovery runs on every network interface now and uses all of them by default, so a receiver on a second network segment is found without picking an interface by hand.

## 0.14.0 (2026-08-12)

- The admin now shows your receivers as cards, each with the device's model, IP address and the protocols it is connected over, and a dialog to add a receiver by its IP.
- Every receiver reports its model now — MusicCast over Yamaha Extended Control and older sets over the XML protocol, not only the YNCA models.
- Discovery is steadier: the search repeats and can be confined to a chosen network interface, so a receiver on a multi-homed host or behind a dropped packet is still found.

## 0.13.0 (2026-08-12)

- For a MusicCast receiver, amplifier control and the MusicCast features — multiroom grouping, graphic equalizer and media playback — now appear together, where before only one side showed up.
- The amplifier connection now recovers on its own if it drops in the first moments after startup — previously such an early drop could leave it disconnected until the next restart.

## 0.12.0 (2026-08-11)

- Much more of your MusicCast device answers to ioBroker now — repeat and shuffle, the CD tray, the tuner, party mode and your saved presets all switch straight from the object tree.
- The graphic equalizer is yours to set now, not just to read — dial in its low, mid and high from ioBroker.
- Group your MusicCast speakers from ioBroker: see who is in a group, drop a device out of one, or pull another in so they play together.
- Streaming services such as Spotify, Tidal and Deezer now show the track you are playing, the same as your other sources.
- Older receivers can send a remote-control code again, so a scene can reach a button that has no datapoint of its own.

## 0.11.0 (2026-08-11)

- Scenes can now be triggered from ioBroker, not just shown by name — recall any scene on your receiver.
- Far more of the receiver is controllable now, from tone and subwoofer to the HDMI outputs and party mode, and MusicCast devices add repeat, shuffle, play time and cover art.
- Classic receivers can skip to the next or previous track on their network and USB players.
- Older pre-2010 receivers can again control their tone, subwoofer, Extra Bass, YPAO and HDMI outputs.
- The object tree is tidier: model and firmware now sit under the device's info, and the cluttered system folder is gone.
- Every device shows a green or red online symbol in the admin now, and leaving a device's name blank no longer makes it vanish.

## 0.10.0 (2026-08-05)

- You no longer have to add every device by hand — leave the device table empty and the adapter finds MusicCast receivers on its own at startup and sets them up.
- The settings page is clearer and follows the standard layout; the manual search button is gone because discovery now runs by itself.
- An older receiver from before 2010 can now have its update rate set, controlling how often it is checked for changes.

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

## 0.4.0

- (Garfonso) added admin 3 compatibility and more meta-data stuff.
- (Garfonso) added compact mode support.

## 0.3.20

- (Garfonso) adjusted local copy of soef.js to js-controller 3.0
- (Garfonso) updated meta information (links etc) to iobroker-community-adapters

## 0.3.19

- (soef) Changelog added to readme

## 0.3.18

- (Apollon77) Update utils.js and usage, CI Testing and deps

## 0.3.17

- (Apollon77) update basic package-file testing

## 0.3.16

- (soef) node 0.12 removed from testing

## 0.3.15

- (soef) Enhance CI testing

## 0.3.14

- (soef) Possible exception in reconnect fixed

## 0.3.12

- (soef) Version incr. for npm

## 0.3.11

- (soef) reconnect overworked

## 0.3.10

- (soef) realtime Ping now configurable

## 0.3.8

- (soef) realtime states optimized

## 0.3.7

- (soef) fix typo in creating realtime states

## 0.3.6

- (soef) timeout to connect reduced

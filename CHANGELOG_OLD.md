# Older changes
## 2.0.1 (2026-09-01)

- (krobipd) Fixed: devices on the oldest protocol no longer get datapoints their status never delivers — states are only created for what the device really answers, like on the other two protocols
- (krobipd) Fixed: leftover datapoints that never carried a value — zone sound settings or a second HDMI output the receiver does not have — are cleaned away once when updating the adapter
- (krobipd) Fixed: the player block of a zone that is not playing a media source starts with cleared values (empty texts, playback on stop) instead of staying without any value until the first playback
- (krobipd) Fixed: the two DAB station-scan datapoints (stations found, scan progress) start at zero instead of staying without a value until the first station scan

## 2.0.0 (2026-09-01)

- (krobipd) Changed: one player block per zone now shows what is playing — source, title, artist, cover art and the transport buttons — instead of an identical, mostly empty block under every source
- (krobipd) Changed: the scene name datapoints are gone — the recall dropdown carries the receiver's own titles, and scene.list offers every scene with number and title for visualizations
- (krobipd) Changed: the tuner has one band, one frequency (kHz on every generation) and one preset for AM, FM and DAB; only genuinely DAB-specific detail stays under tuner.dab
- (krobipd) Changed: the equalizer and the audio-signal info moved into their own folders under sound, the lip-sync offsets into hdmi, the speaker A/B switches to the speaker settings
- (krobipd) New: zones can show different programs — zones 2 to 4 get their own player block, and play/pause/skip always act on whatever that zone is playing
- (krobipd) Fixed: the on-screen remote keys and the tuner preset stepping on MusicCast devices count as button presses again — they no longer wait behind a running background refresh
- (krobipd) Fixed: restarting or updating the adapter while a receiver was still connecting no longer produces shutdown warnings about timers in the log

## 1.7.0 (2026-09-01)

- (krobipd) Fixed: scene recall now uses the command each device declares itself and the protocol that can deliver it — on 2012-generation receivers a scene write did nothing at all (#615)
- (krobipd) New: scenes show their titles ("Movie Viewing", …) as datapoints and in the recall dropdown, and zones with their own scenes get their own scene recall
- (krobipd) Fixed: the menu back button falls back to the older cursor command when a device refuses the standard one, so leaving a folder works on 2012-generation receivers too (#613)
- (krobipd) New: the adapter now reports when the receiver refuses a command, including the device's own answer — a dead button no longer fails without a trace
- (krobipd) New: bass and treble on MusicCast-generation receivers over YNCA, dialogue level, DAB signal details, the paired Bluetooth device name and more — the device is asked in its own dialect
- (krobipd) New: on-screen remote control datapoints (cursor pad and menu keys), the current audio signal info, MusicCast playlists and the play queue on MusicCast devices
- (krobipd) New: receivers from before 2010 get their tuner back — preset recall, frequency and radio text — and every input dropdown lists exactly the inputs the device really has
- (krobipd) New: the receiver's IP address is shown as a datapoint, so diagnosis and the device's own web pages are one click away
- (krobipd) Improved: restarts are fast — the adapter remembers what each device can do, brings it online in seconds and refreshes values in the background; only the first contact asks everything
- (krobipd) Improved: known devices no longer wait for the network search at startup — it runs in the background and only adds newcomers

## 1.6.0 (2026-08-27)

- (krobipd) New: three states show how many receivers are set up, how many are connected right now and whether that is all of them — one line to watch instead of every device
- (krobipd) Fixed: a receiver kept showing as connected while the adapter was stopped, and after a crash it stayed that way until it answered again — both now show the truth

## 1.5.0 (2026-08-27)

- (krobipd) Fixed: menu browsing now works on receivers that serve their menus over the old XML protocol — the adapter no longer claims the menu datapoints on devices that cannot deliver them (#613)
- (krobipd) Fixed: a MusicCast device that loses power is now reported as offline instead of still showing a connection, so the ready message and the connection indicator tell the truth
- (krobipd) New: switching a datapoint group on or off in the settings now shows how many datapoints appeared or disappeared, so you no longer have to click through the object tree to check
- (krobipd) New: optional error reporting via Sentry — only active if you enabled diagnostics in ioBroker, and it transmits no personal data

## 1.4.0 (2026-08-26)

- (krobipd) Fixed: commands sent in quick succession all arrive — a scene switching power, input and volume in one go used to lose everything after the first command
- (krobipd) Fixed: a command the device rejects is now reported instead of counting as success, so a MusicCast device that stops answering is reconnected rather than silently freezing
- (krobipd) Fixed: names and menu entries containing "&" or other special characters now read and write correctly on the older XML protocol
- (krobipd) Fixed: writing one equalizer band no longer resets the other two when the device has not reported its bands yet
- (krobipd) Fixed: switching the tuner band and setting a frequency right after each other now applies the frequency to the new band
- (krobipd) Improved: startup with automatic discovery is much faster on networks with many devices, and a reconnect no longer re-asks what the device already told us
- (krobipd) Fixed: recalling a favourite, a recently played item or a tuner preset now goes to the zone that is actually listening instead of always switching the main zone
- (krobipd) Improved: stopping or restarting the adapter no longer leaves requests running that write to datapoints afterwards

## 1.3.0 (2026-08-26)

- (krobipd) New: menu browsing — page through the Net Radio, server and USB menus like with the remote: visible lines as datapoints, select-by-line, and a path datapoint for one-write navigation (#613)
- (krobipd) New: save presets from ioBroker — store the current tuner or network station to a preset slot and bookmark the playing Net Radio station on YNCA receivers.
- (krobipd) New: Bluetooth pairing and connect controls, FM mono mode and tuning indicators on YNCA receivers.

## 1.2.0 (2026-08-25)

- (krobipd) Fixed: volume writes work again — a written -38 dB reached the receiver as -3.8 dB, so most values were ignored; all numeric controls now send the proper wire format (#612)
- (krobipd) Fixed: the FM frequency datapoint now shows MHz (it was mislabelled kHz) and accepts direct frequency writes in the form the tuner expects.
- (krobipd) New: preset selection — recall tuner presets by number with up/down stepping, and recall stored network or USB favourites per source on YNCA receivers (#613)
- (krobipd) New: MusicCast selection lists — stored favourites and tuner presets with names, a recently-played list with recall by number, and the device's own allowed values as dropdowns.
- (krobipd) New: more device detail — CD track and drive info, DAB and RDS station data, and a read-only clock and alarm view with its own datapoint group switch in the admin settings.

## 1.1.1 (2026-08-22)

- (krobipd) Changed: Internal cleanup. No user-facing changes.

## 1.1.0 (2026-08-22)

- (krobipd) Fixed: a device carried over from the old adapter is no longer called by its IP — the object folder and the admin card now show the name the device reports, or its model.
- (krobipd) Improved: a device that has not reported a model yet already carries its device-class symbol instead of none.

## 1.0.1 (2026-08-22)

- (krobipd) Complete rebuild: one adapter now speaks YNCA, MusicCast and the legacy XML protocol — every protocol a device answers runs in parallel on one object tree.
- (krobipd) New object tree with typed datapoints built from what your device reports. Old datapoints are removed automatically, the address is carried over — point scripts at the new paths.
- (krobipd) Instant updates: MusicCast push events and the live YNCA connection replace polling; connections heal themselves, and one protocol's hiccup reconnects just that protocol.
- (krobipd) Auto-discovery sets up MusicCast devices by itself when the device list is empty, and the admin shows every receiver as a card with model, address and protocol indicators.
- (krobipd) Whole datapoint groups such as playback sources, tuner, multiroom or scenes can be switched off in the admin — and are then not even queried from the device.
- (krobipd) The multiroom folder tells the scope at a glance: switches that affect all zones say so in their name, and the MusicCast device group has its own `multiroom.group` folder.
- (krobipd) Every device shows a type icon — receiver, stereo receiver, speaker, soundbar or CD system, detected from the reported model — in the object tree and on its admin card; the adapter logo now stays readable in light and dark mode.
- (krobipd) Upgrading from 0.5.x shows a one-time notice explaining the new object tree before the update installs.
- (mcm1957) version has been rebuilt due to deploy problems

## 0.5.4 (2024-06-14) — stable

- (foxriver76) updated packages

## 0.5.3 (2022-06-17)

- (Apollon77) Fix crash cases reported by Sentry

## 0.5.2 (2022-04-23)

- (Apollon77) Fix crash cases reported by Sentry

## 0.5.1 (2022-03-29)

- (Apollon77) Fix crash cases reported by Sentry
- (Apollon77) fix type of pureDirect

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

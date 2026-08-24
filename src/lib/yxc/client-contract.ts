/**
 * The YXC (MusicCast) client surface the adapter drives — one contract shared by the
 * real {@link import("./http-client").YamahaYxcClient}, the catalog's write mappings,
 * the command mapper and the tests' fakes. Lives in its own module so the catalog can
 * type its `write.apply` functions against it without importing the controller.
 */
export interface YxcClientLike {
  /** Read the device's capabilities (zones, functions, inputs, ranges). */
  getFeatures(): Promise<unknown>;
  /** Read a zone's current status. */
  getStatus(zone: string): Promise<unknown>;
  /** Read the device's system info (model name, firmware). */
  getDeviceInfo(): Promise<unknown>;
  /** Read the zone and input names a user gave the device in the MusicCast app. */
  getNameText(): Promise<unknown>;
  /**
   * Read a player source's play info. `undefined` reads the network/USB player,
   * `"cd"` the disc player, `"tuner"` the tuner (band/frequency/RDS).
   */
  getPlayInfo(source?: string): Promise<unknown>;
  /** Set a zone's power. */
  power(on: boolean, zone: string): Promise<unknown>;
  /** Set a zone's absolute volume (raw YXC scale). */
  setVolumeTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's mute. */
  mute(on: boolean, zone: string): Promise<unknown>;
  /** Select a zone's input. */
  setInput(input: string, zone: string): Promise<unknown>;
  /** Select a zone's sound program. */
  setSound(program: string, zone: string): Promise<unknown>;
  /** Turn a zone's enhancer on/off. */
  setEnhancer(on: boolean, zone: string): Promise<unknown>;
  /** Turn a zone's pure direct on/off. */
  setPureDirect(on: boolean, zone: string): Promise<unknown>;
  /** Set a zone's subwoofer trim. */
  setSubwooferVolumeTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's tone-control bass. */
  setBassTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's tone-control treble. */
  setTrebleTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's sleep timer in minutes. */
  sleep(minutes: number, zone: string): Promise<unknown>;
  /** Turn a zone's Direct mode on/off. */
  setDirect(on: boolean, zone: string): Promise<unknown>;
  /** Turn a zone's Clear Voice on/off. */
  setClearVoice(on: boolean, zone: string): Promise<unknown>;
  /** Turn a zone's bass extension on/off. */
  setBassExtension(on: boolean, zone: string): Promise<unknown>;
  /** Set a zone's balance. */
  setBalance(value: number, zone: string): Promise<unknown>;
  /** Set the manual equalizer's three bands (low/mid/high) in one call. */
  setEqualizer(low: number, mid: number, high: number, zone: string): Promise<unknown>;
  /** Start the network/USB player. */
  playNet(): Promise<unknown>;
  /** Pause the network/USB player. */
  pauseNet(): Promise<unknown>;
  /** Stop the network/USB player. */
  stopNet(): Promise<unknown>;
  /** Skip to the next track. */
  nextNet(): Promise<unknown>;
  /** Skip to the previous track. */
  prevNet(): Promise<unknown>;
  /** Drive the CD transport with a YXC action word (`play`, `pause`, `stop`, `next`, `previous`). */
  setCDPlayback(action: string): Promise<unknown>;
  /** Toggle network/USB repeat. */
  toggleNetRepeat(): Promise<unknown>;
  /** Toggle network/USB shuffle. */
  toggleNetShuffle(): Promise<unknown>;
  /** Toggle CD repeat. */
  toggleCDRepeat(): Promise<unknown>;
  /** Toggle CD shuffle. */
  toggleCDShuffle(): Promise<unknown>;
  /** Open/close the CD tray. */
  toggleTray(): Promise<unknown>;
  /** Set the tuner band. */
  setBand(band: string): Promise<unknown>;
  /** Set the tuner frequency for a band. */
  setFreq(band: string, freq: number): Promise<unknown>;
  /** Turn party mode on/off. */
  setPartyMode(on: boolean): Promise<unknown>;
  /** Recall a network/USB preset. */
  recallPreset(num: number, zone: string): Promise<unknown>;
  /** Read the stored network/USB favourites (preset slots with names). */
  getPresetInfo(): Promise<unknown>;
  /** Read the recently played network/USB items. */
  getRecentInfo(): Promise<unknown>;
  /** Recall an entry from the recently-played list. */
  recallRecentItem(num: number, zone: string): Promise<unknown>;
  /** Read the tuner preset list for one band. */
  getTunerPresetInfo(band: string): Promise<unknown>;
  /** Recall a tuner preset on a band. */
  recallTunerPreset(band: string, num: number, zone: string): Promise<unknown>;
  /** Step to the next/previous stored tuner preset. */
  switchTunerPreset(direction: "next" | "previous"): Promise<unknown>;
  /** Read the clock/alarm settings block. */
  getClockSettings(): Promise<unknown>;
  /** Read the MusicCast-Link distribution info (role, group, client list). */
  getDistributionInfo(): Promise<unknown>;
  /** Set the group master's client roster (link/unlink sequence). */
  setServerInfo(info: {
    group_id: string;
    zone: string;
    type: "add" | "remove";
    client_list: string[];
  }): Promise<unknown>;
  /** Set a group member's membership (link/unlink sequence). */
  setClientInfo(info: { group_id: string; zone: string[] }): Promise<unknown>;
  /** Start distributing to the group's clients (called on the master). */
  startDistribution(num: number): Promise<unknown>;
  /** Stop distributing, breaking up the group (called on the master). */
  stopDistribution(): Promise<unknown>;
}

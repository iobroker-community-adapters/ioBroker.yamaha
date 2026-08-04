/**
 * Minimal type surface for the CommonJS `yamaha-yxc-nodejs` package (3.2.1),
 * which ships no types. Only the methods the adapter actually calls are
 * declared here — a full surface declaration would be dead weight to keep true.
 */
declare module "yamaha-yxc-nodejs" {
  /** HTTP client for one Yamaha MusicCast (YXC) device. */
  export class YamahaYXC {
    /**
     * @param ip the device ip, optionally as `ip:port` (the port form is used by the mock server)
     * @param requestTimeout per-request timeout in milliseconds
     */
    constructor(ip?: string, requestTimeout?: number);
    /** Query the device's capabilities (zones, functions, inputs, value ranges). */
    getFeatures(): Promise<unknown>;
    /**
     * Read a zone's current status (power, volume, mute, input, sound_program).
     *
     * @param zone the zone (`main`, `zone2`, …); defaults to main
     */
    getStatus(zone?: string): Promise<unknown>;
    /** Read device info (model, device_id). */
    getDeviceInfo(): Promise<unknown>;
    /**
     * Set a zone's power.
     *
     * @param on `true`/`"on"` powers on, anything else standby
     * @param zone the zone; defaults to main
     */
    power(on: boolean | string, zone?: string): Promise<unknown>;
    /**
     * Set a zone's absolute volume on the raw YXC scale (an integer, not decibels).
     *
     * @param to the raw volume value
     * @param zone the zone; defaults to main
     */
    setVolumeTo(to: number, zone?: string): Promise<unknown>;
    /**
     * Set a zone's mute.
     *
     * @param on `true`/`"true"` mutes, anything else unmutes
     * @param zone the zone; defaults to main
     */
    mute(on: boolean | string, zone?: string): Promise<unknown>;
    /**
     * Select a zone's input.
     *
     * @param input the input id (from the zone's input_list)
     * @param zone the zone; defaults to main
     */
    setInput(input: string, zone?: string): Promise<unknown>;
    /**
     * Select a zone's sound program. The method is named `setSound` even though the
     * underlying YXC command is `setSoundProgram` — do not "correct" the name.
     *
     * @param program the sound-program id
     * @param zone the zone; defaults to main
     */
    setSound(program: string, zone?: string): Promise<unknown>;
    /**
     * Turn a zone's Compressed Music Enhancer on or off.
     *
     * @param on whether the enhancer is on
     * @param zone the zone; defaults to main
     */
    setEnhancer(on: boolean, zone?: string): Promise<unknown>;
    /**
     * Turn a zone's Pure Direct mode on or off.
     *
     * @param on whether pure direct is on
     * @param zone the zone; defaults to main
     */
    setPureDirect(on: boolean, zone?: string): Promise<unknown>;
    /**
     * Read a player source's play info (playback, artist, album, track; for the
     * tuner: band/frequency/RDS). The one method serves every source.
     *
     * @param source `"cd"` reads the disc player, `"tuner"` the tuner, omitted the network/USB player
     */
    getPlayInfo(source?: string): Promise<unknown>;
    /**
     * Set a zone's subwoofer trim.
     *
     * @param to the subwoofer trim value
     * @param zone the zone; defaults to main
     */
    setSubwooferVolumeTo(to: number, zone?: string): Promise<unknown>;
    /** Start playback on the network/USB player. */
    playNet(): Promise<unknown>;
    /** Pause the network/USB player. */
    pauseNet(): Promise<unknown>;
    /** Stop the network/USB player. */
    stopNet(): Promise<unknown>;
    /** Skip to the next track on the network/USB player. */
    nextNet(): Promise<unknown>;
    /** Skip to the previous track on the network/USB player. */
    prevNet(): Promise<unknown>;
    /**
     * Drive the CD transport. Takes a YXC action word — `play`, `pause`, `stop`,
     * `next`, `previous` (also `play_pause`, `fast_reverse_start/end`, …).
     *
     * @param action the transport action word
     */
    setCDPlayback(action: string): Promise<unknown>;
  }
}

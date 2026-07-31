import type { DeviceRecord } from "./types";

/**
 * In-memory store of the configured devices, keyed by id. The command-router and
 * transport clients look devices up here; discovery/config fill it on startup.
 */
export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();

  /**
   * Insert a device, or replace the existing one with the same id.
   *
   * @param device the device record to store
   */
  public upsert(device: DeviceRecord): void {
    this.devices.set(device.id, device);
  }

  /**
   * Look a device up by id.
   *
   * @param id the device id
   * @returns the device record, or undefined if none is registered
   */
  public get(id: string): DeviceRecord | undefined {
    return this.devices.get(id);
  }
}

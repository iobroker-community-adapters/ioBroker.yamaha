// The admin side of the `diagnostics` message (backend: src/lib/diagnostics/diagnostics-handler.ts).
// Kept free of React and socket-client imports so it stays a pure, testable factory: the only
// dependency is a `sendTo` method. The answer shapes are re-declared here as types — they MUST stay
// in step with the handler.

import { errText } from "../../src/lib/err-text";

/** One device as the handler lists it. */
export interface DiagnosticsDevice {
  /** The device id. */
  value: string;
  /** What the card shows. */
  label: string;
  /** Whether it is connected — an unconnected one gets a report without the live read. */
  connected: boolean;
}

/** A finished report: the file name and the JSON text. */
export interface DiagnosticsReport {
  fileName: string;
  content: string;
}

/** What the export action answers. */
export type DiagnosticsExportResult = DiagnosticsReport | { error: string };

/** The admin socket's `sendTo`. */
export interface DiagnosticsSocket {
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

/** Thrown when the device list could not be fetched — an empty list and a broken call never look alike. */
export class DeviceListError extends Error {}

/** The two operations the card drives. */
export interface DiagnosticsApi {
  /** Every device the instance runs, connected or not. */
  listDevices(): Promise<DiagnosticsDevice[]>;
  /** Read one device and get its report back. */
  exportReport(device: string): Promise<DiagnosticsExportResult>;
}

/**
 * Whether an export answer carries a report.
 *
 * @param r the answer
 */
export function isReport(r: DiagnosticsExportResult): r is DiagnosticsReport {
  return typeof (r as DiagnosticsReport).fileName === "string" && typeof (r as DiagnosticsReport).content === "string";
}

/**
 * Build the API for one admin socket and instance.
 *
 * @param socket the admin socket
 * @param namespace the instance, e.g. `yamaha.0`
 */
export function makeDiagnosticsApi(socket: DiagnosticsSocket, namespace: string): DiagnosticsApi {
  return {
    async listDevices(): Promise<DiagnosticsDevice[]> {
      let answer: unknown;
      try {
        answer = await socket.sendTo(namespace, "diagnostics", { action: "list" });
      } catch (e) {
        throw new DeviceListError(errText(e));
      }
      const devices = (answer as { devices?: unknown } | null)?.devices;
      if (!Array.isArray(devices)) {
        const error = (answer as { error?: unknown } | null)?.error;
        throw new DeviceListError(typeof error === "string" ? error : "");
      }
      return devices as DiagnosticsDevice[];
    },
    async exportReport(device: string): Promise<DiagnosticsExportResult> {
      const answer = await socket.sendTo(namespace, "diagnostics", { action: "export", device });
      if (answer && typeof answer === "object" && (isReport(answer as DiagnosticsExportResult) || "error" in answer)) {
        return answer as DiagnosticsExportResult;
      }
      return { error: "" };
    },
  };
}

import { buildCapabilities, type YncaCapabilities } from "../capability";
import { decodeLine } from "../protocol";
import type { YncaMessage } from "../protocol";

/**
 * Build a capability report straight from recorded device lines — a TEST helper.
 *
 * Production never takes this path: the client decodes lines as they arrive and hands the
 * collected messages to `buildCapabilities`. Keeping the shortcut in the production module
 * meant an exported function no running adapter ever called, so it lives with the fixtures
 * that need it.
 *
 * @param lines response lines as recorded from a receiver
 * @returns the assembled capabilities
 */
export function capabilitiesFromLines(lines: string[]): YncaCapabilities {
  const messages: YncaMessage[] = [];
  for (const line of lines) {
    const response = decodeLine(line);
    if (response.status === "ok") {
      messages.push({ subunit: response.subunit, func: response.func, value: response.value });
    }
  }
  return buildCapabilities(messages);
}

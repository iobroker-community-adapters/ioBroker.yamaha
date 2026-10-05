import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Y-11: no adapter uninstalls another one. The product code reaches no other adapter's instance: it reads and writes
// only its own instance object, runs no host command and starts no process. One exception (krobi 2026-10-05 22:47
// "y11 fits with exactly this one exception for the diagnostics log"): the diagnostics report READS
// `system.adapter.musiccast*` in `diagnostics-handler.ts` — any other file, and any write, stays forbidden.

const DIAGNOSTICS = join("lib", "diagnostics", "diagnostics-handler.ts");

const SRC = join(__dirname, "..");

/** Every production source file: no test, no guard, no captured device data. */
function productionSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "decisions" && entry.name !== "__fixtures__") {
          walk(path);
        }
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({ file: relative(SRC, path), text: readFileSync(path, "utf-8") });
      }
    }
  };
  walk(SRC);
  return out;
}

describe("Y-11 no adapter uninstalls another one", () => {
  const sources = productionSources();

  test("the scan sees the adapter's sources", () => {
    expect(sources.map(s => s.file)).toEqual(expect.arrayContaining(["main.ts", "device-management.ts"]));
  });

  test("every instance object the code names is its own — except musiccast, in the diagnostics handler only", () => {
    const foreign: string[] = [];
    let diagnosticsReadsMusiccast = false;
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/system\.adapter\.([^\s"'`]*)/g)) {
        const rest = match[1];
        const own =
          rest.startsWith("${this.namespace}") ||
          rest.startsWith("${this.adapter.namespace}") ||
          rest.startsWith("${adapter.namespace}") ||
          rest.startsWith("<ns>");
        const diagnostics = file === DIAGNOSTICS && /^musiccast(?:\.|$)/.test(rest);
        diagnosticsReadsMusiccast ||= diagnostics;
        if (!own && !diagnostics) {
          foreign.push(`${file}: system.adapter.${rest}`);
        }
      }
    }
    expect(foreign).toEqual([]);
    // Positive control: the scan does see the one exception, so it is not passing on an empty match.
    expect(diagnosticsReadsMusiccast).toBe(true);
  });

  test("the diagnostics handler writes, starts and stops nothing", () => {
    const text = sources.find(s => s.file === DIAGNOSTICS)?.text ?? "";
    expect(text).not.toBe("");
    const writes = [
      /\b(?:set|extend|del)Foreign(?:Object|State)\w*\s*\(/,
      /\b(?:setState|setObject|extendObject|delObject)\w*\s*\(/,
      /\bsendTo(?:Host)?(?:Async)?\s*\(/,
      /\b(?:startInstance|stopInstance|restart)\s*\(/,
    ];
    expect(writes.filter(pattern => pattern.test(text)).map(pattern => pattern.source)).toEqual([]);
    // What it is handed can only read: every method of the host it talks through is a read (or the adapter's own
    // log, port and device list).
    const host = /export interface DiagnosticsHost \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    const methods = [...host.matchAll(/^\s{2}(\w+)\??\(/gm)].map(match => match[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.filter(name => !/^get/.test(name) && !["pushPort", "devices"].includes(name))).toEqual([]);
  });

  test("no other adapter's namespace, no host command, no child process", () => {
    const findings: string[] = [];
    for (const { file, text } of sources) {
      for (const pattern of [/\bmusiccast\.\d/, /\bsendToHost(?:Async)?\s*\(/, /child_process/, /\bcmdExec\b/]) {
        if (pattern.test(text)) {
          findings.push(`${file}: ${pattern.source}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });
});

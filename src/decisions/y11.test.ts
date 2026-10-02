import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Y-11: no adapter uninstalls another one. The product code reaches no other adapter's instance: it reads and writes
// only its own instance object, runs no host command and starts no process.

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

  test("every instance object the code names is its own", () => {
    const foreign: string[] = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/system\.adapter\.([^\s"'`]*)/g)) {
        const rest = match[1];
        const own =
          rest.startsWith("${this.namespace}") ||
          rest.startsWith("${this.adapter.namespace}") ||
          rest.startsWith("${adapter.namespace}") ||
          rest.startsWith("<ns>");
        if (!own) {
          foreign.push(`${file}: system.adapter.${rest}`);
        }
      }
    }
    expect(foreign).toEqual([]);
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

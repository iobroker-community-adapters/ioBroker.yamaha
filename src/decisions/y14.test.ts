import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectTransports, type TransportAttempt } from "../lib/attempt-device";
import type { TransportConnection, WriteOutcome } from "../lib/lifecycle/multi-transport-handle";
import type { ObjectDef } from "../lib/catalog/types";
import type { Transport } from "../lib/catalog/owner-policy";

// Y-14: all three protocols — YNCA, MusicCast, XML — are fully supported, always; none of them is optional. Every
// protocol a receiver answers on serves it, side by side on one object tree, and no setting turns one off.

const ROOT = join(__dirname, "..", "..");

function state(id: string): ObjectDef {
  return { id, type: "state", common: { name: id, type: "boolean", role: "switch", read: true, write: true } };
}

/** What each protocol alone can do on one receiver. */
const OWN: Record<Transport, string> = { ynca: "sound.pureDirect", yxc: "multiroom.group.leave", xml: "advanced.x" };

function attempt(transport: Transport, writes: string[], answers = true): TransportAttempt {
  return {
    transport,
    build: () => {
      const connection: TransportConnection & { connect(): Promise<boolean> } = {
        transport,
        connect: () => Promise.resolve(answers),
        buildObjects: () => [state("power"), state(OWN[transport])],
        seedOwned: () => undefined,
        handleWrite: (id): Promise<WriteOutcome> => {
          writes.push(`${transport}:${id}`);
          return Promise.resolve("sent");
        },
        onDrop: () => undefined,
        close: () => undefined,
      };
      return connection;
    },
  };
}

describe("Y-14 all three protocols, always, none optional", () => {
  test("a receiver that answers all three is served by all three on one tree", async () => {
    const writes: string[] = [];
    const info: string[] = [];
    const objects: string[] = [];
    const handle = await connectTransports(
      "living",
      [attempt("ynca", writes), attempt("yxc", writes), attempt("xml", writes)],
      {
        upsertObject: id => {
          objects.push(id);
          return Promise.resolve();
        },
        log: { debug: () => undefined, info: message => info.push(message), warn: () => undefined },
      },
    );
    expect(info).toEqual(["living: ready — YNCA ✓  MusicCast ✓  XML ✓"]);
    expect(objects.filter(id => id === "living.power")).toHaveLength(1);
    for (const transport of ["ynca", "yxc", "xml"] as const) {
      handle?.handleStateChange(`living.${OWN[transport]}`, false, true);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes.sort()).toEqual(["xml:advanced.x", "ynca:sound.pureDirect", "yxc:multiroom.group.leave"]);
    handle?.close();
  });

  test("a protocol that does not answer leaves the others serving", async () => {
    const writes: string[] = [];
    const info: string[] = [];
    const handle = await connectTransports(
      "living",
      [attempt("ynca", writes, false), attempt("yxc", writes), attempt("xml", writes)],
      {
        upsertObject: () => Promise.resolve(),
        log: { debug: () => undefined, info: message => info.push(message), warn: () => undefined },
      },
    );
    expect(info).toEqual(["living: ready — MusicCast ✓  XML ✓"]);
    handle?.close();
  });

  test("no setting turns a protocol off", () => {
    const config = readFileSync(join(ROOT, "admin", "jsonConfig.json"), "utf-8");
    const manifest = JSON.parse(readFileSync(join(ROOT, "io-package.json"), "utf-8")) as {
      native: Record<string, unknown>;
    };
    const switches = (keys: string[]): string[] =>
      keys.filter(key => /ynca|yxc|musiccast|xml|protocol|transport/i.test(key) && !/^xmlPollInterval$/.test(key));
    expect(switches(Object.keys(manifest.native))).toEqual([]);
    expect(switches([...config.matchAll(/"([A-Za-z_]+)"\s*:/g)].map(m => m[1]))).toEqual([]);
  });
});

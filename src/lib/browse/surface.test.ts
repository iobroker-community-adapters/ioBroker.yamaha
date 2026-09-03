import { createBrowseSurface } from "./surface";
import type { BrowseDriver } from "./types";
import type { ObjectDef } from "../catalog/types";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

/**
 * A driver stub: sources plus, optionally, a remote pad.
 *
 * @param pad the pad this transport declares
 * @param pad.cursorValues the cursor keys, absent for a transport without a pad
 * @param pad.menuValues the menu keys, absent where the protocol has none
 * @param sources the browsable sources the device offers
 * @returns the stub driver
 */
function driverStub(
  pad: { cursorValues?: string[]; menuValues?: string[] },
  sources: Record<string, string> = { netRadio: "Net Radio" },
): BrowseDriver & { attach(engine: never): void } {
  return {
    sources: () => sources,
    open: (): void => {},
    select: (): void => {},
    pageUp: (): void => {},
    pageDown: (): void => {},
    back: (): void => {},
    home: (): void => {},
    attach: (): void => {},
    ...pad,
  };
}

async function build(driver: ReturnType<typeof driverStub>): Promise<Map<string, ObjectDef>> {
  const created = new Map<string, ObjectDef>();
  await createBrowseSurface(driver, "living", {
    upsertObject: (id, def) => {
      created.set(id, def);
      return Promise.resolve();
    },
    emit: (): void => {},
    log: silentLog,
    delay: () => Promise.resolve(),
  });
  return created;
}

describe("createBrowseSurface — the remote pad", () => {
  it("creates the pad a transport declares, with exactly its own vocabulary", async () => {
    const created = await build(
      driverStub({ cursorValues: ["up", "down", "left", "right", "select", "return", "home"], menuValues: ["menu"] }),
    );
    expect(created.has("living.remote")).toBe(true);
    expect(created.get("living.remote.cursor")?.common.states).toEqual({
      up: "up",
      down: "down",
      left: "left",
      right: "right",
      select: "select",
      return: "return",
      home: "home",
    });
    expect(created.get("living.remote.cursor")?.common.write).toBe(true);
    expect(created.get("living.remote.cursor")?.common.read).toBe(false);
    expect(created.get("living.remote.menu")?.common.states).toEqual({ menu: "menu" });
  });

  it("creates no menu key where the protocol has none (XML)", async () => {
    const created = await build(driverStub({ cursorValues: ["up"] }));
    expect(created.has("living.remote.cursor")).toBe(true);
    expect(created.has("living.remote.menu")).toBe(false);
  });

  it("creates no pad at all for a transport that declares none (MusicCast brings its own)", async () => {
    const created = await build(driverStub({}));
    expect([...created.keys()].some(id => id.includes("remote"))).toBe(false);
  });

  it("creates nothing — pad included — on a device that cannot browse", async () => {
    const created = await build(driverStub({ cursorValues: ["up"] }, {}));
    expect(created.size).toBe(0);
  });
});

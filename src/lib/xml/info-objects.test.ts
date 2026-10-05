import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MultiTransportHandle } from "../lifecycle/multi-transport-handle";
import { TransportConnectionAdapter } from "../lifecycle/transport-connection-adapter";
import type { LearnedTree } from "../lifecycle/learned-tree";
import { xmlHarness } from "../../../test/helpers/xml-controller";
import { parseSystemConfig } from "./protocol";

// Review 2026-10-05, A5: XML reported the model but built no object for it, and the transport adapter drops a value
// no transport built — every XML-only receiver showed an empty model (inventory: rx-v3900 `info.model = ""`) and had
// no `info.firmware`, so the device card, the device icon and the remembered model never followed.

/**
 * The System/Config answer of an inventory device, parsed.
 *
 * @param device the inventory fixture
 * @returns the declaration
 */
const configOf = (device: string): ReturnType<typeof parseSystemConfig> =>
  parseSystemConfig(
    (
      JSON.parse(readFileSync(join(__dirname, `../../../test/fixtures/inventory/${device}.json`), "utf8")) as {
        xml: { answers: Record<string, string> };
      }
    ).xml.answers["System/Config"],
  );

describe("the model and the firmware reach the tree over XML (review 2026-10-05, A5)", () => {
  test.each([
    ["rxv3900", "RX-V3900", "Y.0125.0205/V119"], // 2008: the nested Main/Sub version
    ["rxv6a", "RX-V6A", "1.80/3.14"], // 2020
  ])("%s: built from the shared entries, and the values arrive", async (device, model, firmware) => {
    const written = new Map<string, unknown>();
    const xml = new TransportConnectionAdapter("xml", "living", (id, value) => void written.set(id, value));
    const h = xmlHarness({ Main_Zone: { power: true } }, undefined, {
      upsertObject: xml.interceptUpsert,
      setStateAck: xml.interceptSetStateAck,
    });
    h.client.config = configOf(device);
    xml.bind(h.controller);
    expect(await xml.connect()).toBe(true);
    const built = xml.buildObjects();
    expect(built.find(object => object.id === "info.model")?.common).toMatchObject({
      type: "string",
      role: "text",
      write: false,
    });
    expect(built.find(object => object.id === "info.firmware")?.common).toMatchObject({ type: "string", write: false });
    const store: { tree: LearnedTree } = { tree: { shared: {}, transports: [], firmware: {} } };
    const handle = new MultiTransportHandle("living", [xml], {
      upsertObject: () => Promise.resolve(),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      adapterVersion: "3.2.0",
      tree: { get: () => store.tree, set: tree => (store.tree = tree) },
      settleTree: () => Promise.resolve(),
    });
    await handle.start();
    expect(written.get("living.info.model")).toBe(model);
    expect(written.get("living.info.firmware")).toBe(firmware);
    handle.close();
  });

  test("a device that reports neither builds neither", async () => {
    const h = xmlHarness({ Main_Zone: { power: true } });
    await h.controller.start();
    expect(h.objects.filter(id => id.startsWith("living.info."))).toEqual([]);
  });
});

import { BrowseEngine } from "./browse-engine";
import { browseObjectDefs } from "./objects";
import type { BrowseDriver } from "./types";
import type { ObjectDef } from "../catalog/types";
import type { ControllerLog } from "../controller";

/** What creating a browsing surface needs from its controller. */
export interface BrowseSurfaceDeps {
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a browse state with ack (already guarded against a closed connection). */
  emit(relativeId: string, value: boolean | number | string): void;
  /** Adapter log. */
  log: ControllerLog;
  /** Adapter-managed delay that ends when the connection closes. */
  delay(ms: number): Promise<void>;
}

/**
 * Create the `player.browse.*` surface for one transport: its objects, the engine that
 * owns the states, and the wiring between them. All three transports need exactly this
 * sequence, so it lives here once instead of being copied into each controller.
 *
 * Returns undefined when the device offers nothing browsable — then no objects are created
 * at all, which is what keeps the folder off devices that cannot browse.
 *
 * @param driver the transport's list driver
 * @param deviceId the id-safe device id
 * @param deps the controller callbacks
 * @returns the engine driving the surface, or undefined when there is nothing to browse
 */
export async function createBrowseSurface(
  driver: BrowseDriver & { attach(engine: BrowseEngine): void },
  deviceId: string,
  deps: BrowseSurfaceDeps,
): Promise<BrowseEngine | undefined> {
  const sources = driver.sources();
  if (Object.keys(sources).length === 0) {
    return undefined;
  }
  for (const def of browseObjectDefs(sources)) {
    await deps.upsertObject(`${deviceId}.${def.id}`, def);
  }
  const engine = new BrowseEngine(driver, {
    emit: (id, value) => deps.emit(id, value),
    log: deps.log,
    delay: deps.delay,
  });
  driver.attach(engine);
  engine.seed();
  return engine;
}

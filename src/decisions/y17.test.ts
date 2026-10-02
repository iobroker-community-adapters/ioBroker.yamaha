import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { groupOf, groupsOf, isGroupEnabled } from "../lib/catalog/groups";
import type { YxcCapabilities } from "../lib/yxc/capability";

// Y-17: multiroom is fully built in — group forming included — and is there without being switched on. Switching
// zones is multiroom: every zone lives under multiroom.

const LINKABLE: YxcCapabilities = {
  zones: [
    { id: "main", funcs: ["power", "volume"], inputs: ["hdmi1", "mc_link"] },
    { id: "zone2", funcs: ["power", "volume"], inputs: ["hdmi1", "mc_link"] },
  ],
  media: ["netusb"],
  hasDistribution: true,
};

describe("Y-17 multiroom is built in, with group forming; zones are multiroom", () => {
  const objects = mapYxcToObjects(LINKABLE);
  const byId = new Map(objects.map(o => [o.id, o]));

  test("a device that can link gets the commands that form and leave a group", () => {
    expect(byId.get("multiroom.group.linkDevice")?.common.write).toBe(true);
    expect(byId.get("multiroom.group.leave")?.common.write).toBe(true);
    expect(byId.get("multiroom.group.name")?.common.write).toBe(true);
    expect(byId.has("multiroom.group.role")).toBe(true);
  });

  test("a zone and everything in it is multiroom", () => {
    expect(byId.has("multiroom.zone2.power")).toBe(true);
    expect(groupOf("multiroom.zone2")).toBe("multiroom");
    expect(groupsOf("multiroom.zone2.power")).toEqual(["multiroom", "amp"]);
    expect(groupOf("multiroom.group.linkDevice")).toBe("multiroom");
  });

  test("nothing has to be switched on for it: with default settings every multiroom datapoint is created", () => {
    for (const id of ["multiroom.group.linkDevice", "multiroom.group.leave", "multiroom.zone2.power"]) {
      expect(isGroupEnabled(id, {})).toBe(true);
    }
  });
});

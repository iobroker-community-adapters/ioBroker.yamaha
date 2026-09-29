import { slotListObjects, slotListValues, type SlotField } from "./list-slots";

const FIELDS: readonly SlotField[] = [
  { key: "name", nameKey: "entryName", descKey: "descSlotName", type: "string", role: "text" },
  { key: "frequency", nameKey: "frequency", descKey: "descSlotFrequency", type: "number", role: "value", unit: "kHz" },
];

// Fleet rule 2026-09-28: a list is single datapoints, a JSON form only in addition (audit 2026-09-29, C30).
describe("a device list as slots", () => {
  test("builds the folder, a channel per slot and a datapoint per field, parents first", () => {
    const objects = slotListObjects("tuner.storedStations", "storedStations", 2, FIELDS, "descStoredStations");
    expect(objects.map(o => `${o.type}:${o.id}`)).toEqual([
      "channel:tuner.storedStations",
      "channel:tuner.storedStations.1",
      "state:tuner.storedStations.1.name",
      "state:tuner.storedStations.1.frequency",
      "channel:tuner.storedStations.2",
      "state:tuner.storedStations.2.name",
      "state:tuner.storedStations.2.frequency",
    ]);
    expect((objects[1].common.name as Record<string, string>).en).toBe("Slot 1");
    expect(objects[3].common).toMatchObject({ type: "number", role: "value", unit: "kHz", write: false });
    expect((objects[3].common.desc as Record<string, string>).en).toMatch(/frequency/);
  });

  test("names a band's folder with its band", () => {
    const [folder] = slotListObjects("tuner.storedStations.fm", "storedStationsBand", 1, FIELDS, undefined, "FM");
    expect((folder.common.name as Record<string, string>).en).toBe("Stored stations FM");
  });

  test("writes every field of every slot — an empty slot, and a field an entry lacks, read empty", () => {
    expect(
      slotListValues("tuner.storedStations", 3, FIELDS, [{ name: "Radio 1", frequency: 98100 }, undefined]),
    ).toEqual([
      { id: "tuner.storedStations.1.name", value: "Radio 1" },
      { id: "tuner.storedStations.1.frequency", value: 98100 },
      { id: "tuner.storedStations.2.name", value: "" },
      { id: "tuner.storedStations.2.frequency", value: 0 },
      { id: "tuner.storedStations.3.name", value: "" },
      { id: "tuner.storedStations.3.frequency", value: 0 },
    ]);
  });
});

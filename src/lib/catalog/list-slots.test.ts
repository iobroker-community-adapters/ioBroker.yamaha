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

  // Rule D19 of the fleet (krobi 2026-10-29): a slot's field names its list and its slot — "Stored stations 2: Name",
  // never the twelfth "Name" of one device — in every language; a band's list names its band there too.
  test("names a slot's field with its list and its slot, in every language", () => {
    const objects = slotListObjects("tuner.storedStations", "storedStations", 2, FIELDS, "descStoredStations");
    const name = (id: string): Record<string, string> =>
      objects.find(o => o.id === id)?.common.name as Record<string, string>;
    expect(name("tuner.storedStations.2.name")).toMatchObject({
      en: "Stored stations 2: Name",
      de: "Gespeicherte Sender 2: Name",
    });
    expect(name("tuner.storedStations.1.frequency").en).toBe("Stored stations 1: Frequency");
    const fields = objects.filter(o => o.type === "state").map(o => o.common.name as Record<string, string>);
    for (const language of Object.keys(fields[0])) {
      expect(new Set(fields.map(field => field[language])).size, language).toBe(fields.length);
    }
    const [, , band] = slotListObjects("tuner.storedStations.fm", "storedStationsBand", 1, FIELDS, undefined, "FM");
    expect((band.common.name as Record<string, string>).en).toBe("Stored stations FM 1: Name");
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

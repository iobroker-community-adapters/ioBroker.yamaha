import { deviceIdFor, idSegment, modelId, nameId, serialId } from "./device-id";

describe("idSegment", () => {
  test("is lower case, with German umlauts in their two-letter form", () => {
    expect(idSegment("WX-030")).toBe("wx-030");
    expect(idSegment("Büro")).toBe("buero");
    expect(idSegment("Gäste-WC")).toBe("gaeste-wc");
    expect(idSegment("Großes Öl-Übungszimmer")).toBe("grosses-oel-uebungszimmer");
  });

  test("drops other accents, also in their decomposed form", () => {
    expect(idSegment("Séjour")).toBe("sejour");
    expect(idSegment("Séjour")).toBe("sejour");
  });

  test("trims, and joins every run of other characters into one hyphen", () => {
    expect(idSegment("Werkstatt ")).toBe("werkstatt");
    expect(idSegment("  Living  Room ")).toBe("living-room");
    expect(idSegment("a.b/c_d")).toBe("a-b-c-d");
    expect(idSegment("CD-NT670D ")).toBe("cd-nt670d");
  });

  test("leaves nothing of a name without a usable character", () => {
    expect(idSegment(" ✓ ")).toBe("");
  });
});

describe("serialId", () => {
  test("is the model and the last four characters of the serial", () => {
    expect(serialId("WX-030", { serial: "0E1A2B3C", mac: "00A0DED4F504" }, new Set())).toBe("wx-030-2b3c");
    expect(serialId("RX-V3900", { serial: "0CE4E483" }, new Set())).toBe("rx-v3900-e483");
  });

  test("takes the whole serial when another device of the model shares the last four", () => {
    expect(serialId("WX-010", { serial: "0B11AA22" }, new Set(["wx-010-aa22"]))).toBe("wx-010-0b11aa22");
  });

  test("is undefined without a model or without a serial — a MAC alone is no serial", () => {
    expect(serialId(undefined, { serial: "0E1A2B3C" }, new Set())).toBeUndefined();
    expect(serialId("", { serial: "0E1A2B3C" }, new Set())).toBeUndefined();
    expect(serialId("RX-V473", undefined, new Set())).toBeUndefined();
    expect(serialId("RX-V473", { mac: "00A0DED4F504" }, new Set())).toBeUndefined();
  });
});

describe("modelId", () => {
  test("is the model, counted on when a device of the same model holds it", () => {
    expect(modelId("RX-V473", new Set())).toBe("rx-v473");
    expect(modelId("RX-V473", new Set(["rx-v473"]))).toBe("rx-v473-2");
    expect(modelId("RX-V473", new Set(["rx-v473", "rx-v473-2"]))).toBe("rx-v473-3");
  });

  test("is undefined without a model", () => {
    expect(modelId(undefined, new Set())).toBeUndefined();
    expect(modelId("  ", new Set())).toBeUndefined();
  });
});

describe("nameId", () => {
  test("is the typed name, else the address, counted on when taken", () => {
    expect(nameId("Küche", "10.0.0.1", new Set())).toBe("kueche");
    expect(nameId("Küche", "10.0.0.2", new Set(["kueche"]))).toBe("kueche-2");
    expect(nameId("", "10.0.0.9", new Set())).toBe("10-0-0-9");
    expect(nameId(" ✓ ", "10.0.0.9", new Set())).toBe("10-0-0-9");
  });

  test("never hands out the adapter's own info branch", () => {
    expect(nameId("Info", "10.0.0.1", new Set())).toBe("info-2");
  });
});

describe("deviceIdFor", () => {
  test("two speakers of the same model and the same name get two ids", () => {
    const first = deviceIdFor(
      { model: "WX-010", identity: { serial: "0B11AA22" }, name: "Lautsprecher", ip: "10.0.0.1" },
      new Set(),
    );
    const second = deviceIdFor(
      { model: "WX-010", identity: { serial: "0B33BB44" }, name: "Lautsprecher", ip: "10.0.0.2" },
      new Set([first]),
    );
    expect([first, second]).toEqual(["wx-010-aa22", "wx-010-bb44"]);
  });

  test("ignores the name when the device tells its model and serial", () => {
    expect(
      deviceIdFor(
        { model: "WX-021", identity: { serial: "0E3A4B5C" }, name: "Yamaha-021-Schlafzimmer", ip: "x" },
        new Set(),
      ),
    ).toBe("wx-021-4b5c");
  });

  test("uses the model alone for a device without a serial", () => {
    expect(deviceIdFor({ model: "RX-V473", name: "Küche", ip: "10.0.0.1" }, new Set())).toBe("rx-v473");
    expect(deviceIdFor({ model: "RX-V473", name: "Bad", ip: "10.0.0.2" }, new Set(["rx-v473"]))).toBe("rx-v473-2");
  });

  test("uses the name when not even the model is known", () => {
    expect(deviceIdFor({ identity: { serial: "0E1A2B3C" }, name: "Bad", ip: "10.0.0.1" }, new Set())).toBe("bad");
    expect(deviceIdFor({ ip: "10.0.0.1" }, new Set())).toBe("10-0-0-1");
  });
});

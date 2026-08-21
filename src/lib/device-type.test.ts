import { DEVICE_TYPE_ICONS, detectDeviceType, iconForModel } from "./device-type";

describe("detectDeviceType", () => {
  test("AV receivers and AV pre-amps across generations", () => {
    for (const model of ["RX-V6A", "RX-V473", "RX-A2070", "RX-A6A", "TSR-700", "TSR-7810", "HTR-4072", "CX-A5100"]) {
      expect(detectDeviceType(model)).toBe("avReceiver");
    }
  });

  test("stereo network receivers and streaming amplifiers", () => {
    for (const model of ["R-N500", "R-N303D", "WXA-50", "WXC-50"]) {
      expect(detectDeviceType(model)).toBe("stereoReceiver");
    }
  });

  test("soundbars", () => {
    for (const model of ["YSP-1600", "YAS-408", "ATS-4080", "SRT-1500", "SR-B20A", "SR-C20A", "MusicCast BAR 400"]) {
      expect(detectDeviceType(model)).toBe("soundbar");
    }
  });

  test("wireless speakers — WXA/WXC amplifiers must not fall into the WX speaker bucket", () => {
    for (const model of ["WX-030", "WX-051", "MusicCast 20", "MusicCast 50", "ISX-80", "NX-N500"]) {
      expect(detectDeviceType(model)).toBe("speaker");
    }
    expect(detectDeviceType("WXA-50")).toBe("stereoReceiver");
  });

  test("cd systems and network cd players", () => {
    for (const model of ["CRX-N470D", "MCR-N560", "CD-N500", "CD-NT670"]) {
      expect(detectDeviceType(model)).toBe("cdSystem");
    }
  });

  test("model casing and surrounding whitespace do not matter", () => {
    expect(detectDeviceType("  rx-v6a ")).toBe("avReceiver");
    expect(detectDeviceType("musiccast bar 400")).toBe("soundbar");
  });

  test("empty or unknown models fall back to the AV-receiver silhouette", () => {
    expect(detectDeviceType(undefined)).toBe("avReceiver");
    expect(detectDeviceType("")).toBe("avReceiver");
    expect(detectDeviceType("Frobnicator 9000")).toBe("avReceiver");
  });
});

describe("iconForModel", () => {
  test("every device class carries an inline SVG data URL", () => {
    for (const icon of Object.values(DEVICE_TYPE_ICONS)) {
      expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
      const svg = Buffer.from(icon.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox");
    }
  });

  test("resolves a model straight to its class icon", () => {
    expect(iconForModel("RX-V6A")).toBe(DEVICE_TYPE_ICONS.avReceiver);
    expect(iconForModel("WX-030")).toBe(DEVICE_TYPE_ICONS.speaker);
  });
});

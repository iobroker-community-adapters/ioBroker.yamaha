import { DEVICE_TYPE_ICONS, detectDeviceType, iconForModel, volumeIndicatorIcon } from "./device-type";

const URI_PREFIX = "data:image/svg+xml;base64,";
const decode = (icon: string): string => Buffer.from(icon.slice(URI_PREFIX.length), "base64").toString("utf8");
const allIcons = (): Array<[string, string]> => [
  ...Object.entries(DEVICE_TYPE_ICONS),
  ["indicator:percent", volumeIndicatorIcon(true)],
  ["indicator:device", volumeIndicatorIcon(false)],
];

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

  // A network player, a network turntable, a streaming amplifier and the MusicCast streaming adapter got
  // the AV-receiver silhouette, and a model spelled with an underscore fell through (D13).
  test("network players, turntables, streaming amplifiers and the WXAD adapter are stereo devices", () => {
    expect(detectDeviceType("NP-S303")).toBe("stereoReceiver");
    expect(detectDeviceType("TT-N503")).toBe("stereoReceiver");
    expect(detectDeviceType("XDA-QS5400")).toBe("stereoReceiver");
    expect(detectDeviceType("WXAD-10")).toBe("stereoReceiver");
    expect(detectDeviceType("WX-030")).toBe("speaker");
  });

  test("an underscore in the model name reads like a dash", () => {
    expect(detectDeviceType("R_N803")).toBe("stereoReceiver");
    expect(detectDeviceType("CD_NT670")).toBe("cdSystem");
    expect(detectDeviceType("SR_B20A")).toBe("soundbar");
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

describe("the pictograms follow the object-tree rules (fleet recipe, measured at the live admin 2026-09-12)", () => {
  test("every icon is the SVG itself as an inline data URL, drawn for 28 px on a 64-unit viewBox", () => {
    // The admin inlines a data URL into the row; a path would land in a bare <img> that keeps
    // its fixed colour and is invisible in one theme family.
    for (const [, icon] of allIcons()) {
      expect(icon.startsWith(URI_PREFIX)).toBe(true);
      const svg = decode(icon);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    }
  });

  test("uses only currentColor or none — a fixed colour breaks one of the two theme families", () => {
    for (const [name, icon] of allIcons()) {
      const svg = decode(icon);
      for (const match of svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) {
        expect(["currentColor", "none"], `${name}: ${match[0]}`).toContain(match[1]);
      }
      expect(svg, name).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:black|white|rgb\()/i);
      expect(svg, name).not.toContain("<style");
    }
  });

  test("draws with path and circle only — the row's CSS zeroes the width of rect, image and use", () => {
    for (const [name, icon] of allIcons()) {
      const inner = decode(icon)
        .replace(/^<svg[^>]*>/, "")
        .replace(/<\/svg>$/, "");
      const tags = [...inner.matchAll(/<([a-zA-Z]+)/g)].map(m => m[1]);
      expect(tags.length, name).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(["path", "circle"], `${name}: <${tag}>`).toContain(tag);
      }
    }
  });

  test("the five classes are five different pictures, stable across calls", () => {
    const uris = Object.values(DEVICE_TYPE_ICONS);
    expect(new Set(uris).size).toBe(5);
    expect(iconForModel("RX-V6A")).toBe(iconForModel("RX-V6A"));
    expect(volumeIndicatorIcon(true)).toBe(volumeIndicatorIcon(true));
    expect(volumeIndicatorIcon(true)).not.toBe(volumeIndicatorIcon(false));
    expect(uris).not.toContain(volumeIndicatorIcon(true));
  });

  test("the volume glyphs: a speaker with a percent sign for percent mode, the speaker alone otherwise", () => {
    const percent = decode(volumeIndicatorIcon(true));
    const device = decode(volumeIndicatorIcon(false));
    // The percent sign is two circles and a slash; the device-scale glyph carries sound waves instead.
    expect(percent.match(/<circle/g)).toHaveLength(2);
    expect(device).not.toContain("<circle");
    expect(device.match(/<path/g)).toHaveLength(3);
  });
});

describe("iconForModel", () => {
  test("every device class carries an inline SVG data URL", () => {
    for (const icon of Object.values(DEVICE_TYPE_ICONS)) {
      expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
      const svg = decode(icon);
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox");
    }
  });

  test("resolves a model straight to its class icon", () => {
    expect(iconForModel("RX-V6A")).toBe(DEVICE_TYPE_ICONS.avReceiver);
    expect(iconForModel("WX-030")).toBe(DEVICE_TYPE_ICONS.speaker);
  });
});

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Y-19: the logo keeps its motif — one circle with three tuning forks at 0°, 120° and 240° — and reads in the light
// and in the dark admin theme. A technical fix may change a colour or a comment, never the motif.

const ROOT = join(__dirname, "..", "..");
const svg = readFileSync(join(ROOT, "admin", "yamaha.svg"), "utf-8");
/** The drawing without its comments — a comment may name what the drawing must not use. */
const drawing = svg.replace(/<!--[\s\S]*?-->/g, "");

/**
 * The geometry of the motif, attribute by attribute, in drawing order.
 *
 * @param text the drawing
 * @returns one line per shape
 */
function motif(text: string): string[] {
  const shapes: string[] = [];
  for (const match of text.matchAll(/<(circle|path|rect|line|polyline|polygon|ellipse)\b([^>]*)>/g)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/([a-z-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    const geometry = ["cx", "cy", "r", "d", "transform", "x", "y", "width", "height", "points"]
      .filter(key => key in attrs)
      .map(key => `${key}=${attrs[key].replace(/\s+/g, " ").trim()}`);
    shapes.push(`${match[1]} ${geometry.join(" ")}`);
  }
  return shapes;
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("Y-19 the logo keeps its circle and tuning forks and reads in light and dark mode", () => {
  test("the motif: one circle, three tuning forks turned by 120°", () => {
    const fork = "d=M236,104 L236,212 L256,246 L276,212 L276,104";
    expect(motif(drawing)).toEqual([
      "circle cx=256 cy=256 r=234",
      `path ${fork} transform=rotate(0 256 256)`,
      `path ${fork} transform=rotate(120 256 256)`,
      `path ${fork} transform=rotate(240 256 256)`,
    ]);
  });

  test("the manifest shows this logo", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "io-package.json"), "utf-8")) as { common: { icon: string } };
    expect(manifest.common.icon).toBe("yamaha.svg");
  });

  test("drawn in fixed colours that read on the light and on the dark admin background", () => {
    // Embedded as <img>, the logo inherits no colour and sees no admin theme.
    expect(drawing).not.toMatch(/currentColor|<style|prefers-color-scheme/i);
    const colours = [...drawing.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{6})"/g)].map(m => m[1]);
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      for (const background of ["#ffffff", "#303030", "#121212"]) {
        expect(contrast(colour, background)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

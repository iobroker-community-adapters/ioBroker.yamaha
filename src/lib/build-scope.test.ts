import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

// tsconfig.build.json compiles every .ts under src/ except the *.test.ts files, and npm ships
// build/. A test helper under a __fixtures__ folder in src/ therefore lands in the package that
// every installation downloads. Test helpers live in test/helpers/ instead.
describe("build scope", () => {
  it("no TypeScript module lives under a __fixtures__ folder in src — the build would ship it", () => {
    const root = join(__dirname, "..");
    const shipped = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      path => path.split(sep).includes("__fixtures__") && path.endsWith(".ts"),
    );
    expect(shipped).toEqual([]);
  });
});

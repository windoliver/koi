/**
 * API surface stability tests.
 *
 * Validates all subpath exports have corresponding .d.ts and .js files.
 * Requires a prior build. Package name is read dynamically from package.json.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ExportConfig {
  readonly types: string;
  readonly import: string;
}

const pkgPath = resolve(__dirname, "../../package.json");
const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
  readonly name: string;
  readonly exports: Readonly<Record<string, ExportConfig>>;
};

const exportEntries = Object.entries(pkgJson.exports) as ReadonlyArray<
  readonly [string, ExportConfig]
>;

describe(`${pkgJson.name} API surface`, () => {
  test("package.json has at least one export entry", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
  });

  test("all subpath exports are declared", () => {
    const expectedSubpaths = [
      ".",
      "./autonomous",
      "./channels",
      "./cli",
      "./context-arena",
      "./forge",
      "./gateway",
      "./goals",
      "./governance",
      "./ipc",
      "./nexus",
      "./node",
      "./quality",
      "./retry",
      "./rlm",
      "./sandbox",
      "./skills",
      "./tool-stack",
      "./workspace",
      "./spawner",
      "./tools",
      "./infra",
      "./safety",
      "./middleware",
      "./observability",
    ];

    const actualSubpaths = exportEntries.map(([subpath]) => subpath);
    for (const expected of expectedSubpaths) {
      expect(actualSubpaths).toContain(expected);
    }
  });

  for (const [subpath, config] of exportEntries) {
    const dtsPath = resolve(__dirname, "../..", config.types);
    const jsPath = resolve(__dirname, "../..", config.import);

    test(`${subpath} .d.ts file exists and is non-empty`, () => {
      expect(existsSync(dtsPath)).toBe(true);
      const dts = readFileSync(dtsPath, "utf-8");
      expect(dts.length).toBeGreaterThan(0);
    });

    test(`${subpath} .js file exists`, () => {
      expect(existsSync(jsPath)).toBe(true);
    });
  }
});

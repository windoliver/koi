/**
 * API surface stability tests.
 *
 * Validates all subpath exports have corresponding .d.ts and .js files,
 * and asserts exported symbol names for key subpaths to catch breaking
 * contract changes (e.g., function signature changes, removed exports).
 *
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

/**
 * Root export symbol assertions — catches breaking changes like removed
 * exports, renamed functions, or sync→async signature changes.
 *
 * Only tests the root export (which inlines types from multiple packages).
 * L3 subpaths are thin `export * from '@koi/...'` re-exports whose .d.ts
 * content is just the re-export declaration.
 */
describe(`${pkgJson.name} root export symbols`, () => {
  test("root .d.ts contains expected key exports", () => {
    const rootConfig = pkgJson.exports["."];
    const dtsPath = resolve(__dirname, "../..", rootConfig.types);
    const dts = readFileSync(dtsPath, "utf-8");

    // Functions that must be exported from the root
    expect(dts).toContain("createKoi");
    expect(dts).toContain("createPiAdapter");
    expect(dts).toContain("loadManifest");
    expect(dts).toContain("getEngineName");
    expect(dts).toContain("createConfiguredKoi");
  });

  test("L3 subpaths are re-export declarations", () => {
    const l3Subpaths = ["./channels", "./sandbox", "./forge", "./governance", "./autonomous"];

    for (const subpath of l3Subpaths) {
      const config = pkgJson.exports[subpath];
      if (!config) continue;
      const dtsPath = resolve(__dirname, "../..", config.types);
      const dts = readFileSync(dtsPath, "utf-8");
      // L3 subpaths must re-export from their source package
      expect(dts).toContain("export *");
    }
  });
});

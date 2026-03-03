/**
 * API surface stability tests.
 *
 * Snapshots .d.ts files for all exports. Requires a prior build.
 * Package name is read dynamically from package.json.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  for (const [subpath, config] of exportEntries) {
    const dtsPath = resolve(__dirname, "../..", config.types);

    test(`${subpath} has stable type surface`, () => {
      const dts = readFileSync(dtsPath, "utf-8");
      // Normalize chunk hash suffixes so snapshots are stable across Bun versions.
      const normalized = dts.replace(/([a-z-]+)-[A-Za-z0-9_-]{6,12}\.(js|d\.ts)/g, "$1-HASH.$2");
      expect(normalized).toMatchSnapshot();
    });
  }
});

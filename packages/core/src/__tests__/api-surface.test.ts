/**
 * API surface stability tests for @koi/core.
 *
 * Reads every subpath export from package.json, loads the corresponding
 * .d.ts file from dist/, and snapshots it. Any unintended type signature
 * change will cause a snapshot diff.
 *
 * Requires a prior `turbo build` so dist/ is populated.
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
  readonly exports: Readonly<Record<string, ExportConfig>>;
};

const exportEntries = Object.entries(pkgJson.exports) as ReadonlyArray<
  readonly [string, ExportConfig]
>;

describe("@koi/core API surface", () => {
  test("package.json has at least one export entry", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
  });

  for (const [subpath, config] of exportEntries) {
    const dtsPath = resolve(__dirname, "../..", config.types);

    test(`${subpath} has stable type surface`, () => {
      const dts = readFileSync(dtsPath, "utf-8");
      // Normalize chunk hash suffixes (e.g., "ecs-Czk0XWb5.js" → "ecs-HASH.js")
      // so snapshots are stable across tsup/rollup versions.
      const normalized = dts.replace(/([a-z-]+)-[A-Za-z0-9_-]{6,12}\.(js|d\.ts)/g, "$1-HASH.$2");
      expect(normalized).toMatchSnapshot();
    });
  }
});

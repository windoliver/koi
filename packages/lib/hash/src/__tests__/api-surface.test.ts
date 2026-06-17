/**
 * API surface stability tests.
 *
 * Snapshots .d.ts files for all exports. Requires a prior build.
 * Package name is read dynamically from package.json.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

// A compiled copy of this test can be restored from turbo's build cache and run
// by `bun test` (which scans dist/), but dist/ has no colocated snapshot file,
// so that copy would fail in CI. The src/ test is the source of truth — skip
// any dist/ copy.
const isDistCopy = __dirname.includes(`${sep}dist${sep}`);

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

describe.skipIf(isDistCopy)(`${pkgJson.name} API surface`, () => {
  test("package.json has at least one export entry", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
  });

  for (const [subpath, config] of exportEntries) {
    const dtsPath = resolve(__dirname, "../..", config.types);

    test(`${subpath} has stable type surface`, () => {
      const dts = readFileSync(dtsPath, "utf-8");
      expect(dts).toMatchSnapshot();
    });
  }
});

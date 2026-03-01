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

/**
 * Sort import lines at the top of a DTS file so snapshots are stable
 * across environments where tsup/rollup may reorder imports.
 */
function normalizeDtsImports(dts: string): string {
  const lines = dts.split("\n");
  const importLines: string[] = [];
  // let: index tracking first non-import line
  let firstNonImport = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line?.startsWith("import ")) {
      importLines.push(line);
    } else if (importLines.length > 0) {
      firstNonImport = i;
      break;
    } else {
      firstNonImport = i + 1;
    }
  }
  if (importLines.length <= 1) return dts;
  const sorted = [...importLines].sort();
  return [...sorted, ...lines.slice(firstNonImport)].join("\n");
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
      // Normalize import order — DTS bundler emits imports non-deterministically across environments
      const normalized = normalizeDtsImports(dts);
      expect(normalized).toMatchSnapshot();
    });
  }
});

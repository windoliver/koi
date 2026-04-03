/**
 * API surface stability test.
 *
 * Snapshots the .d.ts output for each export entry to detect
 * unintentional type changes across releases.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const PKG_ROOT = path.resolve(import.meta.dir, "../..");
const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>;
};

describe("@koi/mcp API surface", () => {
  const exportEntries = Object.entries(pkgJson.exports ?? {});

  test("package has at least one export", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
  });

  for (const [key, value] of exportEntries) {
    const entry = value as Record<string, string> | undefined;
    const dtsPath = entry?.types;
    if (dtsPath === undefined) continue;

    test(`${key} type declarations are stable`, () => {
      const fullPath = path.join(PKG_ROOT, dtsPath);
      if (!fs.existsSync(fullPath)) {
        // Not built yet — skip gracefully in dev
        return;
      }
      const dts = fs.readFileSync(fullPath, "utf8");
      expect(dts).toMatchSnapshot();
    });
  }
});

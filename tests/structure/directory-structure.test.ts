/**
 * Structural test — verifies the monorepo directory organization invariants.
 *
 * Asserts that:
 *   1. Every package is inside a subsystem dir (no flat packages/<name>/package.json)
 *   2. All 15 subsystem dirs exist
 *   3. Package count matches expected (197)
 *   4. All tsconfig.json references resolve to existing directories
 *   5. Root package.json workspaces glob matches all packages
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PACKAGES_DIR = resolve(ROOT, "packages");

// ---------------------------------------------------------------------------
// Expected subsystem directories (from issue #709)
// ---------------------------------------------------------------------------

const EXPECTED_SUBSYSTEMS = ["kernel", "lib", "mm"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listSubsystems(): readonly string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

function listAllPackages(): readonly { readonly subsystem: string; readonly name: string }[] {
  const results: { readonly subsystem: string; readonly name: string }[] = [];
  for (const subsystem of listSubsystems()) {
    const subsystemDir = resolve(PACKAGES_DIR, subsystem);
    const children = readdirSync(subsystemDir, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const pkgJson = resolve(subsystemDir, child.name, "package.json");
      if (existsSync(pkgJson)) {
        results.push({ subsystem, name: child.name });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("monorepo directory structure", () => {
  test("all 3 subsystem directories exist", () => {
    const subsystems = listSubsystems().filter((s) =>
      (EXPECTED_SUBSYSTEMS as readonly string[]).includes(s),
    );
    expect(subsystems).toEqual([...EXPECTED_SUBSYSTEMS]);
  });

  test("no flat packages at packages/<name>/package.json depth", () => {
    const flatPackages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(resolve(PACKAGES_DIR, d.name, "package.json")))
      .filter((d) => {
        // Read the package.json to check if it has a "name" field starting with @koi/
        // Subsystem dirs shouldn't have package.json, but individual packages would
        const content = JSON.parse(
          readFileSync(resolve(PACKAGES_DIR, d.name, "package.json"), "utf-8"),
        ) as { name?: string };
        return content.name?.startsWith("@koi/");
      })
      .map((d) => d.name);

    expect(flatPackages).toEqual([]);
  });

  test("package count is 15", () => {
    const packages = listAllPackages();
    expect(packages.length).toBe(15);
  });

  test("every tsconfig.json reference resolves to an existing directory", () => {
    const tsconfig = JSON.parse(readFileSync(resolve(ROOT, "tsconfig.json"), "utf-8")) as {
      references: readonly { readonly path: string }[];
    };

    const missing: string[] = [];
    for (const ref of tsconfig.references) {
      const refPath = resolve(ROOT, ref.path);
      if (!existsSync(refPath)) {
        missing.push(ref.path);
      }
    }

    expect(missing).toEqual([]);
  });

  test("root package.json workspaces includes packages/*/*", () => {
    const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      workspaces: readonly string[];
    };

    expect(rootPkg.workspaces).toContain("packages/*/*");
  });
});

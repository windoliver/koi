#!/usr/bin/env bun
/**
 * Layer dependency enforcement — validates the 4-layer architecture.
 *
 * Rules:
 *   L0 (@koi/core):     zero @koi/* dependencies
 *   L1 (@koi/engine):   depends on @koi/core only
 *   L2 (everything else): depends on @koi/core only
 *     Exception: utility packages (@koi/errors, @koi/test-utils) may be
 *     depended upon by other L2 packages for shared infrastructure.
 *
 * Also verifies no L2→L1 imports via source file scanning.
 *
 * Usage: bun scripts/check-layers.ts
 */

import { readdir } from "node:fs/promises";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

// --- Layer classification ---

const L0_PACKAGES = new Set(["@koi/core"]);
const L1_PACKAGES = new Set(["@koi/engine"]);
/** Utility L2 packages that other L2 packages may depend on. */
const UTILITY_L2 = new Set(["@koi/errors", "@koi/test-utils"]);

// --- Main ---

interface Violation {
  readonly pkg: string;
  readonly message: string;
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const dirs = await readdir(PACKAGES_DIR, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const pkgPath = `${PACKAGES_DIR}${dir.name}/package.json`;
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) continue;

    const pkg = (await file.json()) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const koiDeps = getKoiDeps(pkg.dependencies);
    const koiDevDeps = getKoiDeps(pkg.devDependencies);
    const allKoiDeps = [...koiDeps, ...koiDevDeps];

    // --- L0: must have ZERO @koi/* deps ---
    if (L0_PACKAGES.has(pkg.name)) {
      if (allKoiDeps.length > 0) {
        violations.push({
          pkg: pkg.name,
          message: `L0 package must have zero @koi/* dependencies, found: ${allKoiDeps.join(", ")}`,
        });
      }
      continue;
    }

    // --- L1: may only depend on @koi/core ---
    if (L1_PACKAGES.has(pkg.name)) {
      const badDeps = koiDeps.filter((d) => !L0_PACKAGES.has(d));
      if (badDeps.length > 0) {
        violations.push({
          pkg: pkg.name,
          message: `L1 package may only depend on @koi/core, found: ${badDeps.join(", ")}`,
        });
      }
      continue;
    }

    // --- L2: may only depend on @koi/core + utility L2 packages ---
    const allowedDeps = new Set([...L0_PACKAGES, ...UTILITY_L2]);
    const badDeps = koiDeps.filter((d) => !allowedDeps.has(d));
    if (badDeps.length > 0) {
      violations.push({
        pkg: pkg.name,
        message: `L2 package may only depend on @koi/core and utility packages, found: ${badDeps.join(", ")}`,
      });
    }

    // L2 must NEVER depend on L1 (even as devDep)
    const l1Deps = allKoiDeps.filter((d) => L1_PACKAGES.has(d));
    if (l1Deps.length > 0) {
      violations.push({
        pkg: pkg.name,
        message: `L2 package must never depend on L1 (@koi/engine), found: ${l1Deps.join(", ")}`,
      });
    }
  }

  // --- Source file scan: check for @koi/engine imports in L2 packages ---
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const pkgPath = `${PACKAGES_DIR}${dir.name}/package.json`;
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) continue;

    const pkg = (await file.json()) as { name: string };
    if (L0_PACKAGES.has(pkg.name) || L1_PACKAGES.has(pkg.name)) continue;

    const srcDir = `${PACKAGES_DIR}${dir.name}/src`;
    if (!(await Bun.file(`${srcDir}/../package.json`).exists())) continue;

    const importViolations = await scanImports(srcDir, pkg.name);
    violations.push(...importViolations);
  }

  if (violations.length === 0) {
    console.log("✅ Layer check passed — all packages respect layer boundaries.");
    process.exit(0);
  }

  console.error("❌ Layer violations found:\n");
  for (const v of violations) {
    console.error(`  ${v.pkg}: ${v.message}`);
  }
  console.error(`\n${violations.length} violation(s) found.`);
  process.exit(1);
}

// --- Helpers ---

function getKoiDeps(deps: Record<string, string> | undefined): readonly string[] {
  if (!deps) return [];
  return Object.keys(deps).filter((name) => name.startsWith("@koi/"));
}

async function scanImports(dir: string, pkgName: string): Promise<readonly Violation[]> {
  const violations: Violation[] = [];
  const glob = new Bun.Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    const content = await Bun.file(file).text();
    const lines = content.split("\n");

    // Regex for static imports: import ... from "@koi/engine"
    const staticImportRe = /(?:^|\s)(?:import\s+.*\s+from\s+|from\s+)['"]@koi\/engine/;
    // Regex for dynamic imports: import("@koi/engine")
    const dynamicImportRe = /import\s*\(\s*['"]@koi\/engine/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      // Fast path: skip lines that don't mention @koi/engine at all
      if (!line.includes("@koi/engine")) continue;

      // Skip full-line comments
      const trimmed = line.trimStart();
      if (/^(?:\/\/|\/\*|\*)/.test(trimmed)) continue;

      // Check for static or dynamic imports from @koi/engine
      if (staticImportRe.test(line) || dynamicImportRe.test(line)) {
        const relativePath = file.replace(dir, "src");
        violations.push({
          pkg: pkgName,
          message: `L2 source imports from L1 (@koi/engine) at ${relativePath}:${i + 1}`,
        });
      }
    }
  }

  return violations;
}

await main();

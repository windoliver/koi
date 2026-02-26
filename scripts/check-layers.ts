#!/usr/bin/env bun
/**
 * Layer dependency enforcement — validates the 4-layer architecture.
 *
 * Rules:
 *   L0  (@koi/core):       zero @koi/* dependencies
 *   L0u (utility packages): depend on @koi/core only
 *   L1  (@koi/engine):      depends on L0 + L0u only
 *   L2  (feature packages): runtime deps on L0 + L0u only;
 *                            devDependencies may include L1 + L2 (for tests)
 *   L3  (meta-packages):    may depend on any layer
 *
 * Source scan: L2 non-test source files must not import from L1.
 *
 * Usage: bun scripts/check-layers.ts
 */

import { readdir } from "node:fs/promises";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

// --- Layer classification ---

const L0_PACKAGES = new Set(["@koi/core"]);
/** L0-utility packages — pure helpers with no business logic, depend on L0 only. */
const L0U_PACKAGES = new Set([
  "@koi/channel-base",
  "@koi/errors",
  "@koi/execution-context",
  "@koi/hash",
  "@koi/manifest",
  "@koi/sandbox-cloud-base",
  "@koi/shutdown",
  "@koi/skill-scanner",
  "@koi/snapshot-chain-store",
  "@koi/test-utils",
  "@koi/validation",
]);
const L1_PACKAGES = new Set(["@koi/engine"]);
/** Meta-packages that bundle L0 + L1 + L2 — no new logic, only re-exports / orchestration. */
const L3_PACKAGES = new Set(["@koi/cli", "@koi/starter"]);

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

    // --- L0u: may depend on L0 + peer L0u ---
    if (L0U_PACKAGES.has(pkg.name)) {
      const allowedL0u = new Set([...L0_PACKAGES, ...L0U_PACKAGES]);
      const badDeps = koiDeps.filter((d) => !allowedL0u.has(d));
      if (badDeps.length > 0) {
        violations.push({
          pkg: pkg.name,
          message: `L0u package may only depend on L0 + L0u, found: ${badDeps.join(", ")}`,
        });
      }
      continue;
    }

    // --- L1: may depend on L0 + L0u ---
    if (L1_PACKAGES.has(pkg.name)) {
      const allowedL1 = new Set([...L0_PACKAGES, ...L0U_PACKAGES]);
      const badDeps = koiDeps.filter((d) => !allowedL1.has(d));
      if (badDeps.length > 0) {
        violations.push({
          pkg: pkg.name,
          message: `L1 package may only depend on L0 + L0u, found: ${badDeps.join(", ")}`,
        });
      }
      continue;
    }

    // --- L3: may depend on any layer (meta-package / orchestrator) ---
    if (L3_PACKAGES.has(pkg.name)) {
      continue;
    }

    // --- L2: runtime deps on L0 + L0u only; devDeps may include L1 + L2 (for tests) ---
    const allowedRuntime = new Set([...L0_PACKAGES, ...L0U_PACKAGES]);
    const badDeps = koiDeps.filter((d) => !allowedRuntime.has(d));
    if (badDeps.length > 0) {
      violations.push({
        pkg: pkg.name,
        message: `L2 runtime deps may only include L0 + L0u, found: ${badDeps.join(", ")}`,
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
    // Skip L0, L0u, L1, and L3 — only L2 source is constrained
    if (
      L0_PACKAGES.has(pkg.name) ||
      L0U_PACKAGES.has(pkg.name) ||
      L1_PACKAGES.has(pkg.name) ||
      L3_PACKAGES.has(pkg.name)
    )
      continue;

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

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".e2e.test.ts") ||
    filePath.endsWith(".spec.ts")
  );
}

async function scanImports(dir: string, pkgName: string): Promise<readonly Violation[]> {
  const violations: Violation[] = [];
  const glob = new Bun.Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    // Skip test files — L2 tests are allowed to import L1 for integration/E2E
    if (isTestFile(file)) continue;

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

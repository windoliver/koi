#!/usr/bin/env bun
/**
 * Layer dependency enforcement — validates the 4-layer architecture.
 *
 * Rules:
 *   L0  (@koi/core):       zero @koi/* dependencies; zero external source imports
 *   L0u (utility packages): depend on @koi/core + peer L0u only
 *   L1  (@koi/engine):      depends on L0 + L0u only
 *   L2  (feature packages): runtime deps on L0 + L0u only;
 *                            devDependencies may include L1 + L2 (for tests)
 *   L3  (meta-packages):    may depend on any layer
 *
 * Source scan: L0 source files must not import external modules.
 * Source scan: L2 non-test source files must not import from L1.
 *
 * Usage: bun scripts/check-layers.ts
 */

import { readdir } from "node:fs/promises";
import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES } from "./layers.js";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

// --- Violation type ---

interface Violation {
  readonly pkg: string;
  readonly message: string;
}

// --- L0 runtime code allowlist ---

/**
 * Files in @koi/core (L0) permitted to have function bodies.
 * Each entry is a relative path from packages/core/src/.
 *
 * All functions in these files are either branded type constructors,
 * pure type guards, validation helpers, error factories, or
 * pure data constructors — side-effect-free operations permitted
 * per the architecture doc's L0 exceptions.
 *
 * Adding a new file here requires PR review to confirm it meets L0 criteria.
 */
export const L0_RUNTIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "ecs.ts",
  "error-factories.ts",
  "validation-utils.ts",
  "capability-registry.ts",
  "capability.ts",
  "handoff.ts",
  "harness.ts",
  "engine.ts",
  "intent-capsule.ts",
  "lifecycle.ts",
  "task-board.ts",
  "scheduler.ts",
  "version-types.ts",
  "mailbox.ts",
  "proposal.ts",
  "snapshot-chain.ts",
  "skill-registry.ts",
  "agent-state-event.ts",
  "bundle-types.ts",
  "brick-snapshot.ts",
  "delegation.ts",
  "governance.ts",
  "create-service-provider.ts",
  "create-single-tool-provider.ts",
  "zone.ts",
]);

// --- Predicates (exported for testing) ---

/**
 * Returns true if the import specifier is a violation in an L0 source file.
 * L0 may only use relative imports — any external module specifier is forbidden.
 */
export function isL0Violation(specifier: string): boolean {
  return !specifier.startsWith("./") && !specifier.startsWith("../");
}

/**
 * Returns true if the import specifier is a violation in an L2 source file.
 * L2 non-test source must not import from L1 (@koi/engine).
 */
export function isL2Violation(specifier: string): boolean {
  return specifier === "@koi/engine" || specifier.startsWith("@koi/engine/");
}

// --- Shared scanner ---

/**
 * Extracts all import specifiers from TypeScript source using Bun.Transpiler AST.
 * Handles static imports, dynamic imports, export-from, and type-only imports.
 * Comments are ignored (AST-based, not regex).
 *
 * Note: Bun.Transpiler omits type-only imports (erased at build time), so a regex pass
 * supplements the scan to catch `import type { X } from "pkg"` lines.
 */
export function extractImportSpecifiers(source: string): readonly string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const { imports } = transpiler.scan(source);
  const specifiers = new Set(imports.map((imp) => imp.path));

  // Supplement: capture type-only imports omitted by Bun.Transpiler.
  // Skips lines that begin with // or * (block comment body).
  const lines = source.split("\n");
  const typeImportRe = /\bimport\s+type\b.*?\bfrom\s+['"]([^'"]+)['"]/;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const match = typeImportRe.exec(line);
    if (match?.[1] !== undefined) specifiers.add(match[1]);
  }

  return [...specifiers];
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".e2e.test.ts") ||
    filePath.endsWith(".spec.ts")
  );
}

/**
 * Scans all non-test TypeScript files in `dir` for import violations.
 * Uses Bun.Transpiler AST — comment lines and type-only imports are handled correctly.
 *
 * @param dir - Absolute path to the source directory to scan
 * @param pkgName - Package name for violation messages
 * @param isViolation - Predicate: returns true if the import specifier is forbidden
 * @param makeMessage - Formats the violation message given the specifier and relative file path
 */
export async function scanFilesForViolations(
  dir: string,
  pkgName: string,
  isViolation: (specifier: string) => boolean,
  makeMessage: (specifier: string, relPath: string) => string,
): Promise<readonly Violation[]> {
  const violations: Violation[] = [];
  const glob = new Bun.Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    if (isTestFile(file)) continue;

    const source = await Bun.file(file).text();
    const specifiers = extractImportSpecifiers(source);

    for (const specifier of specifiers) {
      if (isViolation(specifier)) {
        const relPath = file.startsWith(dir) ? `src${file.slice(dir.length)}` : file;
        violations.push({ pkg: pkgName, message: makeMessage(specifier, relPath) });
      }
    }
  }

  return violations;
}

// --- L0 anti-leak scan ---

const CLASS_RE = /^\s*(export\s+)?(abstract\s+)?class\s+/;
const FUNCTION_RE = /^\s*(export\s+)?(async\s+)?function\s+/;
const EXPORTED_ARROW_RE = /^\s*export\s+const\s+\w+\s*=\s*(async\s*)?\(/;

/**
 * Returns true if a trimmed, non-comment line declares a class.
 */
export function isClassDeclaration(line: string): boolean {
  return CLASS_RE.test(line);
}

/**
 * Returns true if a trimmed, non-comment line declares a function body
 * (`function`, `export function`, or `export const x = (`).
 */
export function isFunctionBody(line: string): boolean {
  return FUNCTION_RE.test(line) || EXPORTED_ARROW_RE.test(line);
}

/**
 * Scans @koi/core source for class declarations and unlisted function bodies.
 *
 * Rules:
 *   - Class declarations are always forbidden in L0 (no exceptions)
 *   - Function bodies are forbidden unless the file is in L0_RUNTIME_ALLOWLIST
 */
export async function scanL0ForRuntimeCode(dir: string): Promise<readonly Violation[]> {
  const violations: Violation[] = [];
  const glob = new Bun.Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    if (isTestFile(file)) continue;

    const source = await Bun.file(file).text();
    const lines = source.split("\n");
    const relPath = file.startsWith(dir) ? file.slice(dir.length + 1) : file;

    let hasClass = false;
    let hasFunctionBody = false;

    for (const line of lines) {
      if (hasClass && hasFunctionBody) break;
      const trimmed = line.trimStart();
      // Skip comment lines
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

      if (!hasClass && isClassDeclaration(trimmed)) hasClass = true;
      if (!hasFunctionBody && isFunctionBody(trimmed)) hasFunctionBody = true;
    }

    if (hasClass) {
      violations.push({
        pkg: "@koi/core",
        message: `L0 must not contain class declarations: ${relPath}`,
      });
    }

    if (hasFunctionBody && !L0_RUNTIME_ALLOWLIST.has(relPath)) {
      violations.push({
        pkg: "@koi/core",
        message: `L0 file has function bodies but is not in L0_RUNTIME_ALLOWLIST: ${relPath}`,
      });
    }
  }

  return violations;
}

// --- Package.json dep helpers ---

function getKoiDeps(deps: Record<string, string> | undefined): readonly string[] {
  if (!deps) return [];
  return Object.keys(deps).filter((name) => name.startsWith("@koi/"));
}

// --- Main ---

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const dirs = await readdir(PACKAGES_DIR, { withFileTypes: true });

  // ── 1. package.json dependency checks ──────────────────────────────────────

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

  // ── 2. L0 source scan: @koi/core must not import any external module ───────

  const coreSrcDir = `${PACKAGES_DIR}core/src`;
  if (await Bun.file(`${PACKAGES_DIR}core/package.json`).exists()) {
    const l0Violations = await scanFilesForViolations(
      coreSrcDir,
      "@koi/core",
      isL0Violation,
      (specifier, relPath) =>
        `L0 source must not import external modules: '${specifier}' at ${relPath}`,
    );
    violations.push(...l0Violations);
  }

  // ── 3. L2 source scan: non-test files must not import from L1 ─────────────

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const pkgPath = `${PACKAGES_DIR}${dir.name}/package.json`;
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) continue;

    const pkg = (await file.json()) as { name: string };
    // Only L2 source is constrained — skip L0, L0u, L1, and L3
    if (
      L0_PACKAGES.has(pkg.name) ||
      L0U_PACKAGES.has(pkg.name) ||
      L1_PACKAGES.has(pkg.name) ||
      L3_PACKAGES.has(pkg.name)
    )
      continue;

    const srcDir = `${PACKAGES_DIR}${dir.name}/src`;
    if (!(await Bun.file(`${srcDir}/../package.json`).exists())) continue;

    const l2Violations = await scanFilesForViolations(
      srcDir,
      pkg.name,
      isL2Violation,
      (_specifier, relPath) => `L2 source imports from L1 (@koi/engine) at ${relPath}`,
    );
    violations.push(...l2Violations);
  }

  // ── 4. L0 anti-leak: no classes, no unlisted function bodies ───────────────

  if (await Bun.file(`${PACKAGES_DIR}core/package.json`).exists()) {
    const l0RuntimeViolations = await scanL0ForRuntimeCode(coreSrcDir);
    violations.push(...l0RuntimeViolations);
  }

  // ── Report ─────────────────────────────────────────────────────────────────

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

if (import.meta.main) {
  await main();
}

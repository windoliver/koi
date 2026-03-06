#!/usr/bin/env bun
/**
 * Layer dependency enforcement — validates the 4-layer architecture.
 *
 * Rules:
 *   L0  (@koi/core):       zero @koi/* dependencies; zero external source imports; no class declarations
 *   L0u (utility packages): depend on @koi/core + peer L0u only; source must not import L1 or L2
 *   L1  (@koi/engine):      depends on L0 + L0u only
 *   L2  (feature packages): runtime deps on L0 + L0u only;
 *                            devDependencies may include L1 + L2 (for tests)
 *   L3  (meta-packages):    may depend on any layer
 *
 * Source scan: L0 source files must not import external modules or declare classes.
 * Source scan: L0u non-test source files must not import from L1 or L2.
 * Source scan: L2 non-test source files must not import from L1.
 *
 * Usage: bun scripts/check-layers.ts
 */

import { readdir } from "node:fs/promises";
import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES } from "./layers.js";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

// Module-level singleton — Bun.Transpiler is stateless; no need to reinstantiate per file.
const TRANSPILER = new Bun.Transpiler({ loader: "ts" });

// --- Violation type ---

interface Violation {
  readonly pkg: string;
  readonly message: string;
}

// --- L0 runtime code allowlist ---

/**
 * Files in @koi/core (L0) permitted to have function bodies.
 * Each entry is a relative path from packages/kernel/core/src/.
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
  "thread.ts",
  "transcript.ts",
  "skill-registry.ts",
  "agent-state-event.ts",
  "bundle-types.ts",
  "brick-snapshot.ts",
  "delegation.ts",
  "governance.ts",
  "create-service-provider.ts",
  "create-single-tool-provider.ts",
  "zone.ts",
  "debug.ts",
  "scratchpad.ts",
  "workspace.ts",
  "assembly.ts",
  "process-descriptor.ts",
  "nexus-path.ts",
  "forge-types.ts",
  "delivery.ts",
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

/**
 * Returns true if the import specifier is a violation in an L0u source file.
 * L0u non-test source may only import from L0 (@koi/core) and peer L0u packages.
 * Forbidden: L1 (@koi/engine) and any L2 @koi/* package.
 */
export function isL0uViolation(specifier: string): boolean {
  if (!specifier.startsWith("@koi/")) return false; // external or relative — allowed
  // Strip subpath: "@koi/engine/foo" → "@koi/engine"
  const parts = specifier.split("/");
  const basePkg = `${parts[0] ?? ""}/${parts[1] ?? ""}`;
  if (L0_PACKAGES.has(basePkg)) return false; // L0 (@koi/core) — allowed
  if (L0U_PACKAGES.has(basePkg)) return false; // peer L0u — allowed
  return true; // L1 (@koi/engine) or any L2 — forbidden
}

/**
 * Returns true if the (non-comment) line contains a class declaration.
 * Class declarations are forbidden in @koi/core (L0 is interfaces-only).
 *
 * Note: the caller is responsible for filtering comment lines before calling this.
 */
export function isL0ClassViolation(line: string): boolean {
  // \b ensures "class" is matched as a keyword, not as part of identifiers
  // like "classifyItems". Requires whitespace after "class" followed by a word char.
  return /\bclass\s+\w/.test(line);
}

// --- Shared scanner ---

/**
 * Extracts all import specifiers from TypeScript source using Bun.Transpiler AST.
 * Handles static imports, dynamic imports, export-from, and type-only imports.
 * Comments are ignored (AST-based, not regex).
 *
 * Note: Bun.Transpiler omits type-only imports (erased at build time), so a regex pass
 * supplements the scan to catch `import type { X } from "pkg"` — including multiline forms.
 */
export function extractImportSpecifiers(source: string): readonly string[] {
  const { imports } = TRANSPILER.scan(source);
  const specifiers = new Set(imports.map((imp) => imp.path));

  // Supplement: capture type-only imports omitted by Bun.Transpiler.
  // Strip comment lines, then match the entire source (including multiline imports)
  // using a dotall regex so `import type {\n  Foo,\n  Bar\n} from "pkg"` is caught.
  const strippedSource = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");

  // [^'"]*  matches anything except quotes (including newlines) — handles multiline imports.
  // The `g` flag finds all occurrences; combined they cover all type import forms.
  const typeImportRe = /\bimport\s+type\b[^'"]*from\s+['"]([^'"]+)['"]/g;
  for (const match of strippedSource.matchAll(typeImportRe)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.add(specifier);
  }

  return [...specifiers];
}

/**
 * Returns true if the file path should be treated as a test file (skipped during source scans).
 */
export function isTestFile(filePath: string): boolean {
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
  const glob = new Bun.Glob("**/*.ts");
  const fileViolationGroups = await Promise.all(
    (await Array.fromAsync(glob.scan({ cwd: dir, absolute: true })))
      .filter((file) => !isTestFile(file))
      .map(async (file): Promise<readonly Violation[]> => {
        const source = await Bun.file(file).text();
        const specifiers = extractImportSpecifiers(source);
        const relPath = file.startsWith(dir) ? `src${file.slice(dir.length)}` : file;
        return specifiers
          .filter(isViolation)
          .map((specifier) => ({ pkg: pkgName, message: makeMessage(specifier, relPath) }));
      }),
  );
  return fileViolationGroups.flat();
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

// --- L0 class declaration scanner ---

async function scanL0ClassViolations(srcDir: string): Promise<readonly Violation[]> {
  const glob = new Bun.Glob("**/*.ts");
  const fileViolationGroups = await Promise.all(
    (await Array.fromAsync(glob.scan({ cwd: srcDir, absolute: true })))
      .filter((file) => !isTestFile(file))
      .map(async (file): Promise<readonly Violation[]> => {
        const source = await Bun.file(file).text();
        const relPath = file.startsWith(srcDir) ? `src${file.slice(srcDir.length)}` : file;
        return source
          .split("\n")
          .filter((line) => {
            const trimmed = line.trimStart();
            return (
              !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
            );
          })
          .filter(isL0ClassViolation)
          .map((line) => ({
            pkg: "@koi/core",
            message: `L0 must not contain class declarations at ${relPath}: '${line.trimStart().slice(0, 80)}'`,
          }));
      }),
  );
  return fileViolationGroups.flat();
}

// --- Package directory listing (2-level deep) ---

/**
 * Lists package directories at 2 levels deep: packages/<subsystem>/<name>/.
 * Returns objects with `name` (the package directory name) and `path` (absolute path).
 */
async function listPackageDirs(): Promise<
  readonly { readonly name: string; readonly path: string }[]
> {
  const subsystems = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const results: { readonly name: string; readonly path: string }[] = [];
  for (const sub of subsystems) {
    if (!sub.isDirectory()) continue;
    const subPath = `${PACKAGES_DIR}${sub.name}`;
    const children = await readdir(subPath, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      results.push({ name: child.name, path: `${subPath}/${child.name}` });
    }
  }
  return results;
}

// --- Main ---

async function main(): Promise<void> {
  const dirs = await listPackageDirs();

  // ── 1. package.json dependency checks ──────────────────────────────────────

  const pkgViolationGroups = await Promise.all(
    dirs.map(async (dir): Promise<readonly Violation[]> => {
      const pkgPath = `${dir.path}/package.json`;
      const file = Bun.file(pkgPath);
      if (!(await file.exists())) return [];

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
          return [
            {
              pkg: pkg.name,
              message: `L0 package must have zero @koi/* dependencies, found: ${allKoiDeps.join(", ")}`,
            },
          ];
        }
        return [];
      }

      // --- L0u: may depend on L0 + peer L0u ---
      if (L0U_PACKAGES.has(pkg.name)) {
        const allowedL0u = new Set([...L0_PACKAGES, ...L0U_PACKAGES]);
        const badDeps = koiDeps.filter((d) => !allowedL0u.has(d));
        if (badDeps.length > 0) {
          return [
            {
              pkg: pkg.name,
              message: `L0u package may only depend on L0 + L0u, found: ${badDeps.join(", ")}`,
            },
          ];
        }
        return [];
      }

      // --- L1: may depend on L0 + L0u ---
      if (L1_PACKAGES.has(pkg.name)) {
        const allowedL1 = new Set([...L0_PACKAGES, ...L0U_PACKAGES]);
        const badDeps = koiDeps.filter((d) => !allowedL1.has(d));
        if (badDeps.length > 0) {
          return [
            {
              pkg: pkg.name,
              message: `L1 package may only depend on L0 + L0u, found: ${badDeps.join(", ")}`,
            },
          ];
        }
        return [];
      }

      // --- L3: may depend on any layer (meta-package / orchestrator) ---
      if (L3_PACKAGES.has(pkg.name)) {
        return [];
      }

      // --- L2: runtime deps on L0 + L0u only; devDeps may include L1 + L2 (for tests) ---
      const allowedRuntime = new Set([...L0_PACKAGES, ...L0U_PACKAGES]);
      const badDeps = koiDeps.filter((d) => !allowedRuntime.has(d));
      if (badDeps.length > 0) {
        return [
          {
            pkg: pkg.name,
            message: `L2 runtime deps may only include L0 + L0u, found: ${badDeps.join(", ")}`,
          },
        ];
      }
      return [];
    }),
  );

  const pkgViolations = pkgViolationGroups.flat();

  // ── 2. L0 source scans: @koi/core must not import external modules or declare classes ──

  const coreSrcDir = `${PACKAGES_DIR}kernel/core/src`;
  const coreExists = await Bun.file(`${PACKAGES_DIR}kernel/core/package.json`).exists();

  const [l0ImportViolations, l0ClassViolations] = coreExists
    ? await Promise.all([
        scanFilesForViolations(
          coreSrcDir,
          "@koi/core",
          isL0Violation,
          (specifier, relPath) =>
            `L0 source must not import external modules: '${specifier}' at ${relPath}`,
        ),
        scanL0ClassViolations(coreSrcDir),
      ])
    : [[], []];

  // ── 3. L0u source scan: non-test files must not import from L1 or L2 ───────

  const l0uViolationGroups = await Promise.all(
    dirs.map(async (dir): Promise<readonly Violation[]> => {
      const pkgPath = `${dir.path}/package.json`;
      const file = Bun.file(pkgPath);
      if (!(await file.exists())) return [];
      const pkg = (await file.json()) as { name: string };
      if (!L0U_PACKAGES.has(pkg.name)) return [];

      const srcDir = `${dir.path}/src`;
      return scanFilesForViolations(
        srcDir,
        pkg.name,
        isL0uViolation,
        (specifier, relPath) =>
          `L0u source must not import from L1 or L2: '${specifier}' at ${relPath}`,
      );
    }),
  );

  const l0uViolations = l0uViolationGroups.flat();

  // ── 4. L2 source scan: non-test files must not import from L1 ──────────────

  const l2ViolationGroups = await Promise.all(
    dirs.map(async (dir): Promise<readonly Violation[]> => {
      const pkgPath = `${dir.path}/package.json`;
      const file = Bun.file(pkgPath);
      if (!(await file.exists())) return [];
      const pkg = (await file.json()) as { name: string };

      // Only L2 source is constrained — skip L0, L0u, L1, and L3
      if (
        L0_PACKAGES.has(pkg.name) ||
        L0U_PACKAGES.has(pkg.name) ||
        L1_PACKAGES.has(pkg.name) ||
        L3_PACKAGES.has(pkg.name)
      )
        return [];

      const srcDir = `${dir.path}/src`;
      return scanFilesForViolations(
        srcDir,
        pkg.name,
        isL2Violation,
        (_specifier, relPath) => `L2 source imports from L1 (@koi/engine) at ${relPath}`,
      );
    }),
  );

  const l2Violations = l2ViolationGroups.flat();

  // ── 5. L0 anti-leak: no unlisted function bodies ──────────────────────────

  const l0RuntimeViolations = coreExists ? await scanL0ForRuntimeCode(coreSrcDir) : [];

  // ── Report ─────────────────────────────────────────────────────────────────

  const violations = [
    ...pkgViolations,
    ...l0ImportViolations,
    ...l0ClassViolations,
    ...l0uViolations,
    ...l2Violations,
    ...l0RuntimeViolations,
  ];

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

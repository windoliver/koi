#!/usr/bin/env bun
/**
 * CI enforcement — ensures every L2 package wired into @koi/runtime has
 * corresponding golden query assertions.
 *
 * When a new L2 package is added as a dependency of @koi/runtime, this
 * script checks that the golden query test files reference it (by package
 * name or a related assertion). This enforces the #1188 growth rule:
 * "each new package PR adds assertions to golden queries."
 *
 * Exempt:
 *   - L0 (@koi/core): kernel, everything depends on it
 *   - L1: engine runtime
 *   - L0u: utility packages (no user-facing behavior to test in golden queries)
 *   - Packages listed in GOLDEN_QUERY_EXEMPT
 *
 * Usage: bun scripts/check-golden-queries.ts
 */

import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const ROOT = new URL("../", import.meta.url).pathname;

/** L2 packages exempt from golden query requirements (infrastructure, not user-facing). */
const GOLDEN_QUERY_EXEMPT: ReadonlySet<string> = new Set([
  "@koi/query-engine", // Internal stream consumer, tested via other packages' golden queries
  "@koi/cost-aggregator", // Infrastructure: cost tracking runs outside the agent loop, no tool surface
]);

/** Files that count as golden query test files. */
const GOLDEN_QUERY_GLOBS = [
  "packages/meta/runtime/src/__tests__/golden-queries.test.ts",
  "packages/meta/runtime/src/__tests__/golden-replay.test.ts",
];

function isExemptFromGoldenQueries(name: string): boolean {
  return (
    L0_PACKAGES.has(name) ||
    L0U_PACKAGES.has(name) ||
    L1_PACKAGES.has(name) ||
    L3_PACKAGES.has(name) ||
    L4_PACKAGES.has(name) ||
    GOLDEN_QUERY_EXEMPT.has(name)
  );
}

async function main(): Promise<void> {
  // 1. Read @koi/runtime's dependencies
  const runtimePkgPath = `${ROOT}packages/meta/runtime/package.json`;
  const runtimePkgFile = Bun.file(runtimePkgPath);
  if (!(await runtimePkgFile.exists())) {
    console.log("⏭️  @koi/runtime not found — skipping golden query check.");
    return;
  }

  const runtimePkg = (await runtimePkgFile.json()) as {
    readonly dependencies?: Record<string, string>;
  };
  const runtimeDeps = Object.keys(runtimePkg.dependencies ?? {}).filter((d) =>
    d.startsWith("@koi/"),
  );

  // 2. Find L2 deps that need golden query coverage
  const l2DepsNeedingCoverage = runtimeDeps.filter((dep) => !isExemptFromGoldenQueries(dep));

  if (l2DepsNeedingCoverage.length === 0) {
    console.log("✅ No L2 dependencies in @koi/runtime require golden query coverage.");
    return;
  }

  // 3. Read all golden query test file contents
  const goldenContent: string[] = [];
  for (const glob of GOLDEN_QUERY_GLOBS) {
    const file = Bun.file(`${ROOT}${glob}`);
    if (await file.exists()) {
      goldenContent.push(await file.text());
    }
  }
  const combinedContent = goldenContent.join("\n");

  // 4. Check each L2 dep is referenced in golden queries
  const missing: string[] = [];

  for (const dep of l2DepsNeedingCoverage) {
    // Check for package name reference (import, comment, or string literal)
    const shortName = dep.replace("@koi/", "");
    const hasReference =
      combinedContent.includes(dep) ||
      combinedContent.includes(shortName) ||
      combinedContent.includes(`from "${dep}"`) ||
      combinedContent.includes(`from '${dep}'`);

    if (!hasReference) {
      missing.push(dep);
    }
  }

  if (missing.length === 0) {
    console.log(
      `✅ All ${l2DepsNeedingCoverage.length} L2 runtime dependencies have golden query coverage.`,
    );
    return;
  }

  console.error(
    `\n${missing.length} L2 package(s) wired into @koi/runtime without golden query assertions:\n`,
  );
  for (const dep of missing.sort()) {
    console.error(`  ✗ ${dep}`);
  }
  console.error(
    "\n  Fix: add assertions to packages/meta/runtime/src/__tests__/golden-queries.test.ts" +
      "\n  or packages/meta/runtime/src/__tests__/golden-replay.test.ts" +
      "\n  that exercise this package's behavior." +
      `\n  To exempt, add to GOLDEN_QUERY_EXEMPT in scripts/check-golden-queries.ts.\n`,
  );
  process.exit(1);
}

await main();

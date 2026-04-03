#!/usr/bin/env bun
/**
 * CI enforcement — if any L2 package source changed, trajectory fixtures
 * must be re-recorded in the same PR.
 *
 * Prevents shipping L2 behavior changes without updating the golden
 * ATIF trajectories that CI replays.
 *
 * How it works:
 *   1. Diffs the current branch against the base branch (main)
 *   2. If any L2 source files changed (packages/ ** /src/ **.ts)
 *   3. Then trajectory fixtures must also be in the diff
 *   4. Fails if L2 changed but no fixture updates
 *
 * Skip: set SKIP_TRAJECTORY_CHECK=1 for PRs that intentionally
 * don't affect runtime behavior (docs, tests-only, CI config).
 *
 * Usage: bun scripts/check-trajectories.ts [--base main]
 */

import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES, L4_PACKAGES } from "./layers.js";

const BASE_BRANCH = process.argv.includes("--base")
  ? (process.argv[process.argv.indexOf("--base") + 1] ?? "main")
  : "main";

const FIXTURE_DIR = "packages/meta/runtime/fixtures/";
const TRAJECTORY_SUFFIX = ".trajectory.json";

/** Packages exempt from trajectory update requirements. */
const TRAJECTORY_EXEMPT: ReadonlySet<string> = new Set([
  // Add packages here that don't affect runtime behavior
]);

function isL2Package(pkgName: string): boolean {
  return (
    pkgName.startsWith("@koi/") &&
    !L0_PACKAGES.has(pkgName) &&
    !L0U_PACKAGES.has(pkgName) &&
    !L1_PACKAGES.has(pkgName) &&
    !L3_PACKAGES.has(pkgName) &&
    !L4_PACKAGES.has(pkgName) &&
    !TRAJECTORY_EXEMPT.has(pkgName)
  );
}

/** Extract @koi/package-name from a file path like packages/lib/foo/src/bar.ts */
function extractPackageName(filePath: string): string | undefined {
  const match = /^packages\/[^/]+\/([^/]+)\//.exec(filePath);
  if (match?.[1] === undefined) return undefined;
  return `@koi/${match[1]}`;
}

async function main(): Promise<void> {
  if (process.env.SKIP_TRAJECTORY_CHECK === "1") {
    console.log("⏭️  SKIP_TRAJECTORY_CHECK=1 — skipping trajectory freshness check.");
    return;
  }

  // Get changed files vs base branch
  const diffResult = Bun.spawnSync(["git", "diff", "--name-only", `${BASE_BRANCH}...HEAD`]);
  if (diffResult.exitCode !== 0) {
    // Not on a branch or no base — skip gracefully
    console.log("⏭️  Cannot diff against base branch — skipping trajectory check.");
    return;
  }

  const changedFiles = new TextDecoder()
    .decode(diffResult.stdout)
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  if (changedFiles.length === 0) {
    console.log("✅ No changes — trajectory check passed.");
    return;
  }

  // Find changed L2 source files
  const changedL2Packages = new Set<string>();
  for (const file of changedFiles) {
    // Only source files, not tests or configs
    if (!file.includes("/src/") || !file.endsWith(".ts")) continue;
    // Skip test files
    if (file.includes(".test.ts") || file.includes("__tests__")) continue;

    const pkgName = extractPackageName(file);
    if (pkgName !== undefined && isL2Package(pkgName)) {
      changedL2Packages.add(pkgName);
    }
  }

  if (changedL2Packages.size === 0) {
    console.log("✅ No L2 source changes — trajectory check passed.");
    return;
  }

  // Check if trajectory fixtures were also updated
  const trajectoryUpdated = changedFiles.some(
    (f) => f.startsWith(FIXTURE_DIR) && f.endsWith(TRAJECTORY_SUFFIX),
  );

  if (trajectoryUpdated) {
    console.log(
      `✅ ${String(changedL2Packages.size)} L2 package(s) changed and trajectory fixtures updated.`,
    );
    return;
  }

  // Fail — L2 changed but no trajectory update
  console.error("\n❌ L2 source files changed but trajectory fixtures were not re-recorded.\n");
  console.error("Changed L2 packages:");
  for (const pkg of [...changedL2Packages].sort()) {
    console.error(`  ✗ ${pkg}`);
  }
  console.error(
    "\nFix: re-record trajectories and commit the updated fixtures:" +
      "\n  OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts" +
      "\n  git add packages/meta/runtime/fixtures/" +
      "\n" +
      "\nTo skip (docs/CI-only changes): SKIP_TRAJECTORY_CHECK=1" +
      "\nTo exempt a package: add to TRAJECTORY_EXEMPT in scripts/check-trajectories.ts\n",
  );
  process.exit(1);
}

await main();

#!/usr/bin/env bun
/**
 * CI gate: detects test deletion and test weakening in PRs.
 *
 * Checks:
 * 1. No .test.ts files deleted (unless commit message contains [test-archive])
 * 2. No net decrease in test count (test() / it() calls) in modified test files
 *
 * Usage: bun scripts/check-test-integrity.ts
 */

import { $ } from "bun";

interface Violation {
  readonly file: string;
  readonly reason: string;
}

/** Count test() and it() calls in file content. */
function countTests(content: string): number {
  const testPattern = /\b(?:test|it)\s*\(/g;
  let count = 0;
  while (testPattern.exec(content) !== null) {
    count++;
  }
  return count;
}

async function main(): Promise<void> {
  // Check for escape hatch in recent commit message
  const lastMessage = (await $`git log -1 --format=%B`.text()).trim();
  if (lastMessage.includes("[test-archive]")) {
    console.log("ℹ️  [test-archive] escape hatch detected — skipping test integrity check.");
    return;
  }

  // Determine base branch for comparison.
  // In GitHub Actions PR jobs GITHUB_BASE_REF is set (e.g. "main") but the ref
  // is only available as origin/<branch> after the default checkout action.
  const rawBase = process.env.GITHUB_BASE_REF;
  const baseBranch = rawBase !== undefined ? `origin/${rawBase}` : "origin/main";

  // Get changed files relative to base
  const diffOutput = await $`git diff --name-status ${baseBranch} -- "*.test.ts"`.text();
  const lines = diffOutput.trim().split("\n").filter(Boolean);

  const violations: Violation[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const status = parts[0]?.trim();
    if (status === undefined) continue;

    if (status === "D") {
      const file = parts[1]?.trim();
      if (file === undefined || file.startsWith("archive/")) continue;
      violations.push({ file, reason: "test file deleted" });
      continue;
    }

    // Renames (R###) — the source is parts[1], destination is parts[2].
    // If a test file is renamed OUT of active code (e.g. into archive/),
    // that's effectively a deletion from the active test suite.
    if (status.startsWith("R")) {
      const source = parts[1]?.trim();
      const dest = parts[2]?.trim();
      if (source === undefined || dest === undefined) continue;
      // Only flag if the source was active code and the destination is not
      if (!source.startsWith("archive/") && dest.startsWith("archive/")) {
        violations.push({ file: source, reason: `test file moved to archive (${dest})` });
      }
      continue;
    }

    if (status === "M") {
      const file = parts[1]?.trim();
      if (file === undefined || file.startsWith("archive/")) continue;
      // Compare test count before and after
      try {
        const before = await $`git show ${baseBranch}:${file}`.text();
        const after = await Bun.file(file).text();
        const beforeCount = countTests(before);
        const afterCount = countTests(after);

        if (afterCount < beforeCount) {
          violations.push({
            file,
            reason: `test count decreased: ${beforeCount} → ${afterCount}`,
          });
        }
      } catch {
        // File may not exist in base branch (new file modified) — skip
      }
    }
  }

  if (violations.length > 0) {
    console.error(`❌ ${violations.length} test integrity violation(s):\n`);
    for (const v of violations) {
      console.error(`  ✗ ${v.file}: ${v.reason}`);
    }
    console.error(
      "\n  → Tests must not be deleted or weakened. Use [test-archive] in commit message for legitimate archival.",
    );
    process.exit(1);
  }

  console.log(`✅ Test integrity check passed — ${lines.length} test file(s) reviewed.`);
}

await main();

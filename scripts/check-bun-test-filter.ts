#!/usr/bin/env bun
/**
 * CI gate: detects `bun test --filter=...` invocations in tracked files.
 *
 * `bun test` is the test runner and has no `--filter` flag — it silently
 * ignores unknown flags and walks every workspace test instead of scoping.
 * `--filter` is a Turborepo workspace selector and must be passed via
 * `bun run test`, which delegates to `turbo run test`. See #1788.
 *
 * Usage: bun scripts/check-bun-test-filter.ts
 */

import { $ } from "bun";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const PATTERN = /\bbun\s+test\s+--filter\b/;

const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "scripts/check-bun-test-filter.ts",
  ".claude/plans/issue-1624-loop-until-pass.md",
]);

async function main(): Promise<void> {
  const tracked = (await $`git ls-files`.text()).trim().split("\n").filter(Boolean);

  const violations: Violation[] = [];

  for (const file of tracked) {
    if (ALLOWED_PATHS.has(file)) continue;
    if (file.startsWith("archive/")) continue;
    if (file.startsWith("node_modules/")) continue;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("check:bun-test-filter-ignore")) continue;
      if (PATTERN.test(line)) {
        violations.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }

  if (violations.length > 0) {
    console.error(`❌ ${violations.length} \`bun test --filter\` violation(s):\n`);
    for (const v of violations) {
      console.error(`  ✗ ${v.file}:${v.line}`);
      console.error(`      ${v.text}`);
    }
    console.error(
      "\n  → Use `bun run test --filter=<pkg>` (Turborepo workspace selector via the root `test` script).",
    );
    console.error(
      "    `bun test` is the test runner and has no `--filter` flag — it silently walks every workspace.",
    );
    console.error(
      "    See #1788. Add an exemption to ALLOWED_PATHS only for hypothetical CLI examples.",
    );
    process.exit(1);
  }

  console.log(`✅ check:bun-test-filter passed — ${tracked.length} tracked file(s) scanned.`);
}

await main();

#!/usr/bin/env bun
/**
 * CI gate: detects `bun test ... --filter ...` invocations in tracked files.
 *
 * `bun test` is the test runner and has no `--filter` flag — it silently
 * ignores unknown flags and walks every workspace test instead of scoping.
 * `--filter` is a Turborepo workspace selector and must be passed via
 * `bun run test`, which delegates to `turbo run test`. See #1788.
 *
 * The detector matches any `bun test` command (with intervening positional
 * args, line continuations, or other flags) that also passes `--filter`
 * later in the same logical shell command. It does NOT match `bun run test
 * --filter=...` (the canonical form) or unrelated tokens like
 * `bun test:integration`.
 *
 * Usage: bun scripts/check-bun-test-filter.ts
 */

import { $ } from "bun";

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const IGNORE_MARKER = "check:bun-test-filter-ignore";

const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "scripts/check-bun-test-filter.ts",
  "scripts/check-bun-test-filter.test.ts",
  ".claude/plans/issue-1624-loop-until-pass.md",
]);

/**
 * Join shell line-continuations (lines ending with `\`) into single logical
 * lines while preserving original line numbers via a parallel index array.
 */
interface LogicalLine {
  readonly text: string;
  readonly originLine: number;
}

function joinContinuations(content: string): LogicalLine[] {
  const rawLines = content.split("\n");
  const result: LogicalLine[] = [];
  let buffer = "";
  let bufferStart = 0;
  let inContinuation = false;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    if (!inContinuation) {
      bufferStart = i + 1;
      buffer = "";
    }
    const trimmed = raw.replace(/\\\s*$/, "");
    const continues = /\\\s*$/.test(raw);
    buffer += (inContinuation ? " " : "") + trimmed;
    if (continues) {
      inContinuation = true;
      continue;
    }
    result.push({ text: buffer, originLine: bufferStart });
    inContinuation = false;
  }
  if (inContinuation) {
    result.push({ text: buffer, originLine: bufferStart });
  }
  return result;
}

/**
 * Detect violations in a single file's content.
 *
 * Pattern logic:
 * - `\bbun\s+test\b` matches the literal `bun test` token (word boundaries
 *   exclude `bun test:integration`, `bun testfoo`, and `bunx test`).
 * - `(?![:\w])` rejects `bun test:foo` form.
 * - `[^\n]*?--filter\b` allows any non-newline characters (positional args,
 *   other flags) before `--filter` on the same logical line.
 * - The check runs after line-continuations are joined so multiline shell
 *   commands collapse to one logical line first.
 */
const PATTERN = /\bbun\s+test\b(?![:\w])[^\n]*?--filter\b/;

export function detectViolations(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const logical = joinContinuations(content);
  for (const { text, originLine } of logical) {
    if (text.includes(IGNORE_MARKER)) continue;
    if (PATTERN.test(text)) {
      violations.push({ file, line: originLine, text: text.trim() });
    }
  }
  return violations;
}

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
    violations.push(...detectViolations(file, content));
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

if (import.meta.main) {
  await main();
}

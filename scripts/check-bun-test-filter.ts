#!/usr/bin/env bun
/**
 * CI gate: detects `bun [opts] test [args] --filter ...` invocations.
 *
 * `bun test` is the test runner and has no `--filter` flag — it silently
 * ignores unknown flags and walks every workspace test instead of scoping.
 * `--filter` is a Turborepo workspace selector and must be passed via
 * `bun run test`, which delegates to `turbo run test`. See #1788.
 *
 * Modes:
 *   bun scripts/check-bun-test-filter.ts            scans working tree
 *   bun scripts/check-bun-test-filter.ts --staged   scans staged index only
 *
 * The --staged mode is used by the lefthook pre-commit so we validate the
 * commit payload rather than the mutable working tree. A contributor cannot
 * stage a bad change, edit the file locally, and slip past the gate.
 *
 * The detector is token-aware: it tolerates Bun-level flags before the
 * `test` subcommand, intervening positional args, line continuations, and
 * `--filter=value` / `--filter value` argument forms. It does NOT match
 * `bun run test --filter=...`, `bun test:integration`, or `bunx test`.
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

interface LogicalLine {
  readonly text: string;
  readonly originLine: number;
}

/**
 * Join shell line-continuations (lines ending with `\`) into single logical
 * lines while preserving the origin line number for reporting.
 */
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
 * Token-aware detection of `bun [opts] test [args] --filter ...`.
 *
/**
 * Bun-level flags that consume a following argv token as their value.
 * When skipping these during a walk, also skip the next token so the
 * value does not get mistaken for a subcommand.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--cwd",
  "--config",
  "-c",
  "--port",
  "--define",
  "--external",
  "--loader",
  "--require",
  "-r",
  "--target",
  "--format",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--max-old-space-size",
  "--banner",
  "--footer",
  "--main-fields",
]);

/**
 * Strip Markdown / shell decoration characters that interfere with simple
 * whitespace tokenization. Backticks, single quotes, and double quotes are
 * replaced with spaces so that ``bun test --filter=foo`` (inline code) and
 * `"bun test --filter=foo"` (quoted) tokenize the same as the bare command.
 */
function normalizeLine(line: string): string {
  return line.replace(/[`'"]/g, " ");
}

/**
 * Algorithm:
 *   1. Normalize markdown/shell decoration characters out of the line.
 *   2. Tokenize the logical line on whitespace.
 *   3. For each `bun` token, walk forward through flag tokens (starting
 *      with `-`). For each flag, also skip the next token if the flag is
 *      in VALUE_FLAGS and lacks `=value`.
 *   4. If the next non-flag token is exactly `test`, look at all later
 *      tokens for `--filter` or `--filter=...` — if found, it is a
 *      violation.
 *   5. Any other non-flag landing token (`run`, `x`, `install`, etc.) ends
 *      the search for that `bun` occurrence.
 */
function isBunTestWithFilter(line: string): boolean {
  const tokens = normalizeLine(line).match(/\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "bun") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j] ?? "";
      if (tok.startsWith("-")) {
        if (tok.includes("=")) {
          j++;
          continue;
        }
        if (VALUE_FLAGS.has(tok)) {
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      if (tok === "test") {
        for (let k = j + 1; k < tokens.length; k++) {
          const later = tokens[k] ?? "";
          if (later === "--filter" || later.startsWith("--filter=")) {
            return true;
          }
        }
        break;
      }
      // Different subcommand (run, x, install, etc.) — abandon.
      break;
    }
  }
  return false;
}

export function detectViolations(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const logical = joinContinuations(content);
  for (const { text, originLine } of logical) {
    if (text.includes(IGNORE_MARKER)) continue;
    // Split on shell command separators so `foo; bun test --filter=x` is
    // checked as two commands (only the second is a violation).
    const commands = text.split(/[;|&]+/);
    for (const cmd of commands) {
      if (isBunTestWithFilter(cmd)) {
        violations.push({ file, line: originLine, text: text.trim() });
        break;
      }
    }
  }
  return violations;
}

interface FileEntry {
  readonly path: string;
  readonly content: string;
}

async function loadStagedFiles(): Promise<FileEntry[]> {
  const out = (await $`git diff --cached --name-only --diff-filter=ACMR`.text()).trim();
  if (out === "") return [];
  const paths = out.split("\n").filter(Boolean);
  const results: FileEntry[] = [];
  for (const path of paths) {
    try {
      const content = await $`git show :${path}`.text();
      results.push({ path, content });
    } catch {
      // file may be deleted or binary — skip
    }
  }
  return results;
}

async function loadWorkingTreeFiles(): Promise<FileEntry[]> {
  const tracked = (await $`git ls-files`.text()).trim().split("\n").filter(Boolean);
  const results: FileEntry[] = [];
  for (const path of tracked) {
    try {
      const content = await Bun.file(path).text();
      results.push({ path, content });
    } catch {
      // binary or missing — skip
    }
  }
  return results;
}

async function main(): Promise<void> {
  const staged = process.argv.includes("--staged");
  const files = staged ? await loadStagedFiles() : await loadWorkingTreeFiles();
  const mode = staged ? "staged" : "working-tree";

  const violations: Violation[] = [];
  for (const { path, content } of files) {
    if (ALLOWED_PATHS.has(path)) continue;
    if (path.startsWith("archive/")) continue;
    if (path.startsWith("node_modules/")) continue;
    violations.push(...detectViolations(path, content));
  }

  if (violations.length > 0) {
    console.error(`❌ ${violations.length} \`bun test --filter\` violation(s) [${mode}]:\n`);
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

  console.log(`✅ check:bun-test-filter passed [${mode}] — ${files.length} file(s) scanned.`);
}

if (import.meta.main) {
  await main();
}

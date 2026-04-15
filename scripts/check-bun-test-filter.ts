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

/**
 * Path-level allowlist for the few files that must reference the banned
 * pattern as a literal string (the guard's own source/tests, plus a
 * hypothetical CLI ergonomics example in the loop plan). There is NO
 * inline opt-out marker — exemption is centralized and auditable here.
 * Adding a new entry should be a deliberate PR decision, reviewed.
 */
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
 * Known Bun subcommands that, when seen between `bun` and a hypothetical
 * `test` token, mean we are NOT looking at `bun test` and should abandon
 * the search for that `bun` occurrence. This is a deny-list anchored on
 * the small, stable set of Bun subcommands rather than an open-ended
 * allowlist of value-taking flags (which Codex round 6 correctly noted
 * is incomplete and bypassable for any unlisted flag like `--env-file`).
 *
 * Source: `bun --help` top-level subcommands, Bun 1.3.x.
 */
const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run",
  "x",
  "exec",
  "install",
  "i",
  "add",
  "a",
  "remove",
  "rm",
  "update",
  "outdated",
  "link",
  "unlink",
  "init",
  "create",
  "pm",
  "repl",
  "upgrade",
  "build",
  "audit",
  "publish",
  "patch",
  "why",
  "info",
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
 * Algorithm (Codex round 6 redesign — subcommand-anchored):
 *   1. Normalize markdown/shell decoration characters out of the line.
 *   2. Tokenize on whitespace.
 *   3. For each `bun` token, walk forward token-by-token. Treat anything
 *      that is NOT a known Bun subcommand as opaque (could be a flag, a
 *      flag value, a path, anything) and keep walking. The walk
 *      terminates only on:
 *        - the literal token `test` → check later tokens for `--filter`
 *        - any token in KNOWN_SUBCOMMANDS → abandon (different command)
 *   4. This makes the walker robust against any pre-`test` Bun flag
 *      regardless of whether it takes a separate value token, fixing the
 *      VALUE_FLAGS-allowlist gap that round 6 surfaced (e.g.
 *      `bun --env-file .env test --filter=foo`).
 *
 * Trade-off: lines like `bun some-script.ts test --filter=x` would be
 * flagged as a false positive even though `some-script.ts` is the bun
 * entry point. In practice this shape is vanishingly rare in docs and
 * we'd rather over-warn than miss the real footgun.
 */
function isBunTestWithFilter(line: string): boolean {
  const tokens = normalizeLine(line).match(/\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "bun") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j] ?? "";
      if (tok === "test") {
        for (let k = j + 1; k < tokens.length; k++) {
          const later = tokens[k] ?? "";
          if (later === "--filter" || later.startsWith("--filter=")) {
            return true;
          }
        }
        break;
      }
      if (KNOWN_SUBCOMMANDS.has(tok)) {
        break;
      }
      j++;
    }
  }
  return false;
}

/**
 * Reconstruct the verifier argv from a koi `--until-pass` repeated-flag
 * sequence. `koi start --until-pass bun --until-pass test --until-pass
 * --filter=foo` reassembles to the argv `bun test --filter=foo`, which
 * is the same broken form we want to flag in plain shell commands.
 *
 * Supports both space-separated (`--until-pass <token>`) and `=` form
 * (`--until-pass=<token>`).
 */
function reconstructUntilPassArgv(line: string): string {
  const tokens = normalizeLine(line).match(/\S+/g) ?? [];
  const argv: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok === "--until-pass") {
      const next = tokens[i + 1];
      if (next !== undefined) {
        argv.push(next);
        i++;
      }
      continue;
    }
    if (tok.startsWith("--until-pass=")) {
      argv.push(tok.slice("--until-pass=".length));
    }
  }
  return argv.join(" ");
}

export function detectViolations(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const logical = joinContinuations(content);
  for (const { text, originLine } of logical) {
    // Split on shell command separators so `foo; bun test --filter=x` is
    // checked as two commands (only the second is a violation).
    const commands = text.split(/[;|&]+/);
    let flagged = false;
    for (const cmd of commands) {
      if (isBunTestWithFilter(cmd)) {
        violations.push({ file, line: originLine, text: text.trim() });
        flagged = true;
        break;
      }
    }
    if (flagged) continue;
    // Also reconstruct any koi --until-pass argv stream and check the
    // assembled verifier command. This catches `--until-pass bun
    // --until-pass test --until-pass --filter=foo` regressions.
    const reconstructed = reconstructUntilPassArgv(text);
    if (reconstructed !== "" && isBunTestWithFilter(reconstructed)) {
      violations.push({ file, line: originLine, text: text.trim() });
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

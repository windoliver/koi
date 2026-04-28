#!/usr/bin/env bun
/**
 * CI gate: enforces the TUI single-writer output policy (#1940).
 *
 * All user-visible output during active TUI must flow through store/actions
 * and the renderer's output path. Direct process.stdout.write and console.log
 * bypass the renderer's frame composer and can corrupt TUI rendering.
 *
 * Rules:
 * - FAIL: process.stdout.write in TUI source (stdout is the renderer's canvas)
 * - FAIL: console.log in TUI source (writes to stdout)
 * - WARN: process.stderr.write without a tui-single-writer-exception comment
 * - WARN: console.error / console.warn without a tui-single-writer-exception comment
 *
 * Exceptions:
 * - Lines containing `// tui-single-writer-exception:` are explicitly allowed.
 * - Test files (*.test.ts, *.test.tsx, __tests__/**) are excluded.
 * - Lines inside `if (process.env.NODE_ENV !== "production")` blocks are excluded.
 *
 * Usage: bun scripts/check-tui-single-writer.ts
 */

const ROOT = new URL("../", import.meta.url).pathname;
const TUI_SRC = "packages/ui/tui/src";

/** Patterns that are hard failures (stdout corruption). */
const HARD_PATTERNS = [
  { pattern: /process\.stdout\.write\s*\(/, label: "process.stdout.write" },
  { pattern: /\bconsole\.log\s*\(/, label: "console.log" },
] as const;

/** Patterns that are soft warnings (stderr — doesn't corrupt rendering but should go through store). */
const SOFT_PATTERNS = [
  { pattern: /process\.stderr\.write\s*\(/, label: "process.stderr.write" },
  { pattern: /\bconsole\.error\s*\(/, label: "console.error" },
  { pattern: /\bconsole\.warn\s*\(/, label: "console.warn" },
] as const;

const EXCEPTION_MARKER = "tui-single-writer-exception:";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly kind: "hard" | "soft";
  readonly label: string;
}

function isDevOnlyLine(lines: readonly string[], lineIdx: number): boolean {
  for (let i = lineIdx; i >= Math.max(0, lineIdx - 5); i--) {
    const l = lines[i] ?? "";
    if (/if\s*\(\s*process\.env\.NODE_ENV\s*!==\s*["']production["']/.test(l)) return true;
    if (/if\s*\(\s*["']production["']\s*!==\s*process\.env\.NODE_ENV/.test(l)) return true;
  }
  return false;
}

async function checkFile(filePath: string, relativePath: string): Promise<readonly Violation[]> {
  const content = await Bun.file(filePath).text();
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Exception marker may appear on the same line or within 6 preceding lines
    // (covers multi-line comment blocks plus an enclosing if-guard line).
    let hasException = false;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      if ((lines[j] ?? "").includes(EXCEPTION_MARKER)) {
        hasException = true;
        break;
      }
    }
    if (hasException) continue;
    if (isDevOnlyLine(lines, i)) continue;

    for (const { pattern, label } of HARD_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: relativePath,
          line: i + 1,
          content: line.trim(),
          kind: "hard",
          label,
        });
      }
    }
    for (const { pattern, label } of SOFT_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: relativePath,
          line: i + 1,
          content: line.trim(),
          kind: "soft",
          label,
        });
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const glob = new Bun.Glob(`${TUI_SRC}/**/*.{ts,tsx}`);
  const allViolations: Violation[] = [];
  let checked = 0;

  for await (const path of glob.scan({ cwd: ROOT, absolute: true })) {
    if (path.includes(".test.") || path.includes("__tests__")) continue;

    const relativePath = path.slice(ROOT.length);
    const violations = await checkFile(path, relativePath);
    for (const v of violations) allViolations.push(v);
    checked++;
  }

  const hard = allViolations.filter((v) => v.kind === "hard");
  const soft = allViolations.filter((v) => v.kind === "soft");

  if (soft.length > 0) {
    console.error(
      `⚠️  ${soft.length} soft violation(s) — stderr writes without exception marker:\n`,
    );
    for (const v of soft) {
      console.error(`  ${v.file}:${v.line}  [${v.label}]  ${v.content}`);
    }
    console.error(
      `\n  Prefer routing through store.dispatch() or add // ${EXCEPTION_MARKER} <reason> to document why not.\n`,
    );
  }

  if (hard.length > 0) {
    console.error(`❌ ${hard.length} hard violation(s) — stdout writes corrupt TUI rendering:\n`);
    for (const v of hard) {
      console.error(`  ${v.file}:${v.line}  [${v.label}]  ${v.content}`);
    }
    console.error(
      "\n  Fix: use renderer.copyToClipboardOSC52() for clipboard, or route output\n" +
        "  through store.dispatch() so the renderer controls when it appears.\n" +
        "  See: packages/ui/tui/src/utils/clipboard.ts for migration notes.\n",
    );
    process.exit(1);
  }

  if (soft.length === 0) {
    console.log(`✅ TUI single-writer policy: ${checked} file(s) checked, no violations.`);
  } else {
    console.log(
      `✅ TUI single-writer policy: no hard violations (${soft.length} soft warning(s)).`,
    );
  }
}

await main();

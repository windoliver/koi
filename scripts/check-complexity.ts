#!/usr/bin/env bun
/**
 * CI gate: enforces complexity ceilings on source files.
 *
 * Checks:
 * 1. No source file exceeds 400 lines (800 hard max)
 * 2. No function exceeds 50 lines
 *
 * Scans packages/subsystem/pkg/src/*.ts, excluding test files.
 *
 * Usage: bun scripts/check-complexity.ts
 */

const ROOT = new URL("../", import.meta.url).pathname;
const FILE_SOFT_LIMIT = 400;
const FILE_HARD_LIMIT = 800;
const FUNCTION_LIMIT = 50;

interface Violation {
  readonly file: string;
  readonly reason: string;
}

/**
 * Estimate function lengths by tracking braces after function/method declarations.
 * Returns violations for functions exceeding the limit.
 */
function checkFunctionLengths(filePath: string, content: string): readonly Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  // Match function declarations, arrow functions assigned to const/let, and method definitions
  const fnPattern =
    /^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(\w+)\s*\([^)]*\)\s*(?::\s*[^{]*)?\{)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = fnPattern.exec(line);
    if (match === null) continue;

    const fnName = match[2] ?? match[3] ?? match[4] ?? "anonymous";

    // Find the opening brace
    let braceStart = i;
    let foundBrace = false;
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (lines[j]?.includes("{")) {
        braceStart = j;
        foundBrace = true;
        break;
      }
    }
    if (!foundBrace) continue;

    // Count lines until matching closing brace
    let depth = 0;
    let bodyLines = 0;
    for (let j = braceStart; j < lines.length; j++) {
      const l = lines[j] ?? "";
      for (const ch of l) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      bodyLines++;
      if (depth === 0) break;
    }

    if (bodyLines > FUNCTION_LIMIT) {
      violations.push({
        file: filePath,
        reason: `function \`${fnName}\` is ${bodyLines} lines (limit: ${FUNCTION_LIMIT}) at line ${i + 1}`,
      });
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const srcGlob = new Bun.Glob("packages/*/*/src/**/*.ts");
  const violations: Violation[] = [];
  let checked = 0;

  for await (const path of srcGlob.scan({ cwd: ROOT, absolute: true })) {
    // Skip test files
    if (path.includes(".test.") || path.includes("__tests__")) continue;
    // Skip fixture/snapshot files
    if (path.includes("__snapshots__") || path.includes("fixtures")) continue;

    const content = await Bun.file(path).text();
    const lines = content.split("\n").length;
    const relativePath = path.slice(ROOT.length);
    checked++;

    // File length check
    if (lines > FILE_HARD_LIMIT) {
      violations.push({
        file: relativePath,
        reason: `${lines} lines exceeds hard limit of ${FILE_HARD_LIMIT}`,
      });
    } else if (lines > FILE_SOFT_LIMIT) {
      violations.push({
        file: relativePath,
        reason: `${lines} lines exceeds soft limit of ${FILE_SOFT_LIMIT}`,
      });
    }

    // Function length check
    const fnViolations = checkFunctionLengths(relativePath, content);
    for (const v of fnViolations) {
      violations.push(v);
    }
  }

  // Warn mode: report violations but do not fail CI (ratchet pattern).
  // Pass --strict to fail on violations once pre-existing issues are resolved.
  const strict = process.argv.includes("--strict");

  if (violations.length > 0) {
    const icon = strict ? "❌" : "⚠️";
    console.error(`${icon} ${violations.length} complexity violation(s):\n`);
    for (const v of violations) {
      console.error(`  ✗ ${v.file}: ${v.reason}`);
    }
    console.error(
      `\n  → Files must be < ${FILE_SOFT_LIMIT} lines (${FILE_HARD_LIMIT} hard max), functions < ${FUNCTION_LIMIT} lines.`,
    );
    if (strict) {
      process.exit(1);
    }
    return;
  }

  console.log(`✅ Complexity check passed — ${checked} source file(s) within limits.`);
}

await main();

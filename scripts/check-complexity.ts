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
 * Usage: bun scripts/check-complexity.ts [--strict] [--max-violations N]
 */

const DEFAULT_ROOT = new URL("../", import.meta.url).pathname;
const ROOT = ensureTrailingSlash(process.env.KOI_COMPLEXITY_ROOT ?? DEFAULT_ROOT);
const FILE_SOFT_LIMIT = 400;
const FILE_HARD_LIMIT = 800;
const FUNCTION_LIMIT = 50;

interface Options {
  readonly strict: boolean;
  readonly maxViolations: number | undefined;
}

interface Violation {
  readonly file: string;
  readonly reason: string;
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function parseOptions(argv: readonly string[]): Options {
  let strict = false;
  let maxViolations: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--max-violations") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        console.error("error: --max-violations requires a non-negative integer");
        process.exit(2);
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        console.error("error: --max-violations requires a non-negative integer");
        process.exit(2);
      }
      maxViolations = parsed;
      i++;
    }
  }

  return { strict, maxViolations };
}

/**
 * Estimate function lengths by tracking braces after function/method declarations.
 * Returns violations for functions exceeding the limit.
 */
function checkFunctionLengths(filePath: string, content: string): readonly Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  // Match function declarations, arrow functions assigned to const/let, and method definitions.
  // The method arm excludes control-flow keywords (if, while, for, switch, catch) to avoid
  // false positives on blocks that aren't function bodies.
  const CONTROL_FLOW = new Set([
    "if",
    "else",
    "while",
    "for",
    "switch",
    "catch",
    "return",
    "throw",
  ]);
  const fnPattern =
    /^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(\w+)\s*\([^)]*\)\s*(?::\s*[^{]*)?\{)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = fnPattern.exec(line);
    if (match === null) continue;

    const fnName = match[2] ?? match[3] ?? match[4] ?? "anonymous";

    // Skip control-flow keywords that the regex matched as method names
    if (CONTROL_FLOW.has(fnName)) continue;

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
  const options = parseOptions(process.argv.slice(2));
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

  if (violations.length > 0) {
    const overBudget =
      options.maxViolations !== undefined && violations.length > options.maxViolations;
    const shouldFail = options.strict || overBudget;
    const icon = shouldFail ? "❌" : "⚠️";
    console.error(`${icon} ${violations.length} complexity violation(s):\n`);
    for (const v of violations) {
      console.error(`  ✗ ${v.file}: ${v.reason}`);
    }
    console.error(
      `\n  → Files must be < ${FILE_SOFT_LIMIT} lines (${FILE_HARD_LIMIT} hard max), functions < ${FUNCTION_LIMIT} lines.`,
    );
    if (options.maxViolations !== undefined) {
      const relation = overBudget ? "exceeds" : "within";
      console.error(
        `  → ${violations.length} ${relation} ratchet budget of ${options.maxViolations}.`,
      );
    }
    if (shouldFail) {
      process.exit(1);
    }
    return;
  }

  console.log(`✅ Complexity check passed — ${checked} source file(s) within limits.`);
}

await main();

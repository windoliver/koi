#!/usr/bin/env bun
/**
 * `bun run doctor` — unified workspace health check.
 *
 * Default: runs fast checks only (~2s).
 * `bun run doctor --full`: runs all checks including typecheck, lint, and test.
 * `bun run doctor --json`: machine-readable JSON output.
 *
 * Exit codes: 0 = all pass/warn, 1 = any FAIL.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "FAIL";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly fix?: string;
  readonly durationMs: number;
}

export interface DoctorReport {
  readonly results: readonly CheckResult[];
  readonly passed: number;
  readonly warnings: number;
  readonly failures: number;
}

// ---------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------

interface CheckDef {
  readonly name: string;
  readonly command: readonly string[];
  readonly fast: boolean;
}

const CHECKS: readonly CheckDef[] = [
  { name: "Layer boundaries", command: ["bun", "run", "check:layers"], fast: true },
  { name: "Package descriptions", command: ["bun", "run", "check:descriptions"], fast: true },
  { name: "Doc sync", command: ["bun", "run", "check:doc-sync"], fast: true },
  { name: "TypeScript", command: ["bun", "run", "typecheck"], fast: false },
  { name: "Lint", command: ["bun", "run", "lint"], fast: false },
  { name: "Tests", command: ["bun", "run", "test"], fast: false },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runCheck(check: CheckDef): Promise<CheckResult> {
  const start = performance.now();
  try {
    const proc = Bun.spawn(check.command, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - start);
    const stderr = await new Response(proc.stderr).text();

    if (exitCode === 0) {
      return {
        name: check.name,
        status: "pass",
        message: `${check.name} passed`,
        durationMs,
      };
    }

    // Extract first meaningful line from stderr for the message
    const firstLine =
      stderr
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim() ?? "Check failed";

    return {
      name: check.name,
      status: "FAIL",
      message: firstLine.slice(0, 200),
      fix: `Run: ${check.command.join(" ")}`,
      durationMs,
    };
  } catch (e: unknown) {
    const durationMs = Math.round(performance.now() - start);
    return {
      name: check.name,
      status: "FAIL",
      message: e instanceof Error ? e.message : "Unknown error",
      fix: `Verify command exists: ${check.command.join(" ")}`,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<CheckStatus, string> = {
  pass: "[pass]",
  warn: "[warn]",
  FAIL: "[FAIL]",
};

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];

  for (const result of report.results) {
    const icon = STATUS_ICONS[result.status];
    const duration = `(${String(result.durationMs)}ms)`;
    lines.push(`${icon} ${result.message} ${duration}`);
    if (result.fix !== undefined) {
      lines.push(`       Fix: ${result.fix}`);
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${String(report.passed)} passed, ${String(report.warnings)} warning(s), ${String(report.failures)} failure(s)`,
  );

  return lines.join("\n");
}

export function buildReport(results: readonly CheckResult[]): DoctorReport {
  return {
    results,
    passed: results.filter((r) => r.status === "pass").length,
    warnings: results.filter((r) => r.status === "warn").length,
    failures: results.filter((r) => r.status === "FAIL").length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const json = args.includes("--json");

  const checks = full ? CHECKS : CHECKS.filter((c) => c.fast);

  if (!json) {
    const mode = full ? "full" : "fast (use --full for all checks)";
    console.log(`\nKoi Doctor — ${mode}\n`);
  }

  // Run all selected checks in parallel
  const results = await Promise.all(checks.map(runCheck));
  const report = buildReport(results);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  process.exit(report.failures > 0 ? 1 : 0);
}

if (import.meta.main) {
  await main();
}

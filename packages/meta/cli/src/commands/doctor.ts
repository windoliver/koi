/**
 * `koi doctor` — diagnose service health.
 *
 * Runs 3 inline checks in parallel (Decision 15-A: Promise.all). Supports
 * --json for structured output (Decision 7-A: JsonOutput<DiagnosticCheck[]>
 * envelope) and three-tier exit codes (Decision 6-A: OK/WARNING/FAILURE).
 *
 * TODO(Phase 2i-3): extend with @koi/deploy runDiagnostics() for richer
 * service-level checks (process health, port binding, Temporal connectivity).
 * Reference: archive/v1/packages/meta/cli/src/commands/doctor.ts
 */

import { access, constants } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CliFlags } from "../args.js";
import { isDoctorFlags } from "../args.js";
import type { CheckStatus, DiagnosticCheck, JsonOutput } from "../types.js";
import { ExitCode } from "../types.js";

// ---------------------------------------------------------------------------
// Check runner type
// ---------------------------------------------------------------------------

type CheckRunner = () => Promise<DiagnosticCheck>;

// ---------------------------------------------------------------------------
// Inline checks (Phase 2i-2: 3 essential checks, no external deps)
// ---------------------------------------------------------------------------

/** Check 1: Bun >= 1.3 is installed (we are already running in Bun). */
function makeBunVersionCheck(): CheckRunner {
  return async (): Promise<DiagnosticCheck> => {
    const version = Bun.version;
    const parts = version.split(".");
    const major = Number(parts[0] ?? "0");
    const minor = Number(parts[1] ?? "0");

    if (major < 1 || (major === 1 && minor < 3)) {
      return {
        id: "bun-version",
        name: "Bun version",
        status: "fail",
        message: `Bun >= 1.3 required, found ${version}`,
        fix: "See https://bun.sh for upgrade instructions",
      };
    }

    return {
      id: "bun-version",
      name: "Bun version",
      status: "pass",
      message: `Bun ${version}`,
    };
  };
}

/** Check 2: koi.yaml (or --manifest path) exists AND is readable by the current user. */
function makeManifestCheck(manifestPath: string): CheckRunner {
  return async (): Promise<DiagnosticCheck> => {
    try {
      // R_OK checks readability, not just existence — unreadable files (wrong
      // permissions) would pass F_OK but fail silently when commands try to parse them.
      await access(manifestPath, constants.R_OK);
      return {
        id: "koi-yaml",
        name: "Manifest file",
        status: "pass",
        message: `${manifestPath} found and readable`,
      };
    } catch {
      return {
        id: "koi-yaml",
        name: "Manifest file",
        status: "warn",
        message: `${manifestPath} not found or not readable — run koi init to scaffold one`,
        fix: "koi init",
      };
    }
  };
}

/** Check 3: bun.lock exists in the workspace root (missing suggests npm/yarn was used). */
function makeBunLockCheck(workspaceRoot: string): CheckRunner {
  const lockPath = join(workspaceRoot, "bun.lock");
  return async (): Promise<DiagnosticCheck> => {
    try {
      await access(lockPath);
      return {
        id: "bun-lock",
        name: "Lockfile",
        status: "pass",
        message: `${lockPath} found`,
      };
    } catch {
      return {
        id: "bun-lock",
        name: "Lockfile",
        status: "warn",
        message: `${lockPath} not found — ensure dependencies are installed with bun install`,
        fix: `cd ${workspaceRoot} && bun install`,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Core: run checks in parallel (exported for testing)
// ---------------------------------------------------------------------------

const SYMBOLS: Readonly<Record<CheckStatus, string>> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
} as const;

export async function runChecks(runners: readonly CheckRunner[]): Promise<{
  readonly checks: readonly DiagnosticCheck[];
  readonly exitCode: ExitCode;
}> {
  const checks = await Promise.all(runners.map((r) => r()));
  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const exitCode: ExitCode =
    failures > 0 ? ExitCode.FAILURE : warnings > 0 ? ExitCode.WARNING : ExitCode.OK;
  return { checks, exitCode };
}

// ---------------------------------------------------------------------------
// Output formatters (exported for testing)
// ---------------------------------------------------------------------------

export function formatTextOutput(checks: readonly DiagnosticCheck[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`  ${SYMBOLS[check.status]} ${check.name}: ${check.message}`);
    if (check.fix !== undefined) {
      lines.push(`    Fix: ${check.fix}`);
    }
  }

  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  lines.push("");
  lines.push(`${String(pass)} passed, ${String(warn)} warnings, ${String(fail)} failures`);

  return lines.join("\n");
}

export function formatJsonOutput(
  checks: readonly DiagnosticCheck[],
  exitCode: ExitCode,
): JsonOutput<readonly DiagnosticCheck[]> {
  const warnMessages = checks
    .filter((c) => c.status === "warn")
    .map((c) => c.message) as readonly string[];

  // exactOptionalPropertyTypes: omit `warnings` entirely when empty rather than
  // setting it to undefined — optional properties must be absent or have a value.
  return warnMessages.length > 0
    ? { ok: exitCode === ExitCode.OK, data: checks, warnings: warnMessages }
    : { ok: exitCode === ExitCode.OK, data: checks };
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isDoctorFlags(flags)) return ExitCode.FAILURE;

  const manifestPath = flags.manifest ?? "koi.yaml";
  // All filesystem checks use this root so --manifest /other/path inspects the
  // correct workspace, not the current working directory.
  const workspaceRoot = resolve(dirname(manifestPath));

  const runners: readonly CheckRunner[] = [
    makeBunVersionCheck(),
    makeManifestCheck(manifestPath),
    makeBunLockCheck(workspaceRoot),
  ];

  const { checks, exitCode } = await runChecks(runners);

  if (flags.json) {
    const output = formatJsonOutput(checks, exitCode);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return exitCode;
  }

  process.stdout.write(`Diagnosing koi workspace...\n\n`);
  process.stdout.write(`${formatTextOutput(checks)}\n`);

  return exitCode;
}

/**
 * `koi doctor` command — diagnose service health.
 *
 * Runs a series of checks and reports issues with fix suggestions.
 * Supports `--json` for structured output suitable for scripting.
 */

import { runDiagnostics, runRepair } from "@koi/deploy";
import { EXIT_CRITICAL, EXIT_OK, EXIT_WARN } from "@koi/shutdown";
import type { DoctorFlags } from "../args.js";
import { loadManifestOrExit } from "../load-manifest-or-exit.js";

// ---------------------------------------------------------------------------
// Status symbols
// ---------------------------------------------------------------------------

const SYMBOLS = {
  pass: "\u2713",
  warn: "!",
  fail: "\u2717",
} as const;

// ---------------------------------------------------------------------------
// JSON output types
// ---------------------------------------------------------------------------

interface DoctorCheckJson {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly message: string;
  readonly fix: string | undefined;
}

interface DoctorJsonOutput {
  readonly checks: readonly DoctorCheckJson[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
  };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runDoctor(flags: DoctorFlags): Promise<void> {
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const { manifest } = await loadManifestOrExit(manifestPath);
  const port = manifest.deploy?.port ?? 9100;
  const system = manifest.deploy?.system ?? false;

  if (!flags.json) {
    process.stdout.write(`Diagnosing "${manifest.name}"...\n\n`);
  }

  const report = await runDiagnostics({
    agentName: manifest.name,
    system,
    port,
    logDir: manifest.deploy?.logDir,
  });

  // JSON output mode
  if (flags.json) {
    const result: DoctorJsonOutput = {
      checks: report.checks.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        message: check.message,
        fix: check.fix,
      })),
      summary: {
        pass: report.passing,
        warn: report.warnings,
        fail: report.failures,
      },
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(report.failures > 0 ? EXIT_CRITICAL : report.warnings > 0 ? EXIT_WARN : EXIT_OK);
    return;
  }

  // Text output mode (default)

  // Print each check
  for (const check of report.checks) {
    const symbol = SYMBOLS[check.status];
    process.stdout.write(`  ${symbol} ${check.name}: ${check.message}\n`);

    if (check.fix !== undefined) {
      process.stdout.write(`    Fix: ${check.fix}\n`);
    }
  }

  // Summary
  process.stdout.write("\n");
  process.stdout.write(
    `${report.passing} passed, ${report.warnings} warnings, ${report.failures} failures\n`,
  );

  // Auto-repair if --repair flag is set and there are fixable issues
  if (flags.repair && (report.failures > 0 || report.warnings > 0)) {
    process.stdout.write("\nAttempting repair...\n");
    const repairResult = await runRepair(report, {
      agentName: manifest.name,
      system,
      port,
      logDir: manifest.deploy?.logDir,
      repair: true,
    });

    for (const msg of repairResult.repaired) {
      process.stdout.write(`  ${SYMBOLS.pass} ${msg}\n`);
    }
    for (const msg of repairResult.skipped) {
      process.stdout.write(`  ${SYMBOLS.warn} ${msg}\n`);
    }

    if (repairResult.repaired.length > 0) {
      process.stdout.write(`\nRepaired ${String(repairResult.repaired.length)} issue(s).\n`);
    } else {
      process.stdout.write("\nNo automatic repairs available.\n");
    }
  }

  // Text mode: exit non-zero only for failures (warnings are advisory).
  // --json mode uses 3-tier exit (0/1/2) for structured consumers.
  if (report.failures > 0) {
    process.exit(EXIT_CRITICAL);
  }
}

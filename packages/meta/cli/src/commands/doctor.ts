/**
 * `koi doctor` command — diagnose service health.
 *
 * Runs a series of checks and reports issues with fix suggestions.
 */

import { runDiagnostics, runRepair } from "@koi/deploy";
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown/exit-codes";
import type { DoctorFlags } from "../args.js";

// ---------------------------------------------------------------------------
// Status symbols
// ---------------------------------------------------------------------------

const SYMBOLS = {
  pass: "\u2713",
  warn: "!",
  fail: "\u2717",
} as const;

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runDoctor(flags: DoctorFlags): Promise<void> {
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";

  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest } = loadResult.value;
  const port = manifest.deploy?.port ?? 9100;
  const system = manifest.deploy?.system ?? false;

  process.stdout.write(`Diagnosing "${manifest.name}"...\n\n`);

  const report = await runDiagnostics({
    agentName: manifest.name,
    system,
    port,
    logDir: manifest.deploy?.logDir,
  });

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

  if (report.failures > 0) {
    process.exit(1);
  }
}

/**
 * Format stage (1.25) — auto-format implementation source code.
 *
 * Spawns a formatter subprocess on a temp file, reads back the result.
 * Only applies to implementation-bearing kinds (tool, middleware, channel).
 * Gracefully skips if formatter binary not found (warning, not error).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@koi/core";
import type { ForgeError, ForgeInput, FormatConfig, StageReport } from "@koi/forge-types";
import { formatError } from "@koi/forge-types";

// ---------------------------------------------------------------------------
// FormatStageReport
// ---------------------------------------------------------------------------

export interface FormatStageReport extends StageReport {
  readonly stage: "format";
  readonly formattedImplementation?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasImplementation(
  input: ForgeInput,
): input is Extract<ForgeInput, { readonly implementation: string }> {
  return (
    (input.kind === "tool" || input.kind === "middleware" || input.kind === "channel") &&
    typeof input.implementation === "string"
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifyFormat(
  input: ForgeInput,
  config: FormatConfig,
): Promise<Result<FormatStageReport, ForgeError>> {
  const start = performance.now();

  // Disabled → skip immediately
  if (!config.enabled) {
    return {
      ok: true,
      value: {
        stage: "format",
        passed: true,
        durationMs: performance.now() - start,
        message: "Format stage disabled — skipped",
      },
    };
  }

  // Non-implementation kinds (skill, agent) → skip
  if (!hasImplementation(input)) {
    return {
      ok: true,
      value: {
        stage: "format",
        passed: true,
        durationMs: performance.now() - start,
        message: `Kind "${input.kind}" has no implementation — skipped`,
      },
    };
  }

  // Check if formatter binary exists
  const binaryPath = Bun.which(config.command);
  if (binaryPath === null) {
    return {
      ok: true,
      value: {
        stage: "format",
        passed: true,
        durationMs: performance.now() - start,
        message: `Formatter "${config.command}" not found — skipped`,
      },
    };
  }

  // Write implementation to temp file
  const tmpPath = join(
    tmpdir(),
    `koi-format-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );
  try {
    await Bun.write(tmpPath, input.implementation);

    // Spawn formatter subprocess
    const proc = Bun.spawn([config.command, ...config.args, tmpPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait with timeout
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        resolve("timeout");
      }, config.timeoutMs);
    });

    const raceResult = await Promise.race([proc.exited, timeoutPromise]);

    if (raceResult === "timeout") {
      proc.kill();
      return {
        ok: false,
        error: formatError(
          "FORMAT_TIMEOUT",
          `Formatter "${config.command}" exceeded timeout (${config.timeoutMs}ms)`,
        ),
      };
    }

    const exitCode = raceResult;
    if (exitCode !== 0) {
      // Non-zero exit (e.g. parse errors) is non-fatal — formatting is best-effort
      return {
        ok: true,
        value: {
          stage: "format",
          passed: true,
          durationMs: performance.now() - start,
          message: `Formatter "${config.command}" exited with code ${String(exitCode)} — skipped`,
        },
      };
    }

    // Read back formatted content
    const formatted = await Bun.file(tmpPath).text();
    const durationMs = performance.now() - start;

    // If content changed, include formatted implementation in report
    if (formatted !== input.implementation) {
      return {
        ok: true,
        value: {
          stage: "format",
          passed: true,
          durationMs,
          formattedImplementation: formatted,
          message: "Implementation formatted",
        },
      };
    }

    return {
      ok: true,
      value: {
        stage: "format",
        passed: true,
        durationMs,
        message: "Implementation already formatted — no changes",
      },
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: formatError(
        "FORMAT_FAILED",
        `Formatter error: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  } finally {
    // Clean up temp file
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmpPath);
    } catch (_: unknown) {
      // Best-effort cleanup — ignore errors
    }
  }
}

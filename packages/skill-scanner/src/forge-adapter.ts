/**
 * ForgeVerifier adapter — thin wrapper around the scanner for forge Stage 3.
 *
 * Defines its own compatible interfaces (L2 can't import L2 peers).
 * TypeScript structural typing ensures compatibility with @koi/forge types.
 */

import { severityAtOrAbove } from "./config.js";
import { createScanner } from "./scanner.js";
import type { ScannerConfig, Severity } from "./types.js";

// ---------------------------------------------------------------------------
// Compatible interface types (structurally matches @koi/forge types)
// ---------------------------------------------------------------------------

export interface ForgeVerifierCompat {
  readonly name: string;
  readonly verify: (
    input: ForgeInputCompat,
    context: ForgeContextCompat,
  ) => Promise<VerifierResultCompat>;
}

export interface VerifierResultCompat {
  readonly passed: boolean;
  readonly message?: string;
}

export interface ForgeInputCompat {
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly implementation?: string;
  readonly content?: string;
}

export interface ForgeContextCompat {
  readonly agentId: string;
  readonly depth: number;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK_SEVERITY: Severity = "HIGH";
const DEFAULT_BLOCK_CONFIDENCE = 0.7;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScannerVerifier(config?: ScannerConfig): ForgeVerifierCompat {
  const scanner = createScanner(config);

  return {
    name: "skill-scanner",
    verify: async (
      input: ForgeInputCompat,
      _context: ForgeContextCompat,
    ): Promise<VerifierResultCompat> => {
      if (input.kind === "tool" && input.implementation !== undefined) {
        const report = scanner.scan(input.implementation, `${input.name}.ts`);
        const blocking = report.findings.filter(
          (f) =>
            severityAtOrAbove(f.severity, DEFAULT_BLOCK_SEVERITY) &&
            f.confidence >= DEFAULT_BLOCK_CONFIDENCE,
        );

        if (blocking.length > 0) {
          const messages = blocking.map(
            (f) => `[${f.severity}/${f.confidence.toFixed(2)}] ${f.rule}: ${f.message}`,
          );
          return {
            passed: false,
            message: `Scan found ${blocking.length} blocking issue(s):\n${messages.join("\n")}`,
          };
        }

        return {
          passed: true,
          message: `Scan passed (${report.findings.length} findings below threshold)`,
        };
      }

      if (input.kind === "skill" && input.content !== undefined) {
        const report = scanner.scanSkill(input.content);
        const blocking = report.findings.filter(
          (f) =>
            severityAtOrAbove(f.severity, DEFAULT_BLOCK_SEVERITY) &&
            f.confidence >= DEFAULT_BLOCK_CONFIDENCE,
        );

        if (blocking.length > 0) {
          const messages = blocking.map(
            (f) => `[${f.severity}/${f.confidence.toFixed(2)}] ${f.rule}: ${f.message}`,
          );
          return {
            passed: false,
            message: `Skill scan found ${blocking.length} blocking issue(s):\n${messages.join("\n")}`,
          };
        }

        return {
          passed: true,
          message: `Skill scan passed (${report.findings.length} findings below threshold)`,
        };
      }

      return { passed: true, message: "Skipped: not a tool or skill" };
    },
  };
}

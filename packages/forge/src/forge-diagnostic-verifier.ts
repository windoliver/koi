/**
 * Forge diagnostic verifier — plugs DiagnosticProvider into the Stage 3
 * verifier chain. Rejects on error-level diagnostics, warns on warning-level.
 */

import type { DiagnosticProvider } from "@koi/core";
import type { ForgeContext, ForgeInput, ForgeVerifier, VerifierResult } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DiagnosticVerifierConfig {
  /** Whether to reject bricks with warning-level diagnostics (default: false — warnings are advisory). */
  readonly rejectOnWarning?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/** Extract the implementation code from a forge input, if applicable. */
function extractImplementation(input: ForgeInput): string | undefined {
  if (input.kind === "tool" || input.kind === "middleware" || input.kind === "channel") {
    return input.implementation;
  }
  if (input.kind === "skill") {
    return input.body;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ForgeVerifier backed by a DiagnosticProvider.
 *
 * Plugs into the existing Stage 3 verifier chain. The verifier:
 * 1. Extracts implementation from the forge input
 * 2. Runs diagnostics via the provider
 * 3. Rejects on error-level diagnostics
 * 4. Optionally rejects on warning-level diagnostics
 */
export function createDiagnosticVerifier(
  provider: DiagnosticProvider,
  config?: DiagnosticVerifierConfig,
): ForgeVerifier {
  const rejectOnWarning = config?.rejectOnWarning ?? false;

  const verify = async (input: ForgeInput, _context: ForgeContext): Promise<VerifierResult> => {
    const implementation = extractImplementation(input);
    if (implementation === undefined) {
      // Agent kind has no implementation — nothing to diagnose
      return { passed: true };
    }

    // Use a synthetic URI for the diagnostic provider
    const uri = `koi://forge/${input.name}.ts`;

    const diagnostics = await provider.diagnose(uri, implementation);

    const errors = diagnostics.filter((d) => d.severity === "error");
    const warnings = diagnostics.filter((d) => d.severity === "warning");

    if (errors.length > 0) {
      const messages = errors
        .slice(0, 5) // Cap at 5 to avoid overwhelming output
        .map(
          (d) =>
            `[${d.range.start.line}:${d.range.start.character}] ${d.message}${d.source !== undefined ? ` (${d.source})` : ""}`,
        );
      return {
        passed: false,
        message: `Diagnostic errors found:\n${messages.join("\n")}`,
      };
    }

    if (rejectOnWarning && warnings.length > 0) {
      const messages = warnings
        .slice(0, 5)
        .map(
          (d) =>
            `[${d.range.start.line}:${d.range.start.character}] ${d.message}${d.source !== undefined ? ` (${d.source})` : ""}`,
        );
      return {
        passed: false,
        message: `Diagnostic warnings found (rejectOnWarning enabled):\n${messages.join("\n")}`,
      };
    }

    return { passed: true };
  };

  return { name: `diagnostic:${provider.name}`, verify };
}

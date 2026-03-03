/**
 * Stage 2: Sandbox execution — runs tool implementation in a sandboxed environment.
 * Only applies to "tool", "middleware", and "channel" kinds; skills/agents skip with a pass.
 */

import type { ExecutionContext, Result, SandboxError as SandboxErrorType } from "@koi/core";
import type {
  ForgeError,
  ForgeInput,
  SandboxExecutor,
  StageReport,
  VerificationConfig,
} from "@koi/forge-types";
import { sandboxError } from "@koi/forge-types";
import { enrichSandboxError } from "./sandbox-error-enrichment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an enriched sandbox error into a human-readable message.
 * Returns undefined if enrichment fails, allowing fallback to original message.
 */
function formatEnrichedMessage(
  error: SandboxErrorType,
  implementation: string,
  input: unknown,
): string | undefined {
  try {
    const enriched = enrichSandboxError(error, implementation, input);
    const parts: readonly string[] = [
      enriched.message,
      `[${enriched.code}] Remediation: ${enriched.remediation}`,
      ...(enriched.snippet !== undefined
        ? [
            `Code near line ${String(enriched.snippet.highlightLine ?? enriched.snippet.startLine)}:\n${enriched.snippet.lines.join("\n")}`,
          ]
        : []),
    ];
    return parts.join("\n");
  } catch (_: unknown) {
    // Enrichment is additive — if it fails, return undefined to fall through
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifySandbox(
  input: ForgeInput,
  executor: SandboxExecutor,
  config: VerificationConfig,
  executionContext?: ExecutionContext,
): Promise<Result<StageReport, ForgeError>> {
  // Skills, agents, and composites skip sandbox execution
  if (input.kind === "skill" || input.kind === "agent" || input.kind === "composite") {
    return {
      ok: true,
      value: {
        stage: "sandbox",
        passed: true,
        durationMs: 0,
        message: `Skipped for ${input.kind}`,
      },
    };
  }

  // Implementation-bearing kinds: tool, middleware, channel — run in sandbox
  const result = await executor.execute(
    input.implementation,
    {},
    config.sandboxTimeoutMs,
    executionContext,
  );

  if (!result.ok) {
    const enrichedMessage = formatEnrichedMessage(result.error, input.implementation, {});
    const message = enrichedMessage ?? result.error.message;
    return {
      ok: false,
      error: sandboxError(result.error.code, message, result.error.durationMs),
    };
  }

  return {
    ok: true,
    value: { stage: "sandbox", passed: true, durationMs: result.value.durationMs },
  };
}

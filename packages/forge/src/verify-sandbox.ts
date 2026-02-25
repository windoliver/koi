/**
 * Stage 2: Sandbox execution — runs tool implementation in a sandboxed environment.
 * Only applies to "tool" and "composite" kinds; skills/agents skip with a pass.
 */

import type { Result } from "@koi/core";
import type { VerificationConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { sandboxError } from "./errors.js";
import type { ForgeInput, SandboxExecutor, StageReport } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifySandbox(
  input: ForgeInput,
  executor: SandboxExecutor,
  config: VerificationConfig,
): Promise<Result<StageReport, ForgeError>> {
  // Skills and agents skip sandbox execution
  if (input.kind === "skill" || input.kind === "agent") {
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

  // For composite, we just verify it's constructable (no code to run)
  if (input.kind === "composite") {
    return {
      ok: true,
      value: { stage: "sandbox", passed: true, durationMs: 0, message: "Skipped for composite" },
    };
  }

  // Implementation-bearing kinds: tool, middleware, channel, engine, resolver, provider — run in sandbox
  const result = await executor.execute(input.implementation, {}, config.sandboxTimeoutMs);

  if (!result.ok) {
    return {
      ok: false,
      error: sandboxError(result.error.code, result.error.message, result.error.durationMs),
    };
  }

  return {
    ok: true,
    value: { stage: "sandbox", passed: true, durationMs: result.value.durationMs },
  };
}

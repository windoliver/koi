/**
 * Pipeline orchestrator — runs verification stages sequentially with early termination.
 *
 * Governance checks are handled by the createForgeTool factory (shared.ts),
 * NOT here. This function is purely the 5-stage verification pipeline.
 */

import type { ExecutionContext, Result } from "@koi/core";
import type { DependencyConfig, ForgeConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { sandboxError } from "./errors.js";
import type {
  ForgeContext,
  ForgeInput,
  ForgeVerifier,
  SandboxExecutor,
  StageReport,
  VerificationReport,
} from "./types.js";
import { verifyResolve } from "./verify-resolve.js";
import { verifySandbox } from "./verify-sandbox.js";
import { verifySelfTest } from "./verify-self-test.js";
import { verifyStatic } from "./verify-static.js";
import { assignTrust } from "./verify-trust.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkTimeout(pipelineStart: number, totalTimeoutMs: number): ForgeError | undefined {
  const elapsed = performance.now() - pipelineStart;
  if (elapsed > totalTimeoutMs) {
    return sandboxError(
      "TIMEOUT",
      `Verification pipeline exceeded total timeout (${totalTimeoutMs}ms, elapsed ${Math.round(elapsed)}ms)`,
      elapsed,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verify(
  input: ForgeInput,
  context: ForgeContext,
  executor: SandboxExecutor,
  verifiers: readonly ForgeVerifier[],
  config: ForgeConfig,
): Promise<Result<VerificationReport, ForgeError>> {
  const pipelineStart = performance.now();
  const totalTimeoutMs = config.verification.totalTimeoutMs;

  const stages: StageReport[] = [];

  // Stage 1: Static validation
  const staticResult = verifyStatic(input, config.verification);
  if (!staticResult.ok) {
    return { ok: false, error: staticResult.error };
  }
  stages.push(staticResult.value);

  const timeoutAfterStatic = checkTimeout(pipelineStart, totalTimeoutMs);
  if (timeoutAfterStatic !== undefined) {
    return { ok: false, error: timeoutAfterStatic };
  }

  // Stage 1.5: Resolve dependencies (audit + install)
  // Cap install timeout to remaining pipeline budget to prevent overshoot
  const remainingAfterStatic = totalTimeoutMs - (performance.now() - pipelineStart);
  const cappedDeps: DependencyConfig =
    remainingAfterStatic < config.dependencies.installTimeoutMs
      ? { ...config.dependencies, installTimeoutMs: Math.max(0, Math.round(remainingAfterStatic)) }
      : config.dependencies;
  const resolveResult = await verifyResolve(input, cappedDeps);
  if (!resolveResult.ok) {
    return { ok: false, error: resolveResult.error };
  }
  stages.push(resolveResult.value);

  const timeoutAfterResolve = checkTimeout(pipelineStart, totalTimeoutMs);
  if (timeoutAfterResolve !== undefined) {
    return { ok: false, error: timeoutAfterResolve };
  }

  // Build execution context — always include network/resource isolation,
  // and workspace paths when available from resolve stage.
  const resolveReport = resolveResult.value;
  const hasWorkspace = resolveReport.stage === "resolve" && "workspacePath" in resolveReport;
  const executionContext: ExecutionContext = {
    ...(hasWorkspace && resolveReport.workspacePath !== undefined
      ? { workspacePath: resolveReport.workspacePath }
      : {}),
    ...(hasWorkspace && "entryPath" in resolveReport && resolveReport.entryPath !== undefined
      ? { entryPath: resolveReport.entryPath }
      : {}),
    networkAllowed: input.requires?.network === true,
    resourceLimits: {
      maxMemoryMb: config.dependencies.maxBrickMemoryMb,
      maxPids: config.dependencies.maxBrickPids,
    },
  };

  // Stage 2: Sandbox execution
  const sandboxResult = await verifySandbox(input, executor, config.verification, executionContext);
  if (!sandboxResult.ok) {
    return { ok: false, error: sandboxResult.error };
  }
  stages.push(sandboxResult.value);

  const timeoutAfterSandbox = checkTimeout(pipelineStart, totalTimeoutMs);
  if (timeoutAfterSandbox !== undefined) {
    return { ok: false, error: timeoutAfterSandbox };
  }

  // Stage 3: Self-test + verifiers
  const selfTestResult = await verifySelfTest(
    input,
    executor,
    verifiers,
    context,
    config.verification,
  );
  if (!selfTestResult.ok) {
    return { ok: false, error: selfTestResult.error };
  }
  stages.push(selfTestResult.value);

  const timeoutAfterSelfTest = checkTimeout(pipelineStart, totalTimeoutMs);
  if (timeoutAfterSelfTest !== undefined) {
    return { ok: false, error: timeoutAfterSelfTest };
  }

  // Stage 4: Trust assignment
  const trustResult = assignTrust(input, config, stages);
  if (!trustResult.ok) {
    return { ok: false, error: trustResult.error };
  }
  stages.push(trustResult.value);

  const totalDurationMs = performance.now() - pipelineStart;

  return {
    ok: true,
    value: {
      stages,
      finalTrustTier: trustResult.value.trustTier,
      totalDurationMs,
      passed: true,
    },
  };
}

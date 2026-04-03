/**
 * Pipeline orchestrator — runs verification stages sequentially with early termination.
 *
 * Governance checks are handled by the createForgeTool factory (shared.ts),
 * NOT here. This function is purely the 6-stage verification pipeline.
 */

import type { ExecutionContext, Result } from "@koi/core";
import type {
  DependencyConfig,
  ForgeConfig,
  ForgeContext,
  ForgeError,
  ForgeInput,
  ForgeVerifier,
  SandboxExecutor,
  StageReport,
  VerificationReport,
} from "@koi/forge-types";
import { sandboxError } from "@koi/forge-types";
import { generateTestCases } from "./generate-test-cases.js";
import { verifyFormat } from "./verify-format.js";
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

  // Stage 1.25: Auto-format implementation code
  const formatResult = await verifyFormat(input, config.format);
  if (!formatResult.ok) {
    return { ok: false, error: formatResult.error };
  }
  stages.push(formatResult.value);

  // If format changed the implementation, create a new input for downstream stages
  // let justified: effectiveInput is conditionally reassigned based on format output
  let effectiveInput: ForgeInput = input;
  if (formatResult.value.formattedImplementation !== undefined && "implementation" in input) {
    effectiveInput = { ...input, implementation: formatResult.value.formattedImplementation };
  }

  const timeoutAfterFormat = checkTimeout(pipelineStart, totalTimeoutMs);
  if (timeoutAfterFormat !== undefined) {
    return { ok: false, error: timeoutAfterFormat };
  }

  // Stage 1.5: Resolve dependencies (audit + install)
  // Cap install timeout to remaining pipeline budget to prevent overshoot
  const remainingAfterStatic = totalTimeoutMs - (performance.now() - pipelineStart);
  const cappedDeps: DependencyConfig =
    remainingAfterStatic < config.dependencies.installTimeoutMs
      ? { ...config.dependencies, installTimeoutMs: Math.max(0, Math.round(remainingAfterStatic)) }
      : config.dependencies;
  const resolveResult = await verifyResolve(effectiveInput, cappedDeps);
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
    networkAllowed: effectiveInput.requires?.network === true,
    resourceLimits: {
      maxMemoryMb: config.dependencies.maxBrickMemoryMb,
      maxPids: config.dependencies.maxBrickPids,
    },
  };

  // Stage 2: Sandbox execution
  const sandboxResult = await verifySandbox(
    effectiveInput,
    executor,
    config.verification,
    executionContext,
  );
  if (!sandboxResult.ok) {
    return { ok: false, error: sandboxResult.error };
  }
  stages.push(sandboxResult.value);

  const timeoutAfterSandbox = checkTimeout(pipelineStart, totalTimeoutMs);
  if (timeoutAfterSandbox !== undefined) {
    return { ok: false, error: timeoutAfterSandbox };
  }

  // Stage 2.5: Auto-generate test cases from schema (if applicable)
  const agentProvidedCount =
    "testCases" in effectiveInput && effectiveInput.testCases !== undefined
      ? effectiveInput.testCases.length
      : 0;
  // let justified: autoGeneratedCount is set by generation or stays 0 on soft-failure
  let autoGeneratedCount = 0;

  if (effectiveInput.kind === "tool") {
    try {
      const autoGenerated = generateTestCases(effectiveInput.inputSchema, {
        maxTestCases: config.verification.maxAutoTestCases,
      });
      if (autoGenerated.length > 0) {
        autoGeneratedCount = autoGenerated.length;
        const merged = [...(effectiveInput.testCases ?? []), ...autoGenerated];
        effectiveInput = { ...effectiveInput, testCases: merged };
      }
    } catch (e: unknown) {
      // Soft failure: generator is enhancement, not gate.
      // Pipeline continues with agent-provided tests only.
      console.debug("[forge] auto test-case generation failed:", e);
    }
  }

  // Stage 3: Self-test + verifiers
  // Cap self-test timeout to remaining pipeline budget to prevent overshoot
  const remainingAfterSandbox = totalTimeoutMs - (performance.now() - pipelineStart);
  const cappedVerification =
    remainingAfterSandbox < config.verification.selfTestTimeoutMs
      ? {
          ...config.verification,
          selfTestTimeoutMs: Math.max(0, Math.round(remainingAfterSandbox)),
        }
      : config.verification;
  const selfTestResult = await verifySelfTest(
    effectiveInput,
    executor,
    verifiers,
    context,
    cappedVerification,
    { agentProvided: agentProvidedCount, autoGenerated: autoGeneratedCount },
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
  const trustResult = assignTrust(effectiveInput, config, stages);
  if (!trustResult.ok) {
    return { ok: false, error: trustResult.error };
  }
  stages.push(trustResult.value);

  const totalDurationMs = performance.now() - pipelineStart;

  return {
    ok: true,
    value: {
      stages,
      sandbox: trustResult.value.sandbox,
      totalDurationMs,
      passed: true,
    },
  };
}

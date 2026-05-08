import type { ForgeDemandSignal } from "@koi/core";
import { createPolicyCacheMiddleware } from "@koi/middleware-policy-cache";
import {
  type AutoHarnessConfig,
  type AutoHarnessError,
  type AutoHarnessEvent,
  type AutoHarnessStack,
  type AutoHarnessSynthesisResult,
  DEFAULT_MAX_SYNTHESES_PER_SESSION,
} from "./types.js";

function formatGeneratePrompt(signal: ForgeDemandSignal): string {
  const failed =
    signal.context.failedToolCalls.length > 0
      ? signal.context.failedToolCalls.join(", ")
      : "(none)";
  const task = signal.context.taskDescription ?? "(unspecified)";
  return [
    `Generate a koi middleware harness for brick kind ${signal.suggestedBrickKind}.`,
    `Trigger: ${signal.trigger.kind} (signal ${signal.id}, confidence ${signal.confidence.toFixed(2)}).`,
    `Failed tool calls: ${failed}.`,
    `Failure count this session: ${signal.context.failureCount}.`,
    `Task: ${task}.`,
    "Export `createMiddleware()` returning a KoiMiddleware that addresses the failure mode above.",
  ].join("\n");
}

function resolveMaxSynthesesPerSession(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SYNTHESES_PER_SESSION;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `@koi/auto-harness: maxSynthesesPerSession must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

async function runStageOrReport<T>(
  action: () => Promise<T>,
  error: AutoHarnessError,
  reportError: (error: AutoHarnessError) => void,
): Promise<T | null> {
  try {
    return await action();
  } catch (cause: unknown) {
    reportError({ ...error, cause });
    return null;
  }
}

export function createAutoHarnessStack(config: AutoHarnessConfig): AutoHarnessStack {
  const policyCacheHandle = createPolicyCacheMiddleware({
    notifier: config.notifier,
    ...(config.policyVerifier !== undefined && { verifier: config.policyVerifier }),
  });
  const { middleware: policyCacheMiddleware } = policyCacheHandle;
  const maxSynthesesPerSession = resolveMaxSynthesesPerSession(config.maxSynthesesPerSession);
  // Counts synthesis attempts (any path past the gate), not only successful
  // deployments. A persistent bad signal or unavailable dependency cannot
  // burn unbounded model calls within a single session — every entry past
  // the gate consumes one unit of the per-session budget.
  let synthesesThisSession = 0;

  const emitEvent = (event: AutoHarnessEvent): void => {
    config.onEvent?.(event);
  };

  const reportError = (error: AutoHarnessError): void => {
    config.onError?.(error);
  };

  // Re-entrancy guard: forge-demand can emit the same signal multiple times
  // under load (cooldown re-fire, concurrent traffic). Without serialization,
  // duplicate pipelines run for the same failure — wasting model calls,
  // duplicating approval prompts, and racing deploy side effects. The
  // in-flight set keys on `signal.id`; the runtime's wrapper invokes us
  // fire-and-forget per emission, so this is the canonical chokepoint.
  const inFlightSignalIds = new Set<string>();

  const synthesizeHarness = async (
    signal: ForgeDemandSignal,
  ): Promise<AutoHarnessSynthesisResult> => {
    if (inFlightSignalIds.has(signal.id)) {
      emitEvent({
        kind: "synthesis.skipped",
        signalId: signal.id,
        message: "synthesis already in flight for this signal",
      });
      return null;
    }
    if (synthesesThisSession >= maxSynthesesPerSession) {
      emitEvent({
        kind: "synthesis.skipped",
        signalId: signal.id,
        message: "session synthesis cap reached",
      });
      return null;
    }
    inFlightSignalIds.add(signal.id);
    synthesesThisSession += 1;
    emitEvent({ kind: "synthesis.started", signalId: signal.id });
    try {
      return await runPipeline(signal);
    } finally {
      inFlightSignalIds.delete(signal.id);
    }
  };

  const runPipeline = async (signal: ForgeDemandSignal): Promise<AutoHarnessSynthesisResult> => {
    let code: string;
    try {
      code = await config.generate(formatGeneratePrompt(signal));
    } catch (cause: unknown) {
      reportError({ stage: "generate", message: "generate failed", cause });
      return null;
    }

    const verification = await runStageOrReport(
      () => config.verifyCandidate(signal, code),
      { stage: "verify", message: "verifyCandidate failed" },
      reportError,
    );
    if (verification === null) {
      return null;
    }
    if (!verification.ok || verification.artifact === null) {
      emitEvent({
        kind: "verification.failed",
        signalId: signal.id,
        message: verification.reason ?? verification.error?.message ?? "verification failed",
      });
      return null;
    }

    const artifact = verification.artifact;

    // Persist the verified artifact before any policy / approval / deploy
    // decisions. From this point on the candidate is durable: operators can
    // inspect or retry it even after policy block, approval denial, deploy
    // error, or process restart. Save failures degrade audit but do not
    // block the pipeline — the in-memory candidate is still actionable.
    try {
      const saveResult = await config.forgeStore.save(artifact);
      if (!saveResult.ok) {
        reportError({
          stage: "verify",
          message: `forgeStore.save failed: ${saveResult.error.message}`,
          koiError: saveResult.error,
        });
      }
    } catch (cause: unknown) {
      reportError({
        stage: "verify",
        message: "forgeStore.save threw",
        cause,
      });
    }

    const policy = await runStageOrReport(
      () => config.evaluatePolicy(artifact, signal),
      { stage: "evaluate-policy", message: "evaluatePolicy failed" },
      reportError,
    );
    if (policy === null) {
      return null;
    }
    if (!policy.ok || policy.action !== "allow") {
      emitEvent({
        kind: "policy.blocked",
        signalId: signal.id,
        artifactId: artifact.id,
        message: policy.reason ?? policy.error?.message ?? "policy blocked deployment",
      });
      return null;
    }

    const approved = await runStageOrReport(
      () => config.requestDeploymentApproval(artifact, signal),
      {
        stage: "request-deployment-approval",
        message: "requestDeploymentApproval failed",
      },
      reportError,
    );
    if (approved === null) {
      return null;
    }
    if (!approved) {
      emitEvent({
        kind: "approval.denied",
        signalId: signal.id,
        artifactId: artifact.id,
        message: "deployment approval denied",
      });
      return null;
    }

    const deployment = await runStageOrReport(
      () => config.deployCandidate(artifact, signal),
      { stage: "deploy", message: "deployCandidate failed" },
      reportError,
    );
    if (deployment === null) {
      return null;
    }
    if (!deployment.ok) {
      reportError({
        stage: "deploy",
        message: deployment.error?.message ?? "deployment failed",
        cause: deployment.error?.cause,
        koiError: deployment.error?.koiError,
      });
      return null;
    }

    // Deployment side effects are now committed; emit success BEFORE
    // attempting the cache write. Policy-cache registration is a follow-on
    // optimization (short-circuit dispatch) — its failure must not be
    // reported as a deployment failure, otherwise callers would treat a
    // live artifact as missing and retry/duplicate the activation.
    emitEvent({
      kind: "deployment.succeeded",
      signalId: signal.id,
      artifactId: artifact.id,
    });

    if (deployment.policyEntry !== undefined) {
      try {
        const result = policyCacheHandle.register(deployment.policyEntry);
        if (!result.ok) {
          reportError({
            stage: "register-policy",
            message: result.error.message,
          });
        }
      } catch (cause: unknown) {
        reportError({
          stage: "register-policy",
          message: "policy-cache register threw",
          cause,
        });
      }
    }

    return artifact;
  };

  return {
    policyCacheMiddleware,
    policyCacheHandle,
    synthesizeHarness,
    resetSession: () => {
      synthesesThisSession = 0;
      emitEvent({ kind: "session.reset", message: "session synthesis state cleared" });
    },
    maxSynthesesPerSession,
  };
}

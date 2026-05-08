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

function resolveMaxSynthesesPerSession(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SYNTHESES_PER_SESSION;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `@koi/auto-harness: maxSynthesesPerSession must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

export function createAutoHarnessStack(config: AutoHarnessConfig): AutoHarnessStack {
  const policyCacheHandle = createPolicyCacheMiddleware({
    notifier: config.notifier,
  });
  const { middleware: policyCacheMiddleware } = policyCacheHandle;
  const maxSynthesesPerSession = resolveMaxSynthesesPerSession(config.maxSynthesesPerSession);
  let synthesesThisSession = 0;

  const emitEvent = (event: AutoHarnessEvent): void => {
    config.onEvent?.(event);
  };

  const reportError = (error: AutoHarnessError): void => {
    config.onError?.(error);
  };

  const synthesizeHarness = async (
    signal: ForgeDemandSignal,
  ): Promise<AutoHarnessSynthesisResult> => {
    if (synthesesThisSession >= maxSynthesesPerSession) {
      emitEvent({
        kind: "synthesis.skipped",
        signalId: signal.id,
        message: "session synthesis cap reached",
      });
      return null;
    }
    emitEvent({ kind: "synthesis.started", signalId: signal.id });

    let code: string;
    try {
      code = await config.generate("export function createMiddleware() {}");
    } catch (cause: unknown) {
      reportError({ stage: "generate", message: "generate failed", cause });
      return null;
    }

    const verification = await config.verifyCandidate(signal, code);
    if (!verification.ok || verification.artifact === null) {
      emitEvent({
        kind: "verification.failed",
        signalId: signal.id,
        message: verification.reason ?? verification.error?.message ?? "verification failed",
      });
      return null;
    }

    const artifact = verification.artifact;
    const policy = await config.evaluatePolicy(artifact, signal);
    if (!policy.ok || policy.action !== "allow") {
      emitEvent({
        kind: "policy.blocked",
        signalId: signal.id,
        artifactId: artifact.id,
        message: policy.reason ?? policy.error?.message ?? "policy blocked deployment",
      });
      return null;
    }

    const approved = await config.requestDeploymentApproval(artifact, signal);
    if (!approved) {
      emitEvent({
        kind: "approval.denied",
        signalId: signal.id,
        artifactId: artifact.id,
        message: "deployment approval denied",
      });
      return null;
    }

    const deployment = await config.deployCandidate(artifact, signal);
    if (!deployment.ok) {
      reportError({
        stage: "deploy",
        message: deployment.error?.message ?? "deployment failed",
        cause: deployment.error?.cause,
        koiError: deployment.error?.koiError,
      });
      return null;
    }

    synthesesThisSession += 1;
    emitEvent({
      kind: "deployment.succeeded",
      signalId: signal.id,
      artifactId: artifact.id,
    });
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

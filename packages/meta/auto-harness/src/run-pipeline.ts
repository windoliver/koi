import type { BrickArtifact, ForgeDemandSignal } from "@koi/core";
import { brickId } from "@koi/core/brick-snapshot";
import type { PolicyCacheHandle } from "@koi/middleware-policy-cache";
import type {
  AutoHarnessConfig,
  AutoHarnessDeployResult,
  AutoHarnessError,
  AutoHarnessEvent,
  AutoHarnessSessionContext,
} from "./types.js";

export type PipelineOutcome =
  | { readonly kind: "success"; readonly artifact: BrickArtifact }
  | { readonly kind: "non_retriable"; readonly artifact: null }
  | { readonly kind: "transient"; readonly artifact: null };

const transient = (): PipelineOutcome => ({ kind: "transient", artifact: null });
const nonRetriable = (): PipelineOutcome => ({ kind: "non_retriable", artifact: null });

interface Deps {
  readonly config: AutoHarnessConfig;
  readonly emitEvent: (event: AutoHarnessEvent) => void;
  readonly reportError: (error: AutoHarnessError) => void;
  readonly policyCacheHandle: PolicyCacheHandle;
  readonly formatGeneratePrompt: (signal: ForgeDemandSignal) => string;
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

async function runGenerate(
  deps: Deps,
  signal: ForgeDemandSignal,
): Promise<{ outcome?: PipelineOutcome; code?: string }> {
  try {
    const code = await deps.config.generate(deps.formatGeneratePrompt(signal));
    return { code };
  } catch (cause: unknown) {
    deps.reportError({ stage: "generate", message: "generate failed", cause });
    return { outcome: transient() };
  }
}

async function runVerify(
  deps: Deps,
  signal: ForgeDemandSignal,
  code: string,
): Promise<{ outcome?: PipelineOutcome; artifact?: BrickArtifact }> {
  const verification = await runStageOrReport(
    () => deps.config.verifyCandidate(signal, code),
    { stage: "verify", message: "verifyCandidate failed" },
    deps.reportError,
  );
  if (verification === null) return { outcome: transient() };
  if (!verification.ok || verification.artifact === null) {
    deps.emitEvent({
      kind: "verification.failed",
      signalId: signal.id,
      message: verification.reason ?? verification.error?.message ?? "verification failed",
    });
    return { outcome: nonRetriable() };
  }
  // Mint random draft id (R5 round 20 finding) — sidesteps TOCTOU.
  const draftId = brickId(`auto-harness-draft:${crypto.randomUUID()}`);
  return { artifact: { ...verification.artifact, id: draftId, lifecycle: "draft" as const } };
}

async function persistDraft(deps: Deps, artifact: BrickArtifact): Promise<PipelineOutcome | null> {
  try {
    const saveResult = await deps.config.forgeStore.save(artifact);
    if (!saveResult.ok) {
      deps.reportError({
        stage: "verify",
        message: `forgeStore.save failed: ${saveResult.error.message}`,
        koiError: saveResult.error,
      });
      return transient();
    }
    return null;
  } catch (cause: unknown) {
    deps.reportError({ stage: "verify", message: "forgeStore.save threw", cause });
    return transient();
  }
}

async function runPolicy(
  deps: Deps,
  signal: ForgeDemandSignal,
  artifact: BrickArtifact,
): Promise<PipelineOutcome | null> {
  const policy = await runStageOrReport(
    () => deps.config.evaluatePolicy(artifact, signal),
    { stage: "evaluate-policy", message: "evaluatePolicy failed" },
    deps.reportError,
  );
  if (policy === null) return transient();
  if (!policy.ok || policy.action !== "allow") {
    deps.emitEvent({
      kind: "policy.blocked",
      signalId: signal.id,
      artifactId: artifact.id,
      message: policy.reason ?? policy.error?.message ?? "policy blocked deployment",
    });
    return nonRetriable();
  }
  return null;
}

async function runApproval(
  deps: Deps,
  signal: ForgeDemandSignal,
  artifact: BrickArtifact,
): Promise<PipelineOutcome | null> {
  const approved = await runStageOrReport(
    () => deps.config.requestDeploymentApproval(artifact, signal),
    { stage: "request-deployment-approval", message: "requestDeploymentApproval failed" },
    deps.reportError,
  );
  if (approved === null) return transient();
  if (!approved) {
    deps.emitEvent({
      kind: "approval.denied",
      signalId: signal.id,
      artifactId: artifact.id,
      message: "deployment approval denied",
    });
    return nonRetriable();
  }
  return null;
}

async function runDeploy(
  deps: Deps,
  signal: ForgeDemandSignal,
  artifact: BrickArtifact,
): Promise<{ outcome?: PipelineOutcome; deployment?: AutoHarnessDeployResult }> {
  const deployment = await runStageOrReport(
    () => deps.config.deployCandidate(artifact, signal),
    { stage: "deploy", message: "deployCandidate failed" },
    deps.reportError,
  );
  if (deployment === null) return { outcome: transient() };
  if (!deployment.ok) {
    deps.reportError({
      stage: "deploy",
      message: deployment.error?.message ?? "deployment failed",
      cause: deployment.error?.cause,
      koiError: deployment.error?.koiError,
    });
    return { outcome: transient() };
  }
  // After deploy ok, bookkeeping failures return success+best-known artifact
  // (R5 round 19 finding) so callers don't redeploy against live state.
  if (deployment.artifact === undefined) {
    deps.reportError({
      stage: "deploy",
      message:
        "deployCandidate returned ok without an authoritative artifact; " +
        "live deploy may have committed but the post-deploy record cannot " +
        "be persisted. Returning the pre-deploy draft as best-known " +
        "artifact so callers do not retry. Manual reconciliation required.",
    });
    return { outcome: { kind: "success", artifact } };
  }
  return { deployment };
}

async function persistDeployed(
  deps: Deps,
  deployedArtifact: BrickArtifact,
): Promise<PipelineOutcome | null> {
  try {
    const saveResult = await deps.config.forgeStore.save(deployedArtifact);
    if (!saveResult.ok) {
      deps.reportError({
        stage: "deploy",
        message:
          `forgeStore.save (post-deploy) failed: ${saveResult.error.message}. ` +
          "Live deploy committed but durable record is stale; manual " +
          "reconciliation required. Returning the deployed artifact so " +
          "callers do not retry against an already-live state.",
        koiError: saveResult.error,
      });
      return { kind: "success", artifact: deployedArtifact };
    }
    return null;
  } catch (cause: unknown) {
    deps.reportError({
      stage: "deploy",
      message:
        "forgeStore.save (post-deploy) threw. Live deploy committed but " +
        "durable record is stale; manual reconciliation required. " +
        "Returning the deployed artifact so callers do not retry.",
      cause,
    });
    return { kind: "success", artifact: deployedArtifact };
  }
}

async function reconcileDraft(
  deps: Deps,
  draft: BrickArtifact,
  deployedArtifact: BrickArtifact,
): Promise<void> {
  if (deployedArtifact.id === draft.id) return;
  try {
    const removeResult = await deps.config.forgeStore.remove(draft.id);
    if (!removeResult.ok) {
      deps.reportError({
        stage: "deploy",
        message:
          `forgeStore.remove (draft reconciliation) failed: ${removeResult.error.message}. ` +
          `Both draft (${draft.id}) and deployed (${deployedArtifact.id}) ` +
          "records exist; manual cleanup required.",
        koiError: removeResult.error,
      });
    }
  } catch (cause: unknown) {
    deps.reportError({
      stage: "deploy",
      message:
        `forgeStore.remove (draft reconciliation) threw for ${draft.id}. ` +
        "Stale draft record may persist alongside deployed artifact; manual cleanup required.",
      cause,
    });
  }
}

function validatePolicyEntry(
  deps: Deps,
  session: AutoHarnessSessionContext | undefined,
  deployedArtifact: BrickArtifact,
  entry: NonNullable<AutoHarnessDeployResult["policyEntry"]>,
): boolean {
  if (entry.scope !== "agent") {
    deps.reportError({
      stage: "register-policy",
      message:
        `auto-harness refused to register policyEntry with scope=${entry.scope}. ` +
        "Only `agent`-scoped entries are permitted via the demand-driven " +
        "pipeline; `global` registrations would escalate enforcement " +
        "outside the authorizing session and must use an explicit, " +
        "separately authorized path.",
    });
    return false;
  }
  if (entry.agentId === undefined || entry.agentId === "") {
    deps.reportError({
      stage: "register-policy",
      message:
        "auto-harness refused to register policyEntry with no agentId; " +
        "agent-scoped entries must identify the owning agent so cache " +
        "lookups cannot match other agents' traffic.",
    });
    return false;
  }
  if (session?.ownerAgentId !== undefined && entry.agentId !== session.ownerAgentId) {
    deps.reportError({
      stage: "register-policy",
      message:
        `auto-harness refused to register policyEntry whose agentId (${entry.agentId}) ` +
        `does not match the owning agent (${session.ownerAgentId}). ` +
        "Cache entries must enforce only against the agent whose session " +
        "produced the demand signal; cross-agent registration would let " +
        "one agent's deployment change enforcement for an unrelated agent.",
    });
    return false;
  }
  if (entry.brickId !== deployedArtifact.id) {
    deps.reportError({
      stage: "register-policy",
      message:
        `auto-harness refused to register policyEntry whose brickId (${entry.brickId}) ` +
        `does not match the deployed artifact id (${deployedArtifact.id}). ` +
        "Cache entries must be bound to the specific artifact that was " +
        "approved and deployed; cross-artifact registration would let one " +
        "deployment promote enforcement for an unrelated brick.",
    });
    return false;
  }
  return true;
}

function registerPolicy(
  deps: Deps,
  session: AutoHarnessSessionContext | undefined,
  deployedArtifact: BrickArtifact,
  deployment: AutoHarnessDeployResult,
): void {
  const entry = deployment.policyEntry;
  if (entry === undefined) return;
  if (!validatePolicyEntry(deps, session, deployedArtifact, entry)) return;
  if (deps.config.policyVerifier === undefined) return;
  try {
    const result = deps.policyCacheHandle.register(entry);
    if (!result.ok) {
      deps.reportError({ stage: "register-policy", message: result.error.message });
    }
  } catch (cause: unknown) {
    deps.reportError({
      stage: "register-policy",
      message: "policy-cache register threw",
      cause,
    });
  }
}

export async function runPipeline(
  deps: Deps,
  signal: ForgeDemandSignal,
  session: AutoHarnessSessionContext | undefined,
): Promise<PipelineOutcome> {
  const gen = await runGenerate(deps, signal);
  if (gen.outcome) return gen.outcome;
  const ver = await runVerify(deps, signal, gen.code as string);
  if (ver.outcome) return ver.outcome;
  const artifact = ver.artifact as BrickArtifact;
  const draftFail = await persistDraft(deps, artifact);
  if (draftFail) return draftFail;
  const policyFail = await runPolicy(deps, signal, artifact);
  if (policyFail) return policyFail;
  const approvalFail = await runApproval(deps, signal, artifact);
  if (approvalFail) return approvalFail;
  const dep = await runDeploy(deps, signal, artifact);
  if (dep.outcome) return dep.outcome;
  const deployment = dep.deployment as AutoHarnessDeployResult;
  const deployedArtifact = deployment.artifact as BrickArtifact;
  const postSaveFail = await persistDeployed(deps, deployedArtifact);
  if (postSaveFail) return postSaveFail;
  await reconcileDraft(deps, artifact, deployedArtifact);
  deps.emitEvent({
    kind: "deployment.succeeded",
    signalId: signal.id,
    artifactId: deployedArtifact.id,
  });
  registerPolicy(deps, session, deployedArtifact, deployment);
  return { kind: "success", artifact: deployedArtifact };
}

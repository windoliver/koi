import type { BrickArtifact, ForgeDemandSignal } from "@koi/core";
import { createPolicyCacheMiddleware } from "@koi/middleware-policy-cache";
import {
  type AutoHarnessConfig,
  type AutoHarnessError,
  type AutoHarnessEvent,
  type AutoHarnessSessionContext,
  type AutoHarnessStack,
  type AutoHarnessSynthesisResult,
  DEFAULT_MAX_SYNTHESES_PER_SESSION,
} from "./types.js";

/**
 * Sentinel used to bucket calls that arrive without a session context.
 * Multi-session runtimes wire `synthesizeHarness(signal, { sessionId, ... })`
 * via the runtime's onSessionAttached path; out-of-band callers and stub
 * adapters fall back to this single shared bucket.
 */
const GLOBAL_SESSION_BUCKET = "__global__";

function formatGeneratePrompt(signal: ForgeDemandSignal): string {
  const failed =
    signal.context.failedToolCalls.length > 0
      ? sanitizeFailureEvidence(signal.context.failedToolCalls.join(", "))
      : "(none)";
  const task =
    signal.context.taskDescription !== undefined
      ? sanitizeFailureEvidence(signal.context.taskDescription)
      : "(unspecified)";
  return [
    `Generate a koi middleware harness for brick kind ${signal.suggestedBrickKind}.`,
    `Trigger: ${signal.trigger.kind} (signal ${signal.id}, confidence ${signal.confidence.toFixed(2)}).`,
    `Failed tool calls: ${failed}.`,
    `Failure count this session: ${signal.context.failureCount}.`,
    `Task: ${task}.`,
    "Export `createMiddleware()` returning a KoiMiddleware that addresses the failure mode above.",
  ].join("\n");
}

/**
 * Stable identity derived from the demand signal trigger contents — keeps
 * cooldown re-fires and concurrent emissions for the same root cause from
 * spawning duplicate pipelines. The detector mints a fresh `signal.id` per
 * emission, so id-based dedup is insufficient.
 */
/**
 * Stable, low-cardinality fingerprint of failure evidence — narrow enough
 * to distinguish materially different failure modes (timeout vs malformed
 * input vs auth) but coarse enough to coalesce true duplicates of the same
 * symptom. Sanitized first so secrets never enter the dedupe key.
 */
function failureFingerprint(failedToolCalls: readonly string[]): string {
  if (failedToolCalls.length === 0) return "none";
  const sample = sanitizeFailureEvidence(failedToolCalls.slice(0, 3).join("|"));
  // FNV-1a 32-bit hash — small, fast, no crypto dep, sufficient for
  // partitioning concurrent in-flight pipelines.
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16);
}

function triggerIdentity(signal: ForgeDemandSignal): string {
  const t = signal.trigger;
  // Defensive: callers occasionally pass partial signals (tests, mocks).
  // Without a usable trigger, bucket by signal id so dedupe still applies.
  if (t === undefined || t === null || typeof t.kind !== "string") {
    return `unknown:${signal.id}`;
  }
  switch (t.kind) {
    case "repeated_failure":
      // Distinct failure modes for the same tool (timeout vs malformed
      // input) must not collapse into one dedupe bucket — the synthesis
      // prompt depends on different failure evidence and dropping the
      // later signal would lose that failure mode entirely.
      return `repeated_failure:${t.toolName}:${failureFingerprint(signal.context?.failedToolCalls ?? [])}`;
    case "no_matching_tool":
      return `no_matching_tool:${t.query}`;
    case "capability_gap":
      return `capability_gap:${t.requiredCapability}`;
    case "performance_degradation":
      return `performance_degradation:${t.toolName}:${t.metric}`;
    case "agent_capability_gap":
      return `agent_capability_gap:${t.agentType}`;
    case "agent_repeated_failure":
      return `agent_repeated_failure:${t.agentType}`;
    default: {
      // Exhaustive fallback for any future trigger kinds added to the L0 union.
      const exhaustive: Record<string, string> = t as never;
      return `unknown:${JSON.stringify(exhaustive)}`;
    }
  }
}

/**
 * Strip secrets-shaped tokens out of failure evidence before forwarding to
 * the model. Forge-demand records raw `extractMessage(e)` output from
 * failing tools, which can contain credentials, tenant identifiers, or
 * internal paths. We redact common secret shapes; callers that need richer
 * sanitization should pre-process their failure logs.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer <token>` — including the token after the prefix.
  /\b(?:authorization|x-api-key)\b\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._\-+/=]+/gi,
  // `key=value`, `token: value`, etc — strip the value up to whitespace/quote/brace.
  /\b(?:password|passwd|secret|token|apikey|api[_-]?key|bearer|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
  // High-entropy alphanumeric run 28+ chars (likely opaque tokens / secrets).
  /\b[A-Za-z0-9]{28,}\b/g,
  // Base64-ish runs with separators.
  /\b[A-Za-z0-9_+/-]{40,}={0,2}\b/g,
  // POSIX user home paths — leak username and often tenant-shaped subdirs.
  /\/(?:Users|home)\/[^/\s"',)}]+/g,
  // Internal-style hostnames: foo.local, foo.internal, *.svc, *.cluster.local.
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:local|internal|svc|cluster\.local)\b/gi,
  // IPv4 addresses (private + public — defense in depth, model doesn't need them).
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  // tenant=..., tenant_id=..., orgId=..., x-tenant-id: ... — common multi-tenant identifiers.
  /\b(?:tenant(?:[_-]?id)?|org(?:[_-]?id)?|account(?:[_-]?id)?|customer(?:[_-]?id)?|x-tenant(?:-id)?)\b\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
];

function sanitizeFailureEvidence(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
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
  // Fail closed when policy-cache registration is enabled but no
  // invalidation source is wired. With a `policyVerifier` configured,
  // successful deployments register `policyEntry` objects into the cache;
  // without a `StoreChangeNotifier`, those entries are immortal — brick
  // updates, removals, and quarantines have no path into the cache, so
  // stale allow/deny decisions short-circuit live traffic until the
  // process restarts (R5 round 6 finding).
  if (config.policyVerifier !== undefined && config.notifier === undefined) {
    throw new Error(
      "@koi/auto-harness: `notifier` (StoreChangeNotifier) is required when " +
        "`policyVerifier` is configured. Deployed policy-cache entries can " +
        "outlive their backing brick if the cache has no invalidation source, " +
        "leaving stale allow/deny decisions in place after the brick is " +
        "updated, removed, or quarantined. Supply a notifier wired to the " +
        "forge store's lifecycle events.",
    );
  }
  const policyCacheHandle = createPolicyCacheMiddleware({
    notifier: config.notifier,
    ...(config.policyVerifier !== undefined && { verifier: config.policyVerifier }),
  });
  const { middleware: policyCacheMiddleware } = policyCacheHandle;
  const maxSynthesesPerSession = resolveMaxSynthesesPerSession(config.maxSynthesesPerSession);

  // Per-session synthesis budgets and in-flight dedupe. Keying on sessionId
  // prevents one tenant's repeated failures from exhausting another tenant's
  // budget or holding the in-flight slot for an identical trigger. Calls
  // without a session context share the GLOBAL_SESSION_BUCKET — out-of-band
  // and single-session usage retains its original semantics.
  interface SessionState {
    count: number;
    inFlightTriggers: Set<string>;
    // Persistent post-completion gate. After a pipeline finishes (success
    // OR terminal failure) we keep the trigger identity here so the same
    // root-cause signal cannot replay sequentially through verify→policy→
    // approval→deploy and produce duplicate draft records, repeated
    // approval prompts, and non-idempotent deploy side effects (R5 round 6
    // finding). Cleared on `resetSession(id)` — hosts are expected to
    // reset on legitimate session boundaries (cycleSession, host config
    // change). When a host wants to retry a previously-handled trigger
    // (e.g. the failure mode actually changed), it must reset the
    // session.
    completedTriggers: Set<string>;
  }
  const sessionState = new Map<string, SessionState>();
  const getOrCreateSession = (id: string): SessionState => {
    let s = sessionState.get(id);
    if (s === undefined) {
      s = { count: 0, inFlightTriggers: new Set(), completedTriggers: new Set() };
      sessionState.set(id, s);
    }
    return s;
  };

  const emitEvent = (event: AutoHarnessEvent): void => {
    config.onEvent?.(event);
  };

  const reportError = (error: AutoHarnessError): void => {
    config.onError?.(error);
  };

  const synthesizeHarness = async (
    signal: ForgeDemandSignal,
    session?: AutoHarnessSessionContext,
  ): Promise<AutoHarnessSynthesisResult> => {
    const sessionKey = session?.sessionId ?? GLOBAL_SESSION_BUCKET;
    const state = getOrCreateSession(sessionKey);
    const triggerKey = triggerIdentity(signal);

    const safeDismiss = (): void => {
      if (session?.dismiss === undefined) return;
      try {
        session.dismiss();
      } catch (cause: unknown) {
        // Dismiss failures must not interrupt the pipeline; surface via onError.
        reportError({ stage: "verify", message: "dismiss callback threw", cause });
      }
    };

    if (state.inFlightTriggers.has(triggerKey)) {
      emitEvent({
        kind: "synthesis.skipped",
        signalId: signal.id,
        message: `synthesis already in flight for trigger ${triggerKey}`,
      });
      // Duplicate signals coalesce onto the active pipeline. Dismiss the
      // duplicate so forge-demand doesn't keep it pending and re-emit after
      // cooldown for a condition another in-flight pipeline is already
      // handling.
      safeDismiss();
      return null;
    }
    if (state.completedTriggers.has(triggerKey)) {
      // Sequential replay of the same root-cause trigger after a prior
      // pipeline already ran to terminal outcome. Suppress and dismiss so
      // forge-demand cooldown re-fires don't spawn duplicate
      // verify/policy/approval/deploy cycles for one failure mode. Hosts
      // that want to re-handle this trigger must call resetSession(id).
      emitEvent({
        kind: "synthesis.skipped",
        signalId: signal.id,
        message: `trigger ${triggerKey} already processed this session`,
      });
      safeDismiss();
      return null;
    }
    if (state.count >= maxSynthesesPerSession) {
      emitEvent({
        kind: "synthesis.skipped",
        signalId: signal.id,
        message: "session synthesis cap reached",
      });
      // The signal will not be processed; dismiss it so forge-demand state
      // doesn't accumulate unprocessable signals across cooldowns.
      safeDismiss();
      return null;
    }
    state.inFlightTriggers.add(triggerKey);
    state.count += 1;
    emitEvent({ kind: "synthesis.started", signalId: signal.id });
    try {
      const outcome = await runPipeline(signal);
      // Acknowledge the signal regardless of terminal outcome (success,
      // verification fail, policy block, approval denial, deploy error).
      // Without dismissal, forge-demand keeps re-emitting the same condition
      // after cooldown and burns the session emit budget.
      safeDismiss();
      // Only mark the trigger as completed for outcomes that won't change
      // on retry: success, hard verification rejection, policy block, or
      // explicit approval denial. Transient failures (generator outage,
      // verifier crash, store error, deploy infrastructure failure) leave
      // the trigger eligible so a subsequent signal for the same root cause
      // can re-attempt the pipeline once the dependency recovers (R5
      // round 8 finding).
      if (outcome.kind !== "transient") {
        state.completedTriggers.add(triggerKey);
      }
      return outcome.artifact;
    } finally {
      state.inFlightTriggers.delete(triggerKey);
    }
  };

  type PipelineOutcome =
    | { readonly kind: "success"; readonly artifact: BrickArtifact }
    | { readonly kind: "non_retriable"; readonly artifact: null }
    | { readonly kind: "transient"; readonly artifact: null };
  const transient = (): PipelineOutcome => ({ kind: "transient", artifact: null });
  const nonRetriable = (): PipelineOutcome => ({ kind: "non_retriable", artifact: null });

  const runPipeline = async (signal: ForgeDemandSignal): Promise<PipelineOutcome> => {
    let code: string;
    try {
      code = await config.generate(formatGeneratePrompt(signal));
    } catch (cause: unknown) {
      // Generator outages are transient — leave the trigger retriable.
      reportError({ stage: "generate", message: "generate failed", cause });
      return transient();
    }

    const verification = await runStageOrReport(
      () => config.verifyCandidate(signal, code),
      { stage: "verify", message: "verifyCandidate failed" },
      reportError,
    );
    if (verification === null) {
      // Verifier crash is transient infrastructure failure.
      return transient();
    }
    if (!verification.ok || verification.artifact === null) {
      // Hard verification rejection — same trigger will produce the same
      // unsuitable code without resetSession, so suppress further attempts.
      emitEvent({
        kind: "verification.failed",
        signalId: signal.id,
        message: verification.reason ?? verification.error?.message ?? "verification failed",
      });
      return nonRetriable();
    }

    // Force lifecycle to "draft" before persistence. Verification produced a
    // candidate but it has not yet cleared policy or approval — storing it
    // as "active" would expose pre-approval bricks to any consumer reading
    // the forge store (resolvers, dashboards, redeployment paths). The
    // deploy stage is responsible for promoting the lifecycle once the
    // artifact is actually live.
    const artifact = { ...verification.artifact, lifecycle: "draft" as const };

    // Persist the verified artifact before any policy / approval / deploy
    // decisions. Persistence is a HARD GATE: if the artifact cannot be
    // durably stored we must not proceed to deploy. A live deployed harness
    // with no stored record cannot be inspected, redeployed, or cleanly
    // recovered after a process restart — exactly the failure mode the
    // forgeStore contract exists to prevent.
    try {
      const saveResult = await config.forgeStore.save(artifact);
      if (!saveResult.ok) {
        // Store outage is transient — retry the same trigger when the
        // backend recovers rather than black-holing it for the session.
        reportError({
          stage: "verify",
          message: `forgeStore.save failed: ${saveResult.error.message}`,
          koiError: saveResult.error,
        });
        return transient();
      }
    } catch (cause: unknown) {
      reportError({
        stage: "verify",
        message: "forgeStore.save threw",
        cause,
      });
      return transient();
    }

    const policy = await runStageOrReport(
      () => config.evaluatePolicy(artifact, signal),
      { stage: "evaluate-policy", message: "evaluatePolicy failed" },
      reportError,
    );
    if (policy === null) {
      // Policy evaluator crash is infrastructure failure.
      return transient();
    }
    if (!policy.ok || policy.action !== "allow") {
      // Policy decision — same input will produce the same verdict; mark
      // non-retriable so the trigger stops re-emitting until reset.
      emitEvent({
        kind: "policy.blocked",
        signalId: signal.id,
        artifactId: artifact.id,
        message: policy.reason ?? policy.error?.message ?? "policy blocked deployment",
      });
      return nonRetriable();
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
      return transient();
    }
    if (!approved) {
      // User explicitly denied — re-asking on the next signal would create
      // approval-prompt fatigue. Reset to re-prompt.
      emitEvent({
        kind: "approval.denied",
        signalId: signal.id,
        artifactId: artifact.id,
        message: "deployment approval denied",
      });
      return nonRetriable();
    }

    const deployment = await runStageOrReport(
      () => config.deployCandidate(artifact, signal),
      { stage: "deploy", message: "deployCandidate failed" },
      reportError,
    );
    if (deployment === null) {
      return transient();
    }
    if (!deployment.ok) {
      // Deploy infrastructure failure (engine reload, network, container
      // start) — leave retriable. Codified policy denials are reported via
      // the policy stage above, not here.
      reportError({
        stage: "deploy",
        message: deployment.error?.message ?? "deployment failed",
        cause: deployment.error?.cause,
        koiError: deployment.error?.koiError,
      });
      return transient();
    }

    // The authoritative deployed artifact is mandatory: deployCandidate may
    // promote lifecycle, assign a deployed id, or attach metadata that only
    // exists once the harness is live. Without it we cannot prove a
    // post-deploy state distinct from the pre-deploy draft, and consumers
    // that trust synthesizeHarness / the forge store would believe the
    // harness is still pending. Treat its absence as deploy-infrastructure
    // failure (transient) so the host can fix the deploy contract and
    // retry. (R5 round 8 finding.)
    if (deployment.artifact === undefined) {
      reportError({
        stage: "deploy",
        message:
          "deployCandidate returned ok without an authoritative artifact; " +
          "post-deploy state cannot be persisted",
      });
      return transient();
    }
    const deployedArtifact = deployment.artifact;

    // Persist the deployed artifact BEFORE emitting deployment.succeeded.
    // The durable store must reflect the live activation: restart/recovery
    // and rollback paths trust the store as the source of truth for what is
    // actually live. A best-effort save would let observers see a draft
    // forever after the harness is already serving traffic.
    try {
      const saveResult = await config.forgeStore.save(deployedArtifact);
      if (!saveResult.ok) {
        reportError({
          stage: "deploy",
          message: `forgeStore.save (post-deploy) failed: ${saveResult.error.message}`,
          koiError: saveResult.error,
        });
        return transient();
      }
    } catch (cause: unknown) {
      reportError({
        stage: "deploy",
        message: "forgeStore.save (post-deploy) threw",
        cause,
      });
      return transient();
    }

    // Deployment side effects are now committed AND durably recorded; emit
    // success BEFORE the cache write. Policy-cache registration is a
    // follow-on optimization — its failure must not be reported as a
    // deployment failure, otherwise callers would treat a live artifact as
    // missing and retry/duplicate the activation.
    emitEvent({
      kind: "deployment.succeeded",
      signalId: signal.id,
      artifactId: deployedArtifact.id,
    });

    // Skip cache registration when no verifier is configured. Without a
    // verifier the policy-cache fails closed on every register and would
    // emit spurious "register-policy" errors for a deployment that
    // succeeded. The middleware still short-circuits via its own miss path;
    // not populating the cache simply means no fast-path optimization until
    // the host wires a verifier.
    if (deployment.policyEntry !== undefined && config.policyVerifier !== undefined) {
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

    return { kind: "success", artifact: deployedArtifact };
  };

  return {
    policyCacheMiddleware,
    policyCacheHandle,
    synthesizeHarness,
    resetSession: (sessionId?: string) => {
      if (sessionId === undefined) {
        sessionState.clear();
      } else {
        sessionState.delete(sessionId);
      }
      emitEvent({ kind: "session.reset", message: "session synthesis state cleared" });
    },
    maxSynthesesPerSession,
  };
}

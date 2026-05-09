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
      // Include brickId so distinct failing bricks for the same agentType
      // do not share a dedupe bucket — otherwise once one signal is
      // processed, later failures from another brick are silently
      // suppressed as "already handled" (R5 round 19 finding).
      return `agent_repeated_failure:${t.agentType}:${t.brickId}`;
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
  // Wrap the verifier with a runtime check that the result is a strict
  // boolean. The TS type prevents async verifiers at compile time, but
  // hosts that pass through `as never` (or untyped JS) can otherwise leak
  // an async function in. An unresolved Promise is truthy in JS, so an
  // accidentally-async verifier would silently approve every register —
  // an authorization/integrity failure, not a perf miss (R5 round 11
  // finding).
  const wrappedVerifier =
    config.policyVerifier !== undefined
      ? (entry: Parameters<NonNullable<typeof config.policyVerifier>>[0]) => {
          const result = (config.policyVerifier as (e: unknown) => unknown)(entry);
          if (
            result !== null &&
            typeof result === "object" &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            throw new Error(
              "@koi/auto-harness: policyVerifier must return boolean synchronously. " +
                "An async verifier returns a Promise, which is truthy and would silently " +
                "approve every policy-cache registration — a trust-boundary failure. " +
                "Use a synchronous predicate; if verification needs I/O, perform it " +
                "before deploy and pass the resulting boolean.",
            );
          }
          if (typeof result !== "boolean") {
            throw new Error(
              `@koi/auto-harness: policyVerifier must return boolean, got ${typeof result}. ` +
                "Strict boolean is required so a non-boolean truthy value cannot " +
                "silently approve a registration.",
            );
          }
          return result;
        }
      : undefined;
  const policyCacheHandle = createPolicyCacheMiddleware({
    notifier: config.notifier,
    ...(wrappedVerifier !== undefined && { verifier: wrappedVerifier }),
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
  // Subscribe to store change events to invalidate completedTriggers.
  // Without this, a session-long dedupe persists across artifact
  // updates/removals/quarantines — operators recovering from a bad
  // deployment would find the same demand signal still suppressed as
  // "already processed" until the entire session is reset (R5 round 18
  // finding). Clearing completedTriggers across all sessions on any
  // store change is conservative but bounded: in-flight pipelines are
  // unaffected, and the next signal for a previously-handled trigger
  // gets a fresh attempt — exactly the recovery scenario operators need.
  // The session synthesis budget is preserved so a single change cannot
  // induce runaway re-synthesis.
  config.notifier?.subscribe(() => {
    for (const s of sessionState.values()) {
      s.completedTriggers.clear();
    }
  });
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
      // Do NOT dismiss: capacity is consumed by in-flight pipelines, but
      // a transient outcome will refund the slot. Permanently dismissing
      // means a later refund cannot un-skip this signal — the unrelated
      // signal would be lost forever (R5 round 14 finding). Leave it
      // pending so forge-demand re-emits after cooldown when capacity has
      // freed up.
      return null;
    }
    state.inFlightTriggers.add(triggerKey);
    state.count += 1;
    emitEvent({ kind: "synthesis.started", signalId: signal.id });
    try {
      const outcome = await runPipeline(signal, session);
      // Acknowledge the signal ONLY for non-transient terminal outcomes
      // (success, verification fail, policy block, approval denial). For
      // transient infrastructure failures, do NOT dismiss: the
      // forge-demand scoped dismiss clears the pending signal AND the
      // accumulated detector evidence (failure counter, cooldown entry).
      // Erasing that evidence means the next retry would have to
      // re-accumulate the failure threshold from scratch, defeating the
      // self-healing path on a transient generator/verifier/store/deploy
      // outage (R5 round 17 finding). Leave the signal pending so the
      // detector keeps it queued and re-fires once cooldown elapses.
      if (outcome.kind !== "transient") {
        safeDismiss();
        state.completedTriggers.add(triggerKey);
      } else {
        // Refund the budget for transient failures so a few outages
        // cannot exhaust the session cap and disable self-healing.
        state.count = Math.max(0, state.count - 1);
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

  const runPipeline = async (
    signal: ForgeDemandSignal,
    session: AutoHarnessSessionContext | undefined,
  ): Promise<PipelineOutcome> => {
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

    // Refuse to save a pre-deploy draft under an id that already exists in
    // the store. A buggy or compromised verifier could otherwise hand back
    // an existing live brickId, and `forgeStore.save` would overwrite that
    // record with our pre-approval draft. Later id-rewrite reconciliation
    // would then delete the unrelated brick — a real data-loss path. Use
    // `exists()` as a CAS-shaped check: if the id is already taken,
    // surface as transient (the verifier can retry with a fresh id) and
    // do not touch the store (R5 round 18 finding).
    try {
      const existsResult = await config.forgeStore.exists(artifact.id);
      if (!existsResult.ok) {
        reportError({
          stage: "verify",
          message: `forgeStore.exists check failed: ${existsResult.error.message}`,
          koiError: existsResult.error,
        });
        return transient();
      }
      if (existsResult.value) {
        reportError({
          stage: "verify",
          message:
            `auto-harness refused pre-deploy save: artifact id ${artifact.id} ` +
            "is already present in the forge store. Verifier must mint a fresh " +
            "id (or a dedicated draft-namespace id) per synthesis run; reusing " +
            "an existing id would overwrite the live record with a pre-approval " +
            "draft and risk data loss on later id-rewrite reconciliation.",
        });
        return transient();
      }
    } catch (cause: unknown) {
      reportError({
        stage: "verify",
        message: "forgeStore.exists threw",
        cause,
      });
      return transient();
    }

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
    // After deployCandidate reports success the live side effects are
    // committed. Downstream bookkeeping failures (missing authoritative
    // artifact, post-deploy save failure, register failure) MUST NOT
    // re-classify as transient — a retry would invoke deployCandidate
    // again and duplicate activation, promotion, or other non-idempotent
    // side effects. Mark non_retriable instead so the trigger stops
    // re-emitting; operators reconcile via the surfaced error rather than
    // re-deploy (R5 round 9 finding).
    // After deployCandidate reports success, live side effects are
    // committed. From this point on, downstream bookkeeping failures
    // (missing authoritative artifact, post-deploy save failure,
    // reconciliation failure) MUST surface as success carrying the
    // best-known artifact — collapsing to null would tell callers
    // "nothing deployed" while live state has changed, inviting
    // duplicate activation on retry or rollback against stale state
    // (R5 round 19 finding). Errors are surfaced via reportError so
    // operators can reconcile.
    if (deployment.artifact === undefined) {
      reportError({
        stage: "deploy",
        message:
          "deployCandidate returned ok without an authoritative artifact; " +
          "live deploy may have committed but the post-deploy record cannot " +
          "be persisted. Returning the pre-deploy draft as best-known " +
          "artifact so callers do not retry. Manual reconciliation required.",
      });
      // Pre-deploy draft is the best identifier we have — caller knows
      // a deployment may be live and should reconcile, not redeploy.
      return { kind: "success", artifact };
    }
    const deployedArtifact = deployment.artifact;

    try {
      const saveResult = await config.forgeStore.save(deployedArtifact);
      if (!saveResult.ok) {
        reportError({
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
    } catch (cause: unknown) {
      reportError({
        stage: "deploy",
        message:
          "forgeStore.save (post-deploy) threw. Live deploy committed but " +
          "durable record is stale; manual reconciliation required. " +
          "Returning the deployed artifact so callers do not retry.",
        cause,
      });
      return { kind: "success", artifact: deployedArtifact };
    }

    // Reconcile the pre-deploy draft when deployCandidate rewrote the
    // artifact id. Without this, the store keeps both the old draft and
    // the new deployed artifact, so inspection/rollback flows can act on
    // stale state or duplicate the harness because there's no single
    // durable source of truth. Best-effort: surface a reconciliation
    // error rather than failing the whole pipeline — the live deploy is
    // already committed and the new record is durable.
    if (deployedArtifact.id !== artifact.id) {
      try {
        const removeResult = await config.forgeStore.remove(artifact.id);
        if (!removeResult.ok) {
          reportError({
            stage: "deploy",
            message:
              `forgeStore.remove (draft reconciliation) failed: ${removeResult.error.message}. ` +
              `Both draft (${artifact.id}) and deployed (${deployedArtifact.id}) ` +
              "records exist; manual cleanup required.",
            koiError: removeResult.error,
          });
        }
      } catch (cause: unknown) {
        reportError({
          stage: "deploy",
          message:
            `forgeStore.remove (draft reconciliation) threw for ${artifact.id}. ` +
            "Stale draft record may persist alongside deployed artifact; manual cleanup required.",
          cause,
        });
      }
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
    // Validate policy-entry scope before registering. The auto-harness path
    // is session-scoped; a buggy or compromised deployCandidate could
    // otherwise hand back a `global` entry, escalating enforcement from
    // "fix this session's tool failure" into "change enforcement for all
    // traffic". By default, reject `global` scope and require the entry
    // to carry an `agentId`. Hosts that genuinely need global registration
    // must use a separately authorized path (R5 round 9 finding).
    const entry = deployment.policyEntry;
    if (entry !== undefined && entry.scope !== "agent") {
      reportError({
        stage: "register-policy",
        message:
          `auto-harness refused to register policyEntry with scope=${entry.scope}. ` +
          "Only `agent`-scoped entries are permitted via the demand-driven " +
          "pipeline; `global` registrations would escalate enforcement " +
          "outside the authorizing session and must use an explicit, " +
          "separately authorized path.",
      });
      return { kind: "success", artifact: deployedArtifact };
    }
    if (entry !== undefined && (entry.agentId === undefined || entry.agentId === "")) {
      reportError({
        stage: "register-policy",
        message:
          "auto-harness refused to register policyEntry with no agentId; " +
          "agent-scoped entries must identify the owning agent so cache " +
          "lookups cannot match other agents' traffic.",
      });
      return { kind: "success", artifact: deployedArtifact };
    }
    // Bind the policy entry to the agent that owns the demand-producing
    // session. Without this, deployCandidate could hand back an entry for
    // an unrelated agentId and the cache would short-circuit traffic for
    // an agent that never authorized this synthesis — a cross-agent
    // trust-boundary violation. When the host doesn't supply
    // `ownerAgentId` (out-of-band callers, stub adapters), the looser
    // non-empty-string check above stands; multi-tenant runtimes thread
    // the owner via runtime onSessionAttached (R5 round 19 finding).
    if (
      entry !== undefined &&
      session?.ownerAgentId !== undefined &&
      entry.agentId !== session.ownerAgentId
    ) {
      reportError({
        stage: "register-policy",
        message:
          `auto-harness refused to register policyEntry whose agentId (${entry.agentId}) ` +
          `does not match the owning agent (${session.ownerAgentId}). ` +
          "Cache entries must enforce only against the agent whose session " +
          "produced the demand signal; cross-agent registration would let " +
          "one agent's deployment change enforcement for an unrelated agent.",
      });
      return { kind: "success", artifact: deployedArtifact };
    }
    // Bind the policy entry to the artifact we actually deployed. A buggy
    // or compromised deployCandidate could otherwise hand back an entry
    // for a different brickId — already-verified artifact B — and the
    // cache would short-circuit traffic with the wrong policy. The
    // verifier alone cannot catch this since it sees only the supplied
    // entry, not the deployed-artifact context.
    if (entry !== undefined && entry.brickId !== deployedArtifact.id) {
      reportError({
        stage: "register-policy",
        message:
          `auto-harness refused to register policyEntry whose brickId (${entry.brickId}) ` +
          `does not match the deployed artifact id (${deployedArtifact.id}). ` +
          "Cache entries must be bound to the specific artifact that was " +
          "approved and deployed; cross-artifact registration would let one " +
          "deployment promote enforcement for an unrelated brick.",
      });
      return { kind: "success", artifact: deployedArtifact };
    }
    if (entry !== undefined && config.policyVerifier !== undefined) {
      try {
        const result = policyCacheHandle.register(entry);
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

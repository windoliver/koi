import type {
  AgentId,
  CompositionExecutionResult,
  CompositionGap,
  CompositionPlan,
  CompositionStep,
  CompositionTrigger,
} from "@koi/core";

/**
 * Per-session rate limit tracker. Counts compositions executed within the
 * current session window so the governance gate can refuse runaway plans.
 *
 * `count(sessionId)` returns the running count for the session.
 * `increment(sessionId)` is called after a successful execute().
 *
 * Implementations may be in-memory (process-local) or backed by a durable
 * store. Either may return a Promise so async backends are supported.
 */
export interface SessionRateTracker {
  readonly count: (sessionId: string) => number | Promise<number>;
  readonly increment: (sessionId: string) => void | Promise<void>;
  /** Drop a session's count — used by tests; optional for production backends. */
  readonly reset?: ((sessionId: string) => void | Promise<void>) | undefined;
}

/**
 * Tracks how many times a composition pattern (e.g. trigger source +
 * moment kind) has executed successfully. The governance gate uses this to
 * auto-approve novel patterns once they've succeeded N times — codifying
 * the "first time → approval; after N successes → auto-approve" rule from
 * the design.
 */
export interface NoveltyTracker {
  readonly successCount: (patternKey: string) => number | Promise<number>;
  readonly recordSuccess: (patternKey: string) => void | Promise<void>;
  readonly reset?: ((patternKey: string) => void | Promise<void>) | undefined;
}

/**
 * Optional sink for execution outcomes. Hosts wire this to ACE
 * trajectory recording, collective-memory trail strengthening, or any
 * other downstream that wants to observe completed plans. The executor
 * calls `record(...)` exactly once per execute(), regardless of result
 * status; `recordGap(...)` is invoked when the executor surfaces an
 * unsupported step (capability gap → ForgeDemand candidate).
 */
export interface OutcomeRecorder {
  readonly record?:
    | ((
        trigger: CompositionTrigger,
        plan: CompositionPlan,
        result: CompositionExecutionResult,
      ) => void | Promise<void>)
    | undefined;
  readonly recordGap?: ((gap: CompositionGap) => void | Promise<void>) | undefined;
}

/**
 * Governance configuration — the 5-component gate from the issue:
 *  1. Confidence threshold (auto-approve if `trigger.confidence >= threshold`)
 *  2. Budget cap (`plan.estimatedCost <= maxCostPerComposition`)
 *  3. Delegation check (caller-supplied; verifies the agent has scope tokens)
 *  4. Rate limit (`SessionRateTracker.count(sessionId) < maxCompositionsPerSession`)
 *  5. Novel-pattern guard (first-seen pattern requires approval until N successes)
 *
 * All fields are optional with documented defaults (see DEFAULT_COMPOSITION_GOVERNANCE).
 * If a tracker is absent (`sessionRate`/`novelty` on the executor context),
 * the corresponding gate component is skipped — hosts opt in to each lever.
 */
export interface CompositionGovernance {
  readonly maxCompositionsPerSession?: number | undefined;
  readonly autoApproveConfidenceThreshold?: number | undefined;
  readonly maxCostPerComposition?: number | undefined;
  readonly novelPatternRequiresApproval?: boolean | undefined;
  readonly novelPatternAutoApproveAfter?: number | undefined;
  /**
   * Optional caller-supplied delegation check. Returns true to allow,
   * false (or a non-empty array of denial reasons) to require approval.
   * The executor surfaces denial reasons in the approval message so
   * operators can see exactly which scope was missing.
   */
  readonly delegationCheck?:
    | ((
        agentId: AgentId,
        plan: CompositionPlan,
      ) => boolean | readonly string[] | Promise<boolean | readonly string[]>)
    | undefined;
  /**
   * Override how a trigger maps to a "novelty pattern key". Two triggers
   * with the same key are considered the same pattern for the
   * novel-pattern guard. Defaults to `${trigger.source}|${trigger.moment.kind}`.
   */
  readonly patternKey?: ((trigger: CompositionTrigger) => string) | undefined;
}

export const DEFAULT_COMPOSITION_GOVERNANCE = {
  maxCompositionsPerSession: 5,
  autoApproveConfidenceThreshold: 0.85,
  maxCostPerComposition: 1.0,
  novelPatternRequiresApproval: true,
  novelPatternAutoApproveAfter: 3,
} as const;

export type GateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Default novelty key — narrow enough that distinct trigger sources don't
 * cross-pollinate the success counter, broad enough that variant `id`s of
 * the same logical trigger collapse onto one pattern.
 */
export function defaultPatternKey(trigger: CompositionTrigger): string {
  return `${trigger.source}|${trigger.moment.kind}`;
}

/**
 * Evaluate the 5-component governance gate against a trigger + plan.
 * Returns `{ allowed: true }` or `{ allowed: false, reason }` so the caller
 * can produce a single approval-required result with a human-readable
 * explanation. Order: cheap sync checks first (cost, confidence), then the
 * potentially-async checks (delegation, rate limit, novelty).
 */
export async function evaluateCompositionGate(args: {
  readonly trigger: CompositionTrigger;
  readonly plan: CompositionPlan;
  readonly agentId: AgentId;
  readonly governance: CompositionGovernance;
  readonly sessionId?: string | undefined;
  readonly sessionRate?: SessionRateTracker | undefined;
  readonly novelty?: NoveltyTracker | undefined;
}): Promise<GateDecision> {
  const g = args.governance;
  const cap = g.maxCostPerComposition ?? DEFAULT_COMPOSITION_GOVERNANCE.maxCostPerComposition;
  if (args.plan.estimatedCost > cap) {
    return {
      allowed: false,
      reason: `plan.estimatedCost ${args.plan.estimatedCost} exceeds maxCostPerComposition ${cap}`,
    };
  }

  const minConfidence =
    g.autoApproveConfidenceThreshold ??
    DEFAULT_COMPOSITION_GOVERNANCE.autoApproveConfidenceThreshold;
  if (args.trigger.confidence < minConfidence) {
    return {
      allowed: false,
      reason: `trigger.confidence ${args.trigger.confidence} below autoApproveConfidenceThreshold ${minConfidence}`,
    };
  }

  if (g.delegationCheck !== undefined) {
    const verdict = await g.delegationCheck(args.agentId, args.plan);
    if (verdict === false) {
      return { allowed: false, reason: "delegation check denied plan" };
    }
    if (Array.isArray(verdict) && verdict.length > 0) {
      return {
        allowed: false,
        reason: `delegation check denied plan: ${verdict.join(", ")}`,
      };
    }
  }

  if (args.sessionId !== undefined && args.sessionRate !== undefined) {
    const limit =
      g.maxCompositionsPerSession ?? DEFAULT_COMPOSITION_GOVERNANCE.maxCompositionsPerSession;
    const used = await args.sessionRate.count(args.sessionId);
    if (used >= limit) {
      return {
        allowed: false,
        reason: `session ${args.sessionId} reached maxCompositionsPerSession ${limit} (current ${used})`,
      };
    }
  }

  const novelGuardOn =
    g.novelPatternRequiresApproval ?? DEFAULT_COMPOSITION_GOVERNANCE.novelPatternRequiresApproval;
  if (novelGuardOn && args.novelty !== undefined) {
    const keyFn = g.patternKey ?? defaultPatternKey;
    const key = keyFn(args.trigger);
    const successes = await args.novelty.successCount(key);
    const threshold =
      g.novelPatternAutoApproveAfter ?? DEFAULT_COMPOSITION_GOVERNANCE.novelPatternAutoApproveAfter;
    if (successes < threshold) {
      return {
        allowed: false,
        reason: `pattern "${key}" has ${successes} prior successes; needs ${threshold} before auto-approval`,
      };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// In-memory tracker implementations — process-local, suitable for tests and
// single-process callers. Production deployments wanting cross-restart or
// cross-process semantics should provide a durable tracker.
// ---------------------------------------------------------------------------

export function inMemorySessionRateTracker(): SessionRateTracker {
  const counts = new Map<string, number>();
  return {
    count: (sessionId) => counts.get(sessionId) ?? 0,
    increment: (sessionId) => {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    },
    reset: (sessionId) => {
      counts.delete(sessionId);
    },
  };
}

export function inMemoryNoveltyTracker(): NoveltyTracker {
  const counts = new Map<string, number>();
  return {
    successCount: (key) => counts.get(key) ?? 0,
    recordSuccess: (key) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    reset: (key) => {
      counts.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// CompositionGap inference — when a step kind has no wired handler, infer
// the missing capability from the step shape so OutcomeRecorder.recordGap()
// can feed the ForgeDemand pipeline.
// ---------------------------------------------------------------------------

export function inferMissingCapabilities(step: CompositionStep): readonly string[] {
  switch (step.kind) {
    case "tool_call":
      return [`tool:${step.toolName}`];
    case "spawn_agent":
      return [`agent:${step.agentType}`];
    case "forge_skill": {
      const failed = step.demand.context.failedToolCalls;
      const target = failed.length > 0 ? failed.join(",") : step.demand.suggestedBrickKind;
      return [`forge:${target}`];
    }
    case "submit_task":
    case "create_schedule":
      return [`scheduler:${step.kind}`];
    case "notify_user":
      return [`channel:${step.channel}`];
  }
}

/**
 * Build a CompositionGap from a trigger + unsupported step + clock. The
 * recorder is responsible for merging multiple gaps with the same
 * trigger+capability into a single record (incrementing `frequency`,
 * extending `lastSeen`); the executor only emits the per-step instance.
 */
export function inferCompositionGap(args: {
  readonly trigger: CompositionTrigger;
  readonly step: CompositionStep;
  readonly now: number;
}): CompositionGap {
  return {
    triggerId: args.trigger.id,
    moment: args.trigger.moment,
    missingCapabilities: inferMissingCapabilities(args.step),
    firstSeen: args.now,
    lastSeen: args.now,
    frequency: 1,
  };
}

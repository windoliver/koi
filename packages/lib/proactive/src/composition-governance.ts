import { createHash } from "node:crypto";
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
  /**
   * Atomic check-and-increment: returns true and consumes one slot iff the
   * session is currently below `limit`. Implementations MUST make this
   * single-call atomic across concurrent callers — a naive count + increment
   * pair leaks the cap under parallel execute() calls. Backends may use a
   * compare-and-swap, transaction, or single-threaded mutex.
   *
   * MANDATORY (not optional). The earlier non-atomic count+increment
   * fallback was removed because it silently let bursts exceed the cap;
   * the gate now fails closed if a tracker is missing this method.
   */
  readonly tryAcquire: (sessionId: string, limit: number) => boolean | Promise<boolean>;
  /**
   * Release a slot acquired via `tryAcquire`. Called when the executor
   * acquired upfront but the resulting execution was a replay (no fresh
   * side effect) or the plan was rejected post-acquire. Idempotent.
   * MANDATORY so denied/replay-only runs cannot permanently burn quota.
   */
  readonly release: (sessionId: string) => void | Promise<void>;
  /** Read-only count; used by tests and external monitors. */
  readonly count: (sessionId: string) => number | Promise<number>;
  /**
   * Non-atomic increment — kept for legacy callers / direct seeding in
   * tests. The executor itself does not use it; tryAcquire is the
   * authoritative consumer of slots.
   */
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
   * Override how an (agentId, trigger, plan) triple maps to a "novelty
   * pattern key". Triples with the same key share novelty credit.
   * Defaults to `defaultPatternKey` which folds in agentId (so cross-agent
   * approval credit cannot leak through a shared NoveltyTracker), the
   * moment-specific discriminators, AND a hash of the canonicalized plan
   * step bodies. The `plan` and `agentId` args are optional so callers in
   * unit tests can derive partial keys.
   */
  readonly patternKey?:
    | ((
        trigger: CompositionTrigger,
        plan?: CompositionPlan | undefined,
        agentId?: AgentId | undefined,
      ) => string)
    | undefined;
}

export const DEFAULT_COMPOSITION_GOVERNANCE = {
  maxCompositionsPerSession: 5,
  autoApproveConfidenceThreshold: 0.85,
  maxCostPerComposition: 1.0,
  novelPatternRequiresApproval: true,
  novelPatternAutoApproveAfter: 3,
} as const;

export type GateDecision =
  | {
      readonly allowed: true;
      /**
       * True iff the gate consumed a session-rate slot via
       * `tryAcquire`. The executor MUST call `sessionRate.release(sessionId)`
       * if execution turns out to be a replay (no fresh side effect) or
       * fails post-acquire.
       */
      readonly acquiredSessionSlot: boolean;
    }
  | { readonly allowed: false; readonly reason: string };

/**
 * Default novelty key — folds materially-distinguishing moment fields AND
 * the plan's action footprint into the bucket. Two key principles:
 *  1. The trigger half (source + moment + discriminators) prevents
 *     unrelated triggers from sharing approval credit.
 *  2. The plan half (sorted unique step kinds) prevents a planner from
 *     swapping in a materially different remediation after benign
 *     history accumulates — an `[notify_user]` plan that succeeded 3x
 *     does NOT auto-approve a `[submit_task, create_schedule]` plan
 *     against the same trigger.
 *
 * When `plan` is omitted (e.g. unit tests calling the helper directly),
 * the key omits the plan footprint and falls back to trigger-only.
 */
export function defaultPatternKey(
  trigger: CompositionTrigger,
  plan?: CompositionPlan | undefined,
  agentId?: AgentId | undefined,
): string {
  // agentId is included so cross-agent (and by extension cross-tenant)
  // approval credit cannot leak through a shared NoveltyTracker.
  // Falls back to "*" only when agentId isn't supplied (unit tests).
  const agentKey = agentId === undefined ? "*" : String(agentId);
  const m = trigger.moment;
  let triggerKey: string;
  switch (m.kind) {
    case "capability_gap":
      triggerKey = `${agentKey}|${trigger.source}|capability_gap|${m.missing}`;
      break;
    case "threshold_crossed":
      triggerKey = `${agentKey}|${trigger.source}|threshold_crossed|${m.sensor}|${m.direction}`;
      break;
    case "pattern_matched":
      triggerKey = `${agentKey}|${trigger.source}|pattern_matched|${m.patternId}`;
      break;
    case "task_terminal":
      triggerKey = `${agentKey}|${trigger.source}|task_terminal|${m.outcome}`;
      break;
    case "external_event":
      triggerKey = `${agentKey}|${trigger.source}|external_event|${m.source}|${m.eventType}`;
      break;
    case "frontier_changed":
      triggerKey = `${agentKey}|${trigger.source}|frontier_changed|${m.metric}`;
      break;
  }
  if (plan === undefined) return triggerKey;
  // Hash the canonicalized step payloads (sorted object keys, undefined
  // dropped) so materially different action contents — a different
  // notify_user message, a different submit_task agentId/input, a
  // different cron expression — produce distinct novelty buckets. Two
  // plans with byte-identical (post-canonicalize) steps still collapse
  // onto one pattern, so re-running the same automation accumulates
  // approval credit as intended.
  const canonicalSteps = JSON.stringify(plan.steps.map(canonicalize));
  const planHash = createHash("sha256").update(canonicalSteps).digest("hex").slice(0, 16);
  return `${triggerKey}|plan:${planHash}`;
}

// Stable JSON canonicalization — duplicated from composition-executor.ts
// (no L2-to-L2 cross-import). Sort object keys, drop undefined, recurse.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
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
  let acquiredSessionSlot = false;
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
    // tryAcquire and release are now required at the type level. The
    // earlier optional-fallback path was removed because it both raced
    // (count+increment under concurrent callers) and could permanently
    // burn quota (acquire without release). Existing in-memory and
    // Sqlite backends in this package implement both — external trackers
    // need to do the same to compile.
    const acquired = await args.sessionRate.tryAcquire(args.sessionId, limit);
    if (!acquired) {
      return {
        allowed: false,
        reason: `session ${args.sessionId} reached maxCompositionsPerSession ${limit}`,
      };
    }
    acquiredSessionSlot = true;
  }

  const novelGuardOn =
    g.novelPatternRequiresApproval ?? DEFAULT_COMPOSITION_GOVERNANCE.novelPatternRequiresApproval;
  if (novelGuardOn && args.novelty !== undefined) {
    const keyFn = g.patternKey ?? defaultPatternKey;
    const key = keyFn(args.trigger, args.plan, args.agentId);
    const successes = await args.novelty.successCount(key);
    const threshold =
      g.novelPatternAutoApproveAfter ?? DEFAULT_COMPOSITION_GOVERNANCE.novelPatternAutoApproveAfter;
    if (successes < threshold) {
      // Release the session slot acquired upstream so the failed novelty
      // check doesn't burn budget. Best-effort: release errors are silent.
      if (acquiredSessionSlot && args.sessionId !== undefined && args.sessionRate?.release) {
        try {
          await args.sessionRate.release(args.sessionId);
        } catch {
          /* release failure is observability-only */
        }
      }
      return {
        allowed: false,
        reason: `pattern "${key}" has ${successes} prior successes; needs ${threshold} before auto-approval`,
      };
    }
  }

  return { allowed: true, acquiredSessionSlot };
}

// ---------------------------------------------------------------------------
// In-memory tracker implementations — process-local, suitable for tests and
// single-process callers. Production deployments wanting cross-restart or
// cross-process semantics should provide a durable tracker.
// ---------------------------------------------------------------------------

export function inMemorySessionRateTracker(): SessionRateTracker {
  const counts = new Map<string, number>();
  return {
    // JavaScript event loop is single-threaded, so the read-then-write
    // sequence below IS atomic with respect to other JS code in this
    // process — no two callers can interleave. Cross-process backends
    // need a real CAS or transactional primitive.
    tryAcquire: (sessionId, limit) => {
      const used = counts.get(sessionId) ?? 0;
      if (used >= limit) return false;
      counts.set(sessionId, used + 1);
      return true;
    },
    release: (sessionId) => {
      const used = counts.get(sessionId) ?? 0;
      if (used > 0) counts.set(sessionId, used - 1);
    },
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

/**
 * Scan a plan against a host-supplied capability map and return one
 * CompositionGap per step whose required capability is missing. Use this
 * from the *planner* or *approval-handling* layer to feed ForgeDemand
 * BEFORE the executor would otherwise short-circuit on `requiresApproval`
 * or governance denial — the executor itself only emits gaps from real
 * execution attempts (trust boundary: it does not record gaps from
 * un-approved planner-authored payloads).
 *
 * `wiredCapabilities` should reflect what the host has actually wired:
 * e.g. `{ tools: ["summarize", "ocr"], agents: ["researcher"] }`. A step
 * whose required capability is absent yields a CompositionGap; steps
 * that don't map to a planner-controlled capability (notify_user,
 * submit_task, create_schedule) are skipped — the L0 scheduler/notifier
 * handlers are mandatory, so the host never declines them.
 */
export function extractCapabilityGapsFromPlan(args: {
  readonly trigger: CompositionTrigger;
  readonly plan: CompositionPlan;
  readonly wiredCapabilities: {
    readonly tools?: ReadonlySet<string> | readonly string[] | undefined;
    readonly agents?: ReadonlySet<string> | readonly string[] | undefined;
    readonly forge?: ReadonlySet<string> | readonly string[] | undefined;
  };
  readonly now: number;
}): readonly CompositionGap[] {
  const toSet = (s: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> =>
    s instanceof Set ? s : new Set(s ?? []);
  const tools = toSet(args.wiredCapabilities.tools);
  const agents = toSet(args.wiredCapabilities.agents);
  const forge = toSet(args.wiredCapabilities.forge);
  const out: CompositionGap[] = [];
  for (const step of args.plan.steps) {
    let missing = false;
    switch (step.kind) {
      case "tool_call":
        missing = !tools.has(step.toolName);
        break;
      case "spawn_agent":
        missing = !agents.has(step.agentType);
        break;
      case "forge_skill":
        missing =
          step.demand.context.failedToolCalls.length > 0
            ? !step.demand.context.failedToolCalls.every((t) => forge.has(t))
            : !forge.has(step.demand.suggestedBrickKind);
        break;
      default:
        missing = false;
    }
    if (missing) out.push(inferCompositionGap({ trigger: args.trigger, step, now: args.now }));
  }
  return out;
}

/**
 * ACE middleware — records trajectory, injects active playbooks, and (optionally)
 * runs the AGP propose -> evaluate -> commit pipeline through the promotion gate
 * on session end.
 *
 * Two pipelines:
 *   - Stat pipeline (default, no LLM): aggregate identifier stats → score →
 *     EMA-blended flat playbooks via `playbookStore`.
 *   - Structured pipeline (opt-in): a `structuredPipeline` config wires a
 *     reflector + curator + evaluator with a `proposalStore` and
 *     `structuredStore`, gated by `commitPromotion`. Failures are caught and
 *     logged but never block session end.
 */

import type {
  AggregatedStats,
  CuratorOperation,
  Playbook,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PlaybookStore,
  ReflectionResult,
  StructuredPlaybook,
  StructuredPlaybookStore,
  TrajectoryEntry,
  TrajectoryRange,
  TrajectoryStore,
} from "@koi/ace-types";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

import type { ConsolidateFn } from "./consolidator.js";
import { createDefaultConsolidator } from "./consolidator.js";
import { formatActivePlaybooksMessage, selectPlaybooks } from "./injector.js";
import { commitPromotion } from "./promotion-gate.js";
import { aggregateTrajectoryStats, curateTrajectorySummary } from "./stats-aggregator.js";

const DEFAULT_MAX_INJECTED_TOKENS = 800;
const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_LAMBDA = 0.05;
const DEFAULT_STRUCTURED_TOKEN_BUDGET = 2000;

/** Reflector: LLM-backed (or stubbed) trajectory analyzer. */
export type ReflectorFn = (input: {
  readonly trajectory: readonly TrajectoryEntry[];
  readonly outcome: "success" | "failure" | "mixed";
  readonly playbook: StructuredPlaybook;
}) => Promise<ReflectionResult>;

/** Curator: produces a delta over a structured playbook from a reflection. */
export type CuratorFn = (input: {
  readonly playbook: StructuredPlaybook;
  readonly reflection: ReflectionResult;
  readonly tokenBudget: number;
}) => Promise<readonly CuratorOperation[]>;

/** Evaluator: emits a verdict for the proposed delta. */
export type EvaluatorFn = (input: {
  readonly trajectory: readonly TrajectoryEntry[];
  readonly proposal: PlaybookProposal;
  readonly playbookBefore: StructuredPlaybook;
}) => Promise<PlaybookEvaluation>;

/**
 * Opt-in AGP propose -> evaluate -> commit pipeline. Wires reflector + curator
 * + evaluator behind the promotion gate. Without this set, the middleware
 * runs only the stat pipeline (existing behavior, unchanged).
 */
export interface AceStructuredPipelineConfig {
  readonly structuredStore: StructuredPlaybookStore;
  readonly proposalStore: PlaybookProposalStore;
  /** ID of the structured playbook this pipeline updates. */
  readonly playbookId: string;
  readonly reflector: ReflectorFn;
  readonly curator: CuratorFn;
  readonly evaluator: EvaluatorFn;
  readonly thresholds: import("@koi/ace-types").PromotionThresholds;
  /** Token budget passed to the curator. Default 2000. */
  readonly tokenBudget?: number;
  /**
   * ID generator for proposal/evaluation IDs. Default uses crypto.randomUUID.
   * Tests inject deterministic IDs.
   */
  readonly idGenerator?: () => string;
  /**
   * Optional sink for pipeline errors so callers can observe/escalate without
   * blocking session end. Defaults to a no-op (pipeline failures are
   * swallowed by design).
   */
  readonly onError?: (err: unknown) => void;
}

/** Pluggable, mostly-optional config for the ACE middleware. */
export interface AceConfig {
  /** Persistent playbook backend. Required. */
  readonly playbookStore: PlaybookStore;
  /** Optional persistent trajectory store. When omitted, trajectories are
   *  consolidated in-memory and discarded at session end. */
  readonly trajectoryStore?: TrajectoryStore;
  /** Maximum tokens reserved for the `[Active Playbooks]` injection. Default 800. */
  readonly maxInjectedTokens?: number;
  /** Minimum curation score below which candidates are dropped. Default 0.05. */
  readonly minScore?: number;
  /** Recency-decay lambda (per day). Default 0.05. */
  readonly lambda?: number;
  /** Override the default EMA consolidator. */
  readonly consolidate?: ConsolidateFn;
  /** Timestamp source. Default `Date.now`. */
  readonly clock?: () => number;
  /**
   * Opt-in AGP structured pipeline. When set, on session end the middleware
   * runs reflector → curator → evaluator → promotion gate against the
   * configured structured playbook. The stat pipeline still runs alongside
   * (they target different stores).
   */
  readonly structuredPipeline?: AceStructuredPipelineConfig;
}

/** Per-session mutable state — entries accumulate, `playbooks` is the snapshot
 *  loaded on session start (refreshed after consolidation). */
interface AceSessionState {
  entries: readonly TrajectoryEntry[];
  playbooks: readonly Playbook[];
  turnIndex: number;
}

/**
 * Create the ACE middleware. State lives in a `Map<SessionId, AceSessionState>`
 * scoped by `onSessionStart` / `onSessionEnd` so each runtime gets a clean slate.
 */
export function createAceMiddleware(config: AceConfig): KoiMiddleware {
  const maxInjectedTokens = config.maxInjectedTokens ?? DEFAULT_MAX_INJECTED_TOKENS;
  const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  const lambda = config.lambda ?? DEFAULT_LAMBDA;
  const clock = config.clock ?? Date.now;
  const consolidate = config.consolidate ?? createDefaultConsolidator({ clock });

  const sessions = new Map<string, AceSessionState>();

  function getState(ctx: SessionContext): AceSessionState | undefined {
    return sessions.get(ctx.sessionId);
  }

  function recordEntry(state: AceSessionState | undefined, entry: TrajectoryEntry): void {
    if (state === undefined) return;
    state.entries = [...state.entries, entry];
  }

  return {
    name: "ace",
    phase: "observe",
    priority: 800,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const playbooks = await config.playbookStore.list();
      sessions.set(ctx.sessionId, {
        entries: [],
        playbooks,
        turnIndex: 0,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const state = sessions.get(ctx.sessionId);
      sessions.delete(ctx.sessionId);
      if (state === undefined || state.entries.length === 0) return;

      if (config.trajectoryStore !== undefined) {
        await config.trajectoryStore.append(ctx.sessionId, state.entries);
      }

      const stats = aggregateTrajectoryStats(state.entries);
      const candidates = curateTrajectorySummary(stats, 1, {
        minScore,
        nowMs: clock(),
        lambda,
      });
      const updated = consolidate(candidates, state.playbooks);
      for (const pb of updated) {
        await config.playbookStore.save(pb);
      }

      if (config.structuredPipeline !== undefined) {
        try {
          await runStructuredPipeline(
            ctx.sessionId,
            state.entries,
            config.structuredPipeline,
            clock,
          );
        } catch (err: unknown) {
          // Structured pipeline failures must NEVER block session end. Surface
          // through onError if the caller wired one; otherwise swallow.
          config.structuredPipeline.onError?.(err);
        }
      }
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const state = getState(ctx.session);
      if (state === undefined) return;
      state.turnIndex = ctx.turnIndex;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = getState(ctx.session);
      const enriched = injectPlaybooks(request, state, maxInjectedTokens);
      const startedAt = clock();
      const outcome = await runWithOutcome(() => next(enriched));
      const durationMs = clock() - startedAt;
      const identifier = enriched.model ?? "unknown-model";
      recordEntry(state, {
        turnIndex: ctx.turnIndex,
        timestamp: startedAt,
        kind: "model_call",
        identifier,
        outcome: outcome.outcome,
        durationMs,
      });
      return outcome.unwrap();
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = getState(ctx.session);
      const startedAt = clock();
      const outcome = await runWithOutcome(() => next(request));
      const durationMs = clock() - startedAt;
      recordEntry(state, {
        turnIndex: state?.turnIndex ?? 0,
        timestamp: startedAt,
        kind: "tool_call",
        identifier: request.toolId,
        outcome: outcome.outcome,
        durationMs,
      });
      return outcome.unwrap();
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = getState(ctx.session);
      const count = state?.playbooks.length ?? 0;
      return {
        label: "ace",
        description: `ACE: ${count} active playbook(s) within ${maxInjectedTokens} tokens`,
      };
    },
  };
}

/** Internal helper: discriminated outcome wrapper for model/tool handlers. */
type Outcome<T> =
  | { readonly outcome: "success"; readonly unwrap: () => T }
  | { readonly outcome: "failure"; readonly unwrap: () => never };

async function runWithOutcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    const value = await fn();
    return { outcome: "success", unwrap: () => value };
  } catch (err: unknown) {
    return {
      outcome: "failure",
      unwrap: (): never => {
        throw err;
      },
    };
  }
}

/** Prepend the `[Active Playbooks]` block to `systemPrompt`, never mutates. */
function injectPlaybooks(
  request: ModelRequest,
  state: AceSessionState | undefined,
  maxTokens: number,
): ModelRequest {
  if (state === undefined || state.playbooks.length === 0) return request;
  const selected = selectPlaybooks(state.playbooks, { maxTokens });
  const text = formatActivePlaybooksMessage(selected);
  if (text === "") return request;
  const systemPrompt =
    request.systemPrompt !== undefined && request.systemPrompt.length > 0
      ? `${text}\n\n${request.systemPrompt}`
      : text;
  return { ...request, systemPrompt };
}

/** Re-export aggregation helper for downstream tests/debugging. */
export type { AggregatedStats };

/** Default UUID-based ID generator. */
function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

/** Determine an aggregate outcome label from compact trajectory entries. */
function summarizeOutcome(entries: readonly TrajectoryEntry[]): "success" | "failure" | "mixed" {
  let any = false;
  let allSuccess = true;
  let allFailure = true;
  for (const e of entries) {
    any = true;
    if (e.outcome === "success") allFailure = false;
    else if (e.outcome === "failure") allSuccess = false;
    else {
      allSuccess = false;
      allFailure = false;
    }
  }
  if (!any) return "mixed";
  if (allSuccess) return "success";
  if (allFailure) return "failure";
  return "mixed";
}

/**
 * Run the AGP propose -> evaluate -> commit pipeline for one session window.
 *
 * Failure modes are surfaced as thrown errors so the caller can route them to
 * `onError` without blocking session end. Successful execution returns void;
 * the promote/reject decision is encoded in the structured store + audit log.
 */
async function runStructuredPipeline(
  sessionId: string,
  entries: readonly TrajectoryEntry[],
  pipe: AceStructuredPipelineConfig,
  clock: () => number,
): Promise<void> {
  const playbook = await pipe.structuredStore.get(pipe.playbookId);
  if (playbook === undefined) {
    throw new Error(
      `ACE structured pipeline: playbook ${pipe.playbookId} not found in structuredStore`,
    );
  }

  const outcome = summarizeOutcome(entries);
  const reflection = await pipe.reflector({ trajectory: entries, outcome, playbook });

  const tokenBudget = pipe.tokenBudget ?? DEFAULT_STRUCTURED_TOKEN_BUDGET;
  const operations = await pipe.curator({ playbook, reflection, tokenBudget });

  // No-op curation: nothing to commit. Skip the gate entirely.
  if (operations.length === 0) return;

  const idGen = pipe.idGenerator ?? defaultIdGenerator;
  const now = clock();
  const sourceTrajectoryRange: TrajectoryRange = {
    sessionId,
    fromStepIndex: 0,
    toStepIndex: entries.length,
  };

  const proposal: PlaybookProposal = {
    id: idGen(),
    playbookId: pipe.playbookId,
    baseVersion: playbook.version,
    operations,
    sourceTrajectoryRange,
    reflection,
    createdAt: now,
  };

  // Pre-record per the gate's contract: real proposal stores enforce a
  // baseVersion-FK on fresh inserts, so the proposal must be persisted while
  // baseVersion still equals the live head. Idempotent on retry.
  await pipe.proposalStore.recordProposal(proposal);

  const evaluation = await pipe.evaluator({
    trajectory: entries,
    proposal,
    playbookBefore: playbook,
  });

  // The gate handles promote / reject end-to-end (audit-first ordering, head
  // advance only on promote). Rollback verdicts are routed elsewhere — they
  // are not produced by the consolidation pipeline; an explicit rollback
  // operator drives those through rollbackPromotion() directly.
  if (evaluation.verdict === "rollback") {
    throw new Error(
      "ACE structured pipeline: evaluator returned 'rollback' verdict; consolidation pipeline only handles promote/reject. Use rollbackPromotion() directly for rollback flows.",
    );
  }

  await commitPromotion(
    {
      structuredStore: pipe.structuredStore,
      proposalStore: pipe.proposalStore,
      clock,
    },
    proposal,
    evaluation,
    pipe.thresholds,
  );
}

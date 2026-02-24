/**
 * ACE middleware factory — Adaptive Continuous Enhancement.
 *
 * Records action/outcome trajectories per session, curates high-value patterns,
 * consolidates learnings into persistent playbooks, and auto-injects relevant
 * strategies into future sessions.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { AceConfig } from "./config.js";
import { createDefaultConsolidator } from "./consolidator.js";
import { curateTrajectorySummary } from "./curator.js";
import { selectPlaybooks } from "./injector.js";
import { computeCurationScore } from "./scoring.js";
import { createTrajectoryBuffer } from "./trajectory-buffer.js";
import type { Playbook, TrajectoryEntry } from "./types.js";

const DEFAULT_MAX_INJECTION_TOKENS = 500;
const DEFAULT_MIN_PLAYBOOK_CONFIDENCE = 0.3;
const DEFAULT_MAX_BUFFER_ENTRIES = 1000;
const DEFAULT_MIN_CURATION_SCORE = 0.1;
const DEFAULT_RECENCY_DECAY_LAMBDA = 0.01;

/** Creates the ACE middleware instance. */
export function createAceMiddleware(config: AceConfig): KoiMiddleware {
  const clock = config.clock ?? Date.now;
  const buffer = createTrajectoryBuffer(config.maxBufferEntries ?? DEFAULT_MAX_BUFFER_ENTRIES);

  function recordEntry(entry: TrajectoryEntry): void {
    const evicted = buffer.record(entry);
    config.onRecord?.(entry);
    if (evicted > 0) {
      config.onBufferEvict?.(evicted);
    }
  }

  return {
    name: "ace",
    priority: 350,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // Load and select playbooks for injection
      const listOptions: {
        readonly tags?: readonly string[];
        readonly minConfidence?: number;
      } = {
        ...(config.playbookTags !== undefined ? { tags: config.playbookTags } : {}),
        minConfidence: config.minPlaybookConfidence ?? DEFAULT_MIN_PLAYBOOK_CONFIDENCE,
      };
      const playbooks = await config.playbookStore.list(listOptions);

      const selected = selectPlaybooks(playbooks, {
        maxTokens: config.maxInjectionTokens ?? DEFAULT_MAX_INJECTION_TOKENS,
        clock,
      });

      // Build enriched request if playbooks are available
      const enrichedRequest: ModelRequest =
        selected.length > 0 ? buildEnrichedRequest(request, selected, clock) : request;

      if (selected.length > 0) {
        config.onInject?.(selected);
      }

      // Execute and record outcome
      const start = clock();
      try {
        const response = await next(enrichedRequest);
        recordEntry({
          turnIndex: ctx.turnIndex,
          timestamp: clock(),
          kind: "model_call",
          identifier: response.model,
          outcome: "success",
          durationMs: clock() - start,
        });
        return response;
      } catch (e: unknown) {
        recordEntry({
          turnIndex: ctx.turnIndex,
          timestamp: clock(),
          kind: "model_call",
          identifier: request.model ?? "unknown",
          outcome: "failure",
          durationMs: clock() - start,
        });
        throw e;
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const start = clock();
      try {
        const response = await next(request);
        recordEntry({
          turnIndex: ctx.turnIndex,
          timestamp: clock(),
          kind: "tool_call",
          identifier: request.toolId,
          outcome: "success",
          durationMs: clock() - start,
        });
        return response;
      } catch (e: unknown) {
        recordEntry({
          turnIndex: ctx.turnIndex,
          timestamp: clock(),
          kind: "tool_call",
          identifier: request.toolId,
          outcome: "failure",
          durationMs: clock() - start,
        });
        throw e;
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const entries = buffer.flush();
      if (entries.length === 0) return;

      try {
        // Persist trajectory
        await config.trajectoryStore.append(ctx.sessionId, entries);

        // Get session count for frequency normalization
        const sessions = await config.trajectoryStore.listSessions({
          limit: 100,
        });
        const sessionCount = sessions.length;

        // Curate candidates from this session's stats
        const stats = buffer.getStats();
        const scorer = config.scorer ?? computeCurationScore;
        const candidates = curateTrajectorySummary(stats, sessionCount, {
          scorer,
          minScore: config.minCurationScore ?? DEFAULT_MIN_CURATION_SCORE,
          nowMs: clock(),
          lambda: config.recencyDecayLambda ?? DEFAULT_RECENCY_DECAY_LAMBDA,
        });

        // Always reset stats so the next session starts fresh
        buffer.resetStats();

        if (candidates.length > 0) {
          config.onCurate?.(candidates);

          // Consolidate into playbooks (use default consolidator when none provided)
          const consolidate = config.consolidate ?? createDefaultConsolidator({ clock });
          const existing = await config.playbookStore.list();
          const updated = consolidate(candidates, existing);
          for (const pb of updated) {
            await config.playbookStore.save(pb);
          }
        }
      } catch (e: unknown) {
        // Always reset stats even on failure to prevent stale state in next session
        buffer.resetStats();
        throw new Error(`ACE: onSessionEnd failed for session ${ctx.sessionId}`, { cause: e });
      }
    },
  };
}

function buildEnrichedRequest(
  request: ModelRequest,
  playbooks: readonly Playbook[],
  clock: () => number,
): ModelRequest {
  const text = playbooks.map((p) => `[Strategy: ${p.title}]\n${p.strategy}`).join("\n---\n");

  const playbookMessage: InboundMessage = {
    senderId: "system:ace",
    timestamp: clock(),
    content: [{ kind: "text", text: `[Active Playbooks]\n${text}` }],
  };

  return {
    ...request,
    messages: [playbookMessage, ...request.messages],
  };
}

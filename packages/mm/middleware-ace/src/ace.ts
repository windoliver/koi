/**
 * ACE middleware factory — Adaptive Continuous Enhancement.
 *
 * Records action/outcome trajectories per session, curates high-value patterns,
 * consolidates learnings into persistent playbooks, and auto-injects relevant
 * strategies into future sessions.
 *
 * Supports two pipelines:
 * - Stat-based (default): frequency x success rate x recency decay → EMA-blended playbooks
 * - LLM-powered (when reflector + curator configured): 3-agent loop with structured playbooks
 */

import type { InboundMessage } from "@koi/core/message";

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { estimateTokens } from "@koi/token-estimator";
import { trackAceStores } from "./ace-stores.js";
import type { AceConfig } from "./config.js";
import { selectPlaybooks, selectStructuredPlaybooks } from "./injector.js";
import { createLlmPipeline, createStatPipeline, isLlmPipelineEnabled } from "./pipeline.js";
import { extractCitedBulletIds, serializeForInjection } from "./playbook.js";
import { createTrajectoryBuffer } from "./trajectory-buffer.js";
import type { Playbook, StructuredPlaybook, TrajectoryEntry } from "./types.js";

const DEFAULT_MAX_INJECTION_TOKENS = 500;
const DEFAULT_MIN_PLAYBOOK_CONFIDENCE = 0.3;
const DEFAULT_MAX_BUFFER_ENTRIES = 1000;

/** Creates the ACE middleware instance. */
export function createAceMiddleware(config: AceConfig): KoiMiddleware {
  const clock = config.clock ?? Date.now;
  const buffer = createTrajectoryBuffer(config.maxBufferEntries ?? DEFAULT_MAX_BUFFER_ENTRIES);
  const llmEnabled = isLlmPipelineEnabled(config);
  const statPipeline = createStatPipeline(config);
  const llmPipeline = llmEnabled ? createLlmPipeline(config) : undefined;

  function recordEntry(entry: TrajectoryEntry): void {
    const evicted = buffer.record(entry);
    config.onRecord?.(entry);
    if (evicted > 0) {
      config.onBufferEvict?.(evicted);
    }
  }

  function recordOutcome(
    ctx: TurnContext,
    kind: TrajectoryEntry["kind"],
    identifier: string,
    startMs: number,
    outcome: TrajectoryEntry["outcome"],
    bulletIds?: readonly string[],
  ): void {
    recordEntry({
      turnIndex: ctx.turnIndex,
      timestamp: clock(),
      kind,
      identifier,
      outcome,
      durationMs: clock() - startMs,
      ...(bulletIds !== undefined && bulletIds.length > 0 ? { bulletIds } : {}),
    });
  }

  // let: mutable — updated after each playbook injection to reflect current count
  let activePlaybookCount = 0;

  // let: mutable — incremented on each tool call for forge nudge threshold
  let toolCallCount = 0;

  // Playbook cache (Decision #14): load once per session, clear on session end
  let cachedStatPlaybooks: readonly Playbook[] | undefined;
  let cachedStructuredPlaybooks: readonly StructuredPlaybook[] | undefined;

  /** Shared playbook loading + injection logic for both wrapModelCall and wrapModelStream. */
  async function enrichRequestWithPlaybooks(request: ModelRequest): Promise<ModelRequest> {
    // Load stat-based playbooks (cached per session)
    if (cachedStatPlaybooks === undefined) {
      const listOptions: {
        readonly tags?: readonly string[];
        readonly minConfidence?: number;
      } = {
        ...(config.playbookTags !== undefined ? { tags: config.playbookTags } : {}),
        minConfidence: config.minPlaybookConfidence ?? DEFAULT_MIN_PLAYBOOK_CONFIDENCE,
      };
      cachedStatPlaybooks = await config.playbookStore.list(listOptions);
    }

    // Load structured playbooks if LLM pipeline enabled
    if (
      llmEnabled &&
      cachedStructuredPlaybooks === undefined &&
      config.structuredPlaybookStore !== undefined
    ) {
      const tagOptions =
        config.playbookTags !== undefined ? { tags: config.playbookTags } : undefined;
      cachedStructuredPlaybooks = await config.structuredPlaybookStore.list(tagOptions);
    }

    // Select stat-based playbooks within token budget
    const totalBudget = config.maxInjectionTokens ?? DEFAULT_MAX_INJECTION_TOKENS;
    const selected = selectPlaybooks(cachedStatPlaybooks ?? [], {
      maxTokens: totalBudget,
      clock,
    });

    // Compute stat token usage, derive remaining budget for structured playbooks
    const statTokensUsed = selected.reduce((sum, pb) => sum + estimateTokens(pb.strategy), 0);
    const remainingBudget = totalBudget - statTokensUsed;
    const filteredStructured = await selectStructuredPlaybooks(
      cachedStructuredPlaybooks ?? [],
      remainingBudget,
    );

    // Build enriched request
    const enrichedRequest = buildEnrichedRequest(request, selected, filteredStructured, clock);

    const totalPlaybookCount = selected.length + filteredStructured.length;
    activePlaybookCount = totalPlaybookCount;

    if (selected.length > 0 || filteredStructured.length > 0) {
      config.onInject?.(selected);
    }

    return enrichedRequest;
  }

  const middleware: KoiMiddleware = {
    name: "ace",
    priority: 350,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment | undefined => {
      const nudgeInterval = config.forgeNudgeInterval ?? 15;
      const parts: string[] = [];
      if (activePlaybookCount > 0) {
        parts.push(`Active playbooks: ${activePlaybookCount}`);
      }
      if (
        config.forgeToolsAvailable === true &&
        toolCallCount >= nudgeInterval &&
        toolCallCount % nudgeInterval === 0
      ) {
        parts.push(
          "This task involved many steps. If you discovered a reusable " +
            "workflow, consider saving it as a skill with forge_skill.",
        );
      }
      if (parts.length === 0) return undefined;
      return {
        label: "playbooks",
        description: parts.join(". "),
      };
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const enrichedRequest = await enrichRequestWithPlaybooks(request);

      // Execute and record outcome
      const start = clock();
      try {
        const response = await next(enrichedRequest);

        // Extract cited bullet IDs from response content for credit assignment
        const responseText = typeof response.content === "string" ? response.content : "";
        const bulletIds = extractCitedBulletIds(responseText);

        recordOutcome(ctx, "model_call", response.model, start, "success", bulletIds);
        return response;
      } catch (e: unknown) {
        recordOutcome(ctx, "model_call", request.model ?? "unknown", start, "failure");
        throw e;
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const enrichedRequest = await enrichRequestWithPlaybooks(request);

      const start = clock();
      // let: accumulate response text from stream deltas for citation extraction
      let responseText = "";
      // let: track model name from done chunk
      let modelName = request.model ?? "unknown";
      // let: track whether we recorded the outcome (generator may be aborted early)
      let recorded = false;
      try {
        for await (const chunk of next(enrichedRequest)) {
          if (chunk.kind === "text_delta") {
            responseText += chunk.delta;
          }
          if (chunk.kind === "done") {
            const resp = (chunk as { readonly response?: ModelResponse }).response;
            if (resp !== undefined) {
              modelName = resp.model;
              if (typeof resp.content === "string") {
                responseText = resp.content;
              }
            }
            // Record outcome when done chunk arrives — the consumer may
            // abort the generator after this yield, so we can't defer
            // recording to after the loop.
            const bulletIds = extractCitedBulletIds(responseText);
            recordOutcome(ctx, "model_call", modelName, start, "success", bulletIds);
            recorded = true;
          }
          yield chunk;
        }

        // Fallback: record if loop completed without a done chunk
        if (!recorded) {
          const bulletIds = extractCitedBulletIds(responseText);
          recordOutcome(ctx, "model_call", modelName, start, "success", bulletIds);
        }
      } catch (e: unknown) {
        if (!recorded) {
          recordOutcome(ctx, "model_call", modelName, start, "failure");
        }
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
        recordOutcome(ctx, "tool_call", request.toolId, start, "success");
        toolCallCount++;
        return response;
      } catch (e: unknown) {
        recordOutcome(ctx, "tool_call", request.toolId, start, "failure");
        throw e;
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      toolCallCount = 0;

      // Clear playbook caches
      cachedStatPlaybooks = undefined;
      cachedStructuredPlaybooks = undefined;

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

        // Always run stat-based pipeline (fast, synchronous)
        await statPipeline.consolidate(entries, ctx.sessionId, sessionCount, clock, buffer);

        // Always reset stats so the next session starts fresh
        buffer.resetStats();

        // Fire-and-forget LLM pipeline if configured (Decision #13)
        if (llmPipeline !== undefined) {
          void llmPipeline
            .consolidate(entries, ctx.sessionId, sessionCount, clock, buffer)
            .then(() => {})
            .catch((e: unknown) => {
              config.onLlmPipelineError?.(e, ctx.sessionId);
            });
        }
      } catch (e: unknown) {
        // Always reset stats even on failure to prevent stale state in next session
        buffer.resetStats();
        throw new Error(`ACE: onSessionEnd failed for session ${ctx.sessionId}`, { cause: e });
      }
    },
  };

  // Track stores so L3 code (and any caller) can retrieve them via getAceStores().
  // This covers both direct createAceMiddleware() and descriptor factory paths.
  trackAceStores(middleware, {
    playbookStore: config.playbookStore,
    ...(config.structuredPlaybookStore !== undefined
      ? { structuredPlaybookStore: config.structuredPlaybookStore }
      : {}),
  });

  return middleware;
}

function buildEnrichedRequest(
  request: ModelRequest,
  statPlaybooks: readonly Playbook[],
  structuredPlaybooks: readonly StructuredPlaybook[],
  clock: () => number,
): ModelRequest {
  const parts: string[] = [];

  // Stat-based playbook strategies
  if (statPlaybooks.length > 0) {
    const statText = statPlaybooks
      .map((p) => `[Strategy: ${p.title}]\n${p.strategy}`)
      .join("\n---\n");
    parts.push(statText);
  }

  // Structured playbook bullets with citation IDs
  for (const sp of structuredPlaybooks) {
    const serialized = serializeForInjection(sp);
    if (serialized.length > 0) {
      parts.push(`[Structured: ${sp.title}]\n${serialized}`);
    }
  }

  if (parts.length === 0) return request;

  const playbookMessage: InboundMessage = {
    senderId: "system:ace",
    timestamp: clock(),
    content: [{ kind: "text", text: `[Active Playbooks]\n${parts.join("\n---\n")}` }],
  };

  return {
    ...request,
    messages: [playbookMessage, ...request.messages],
  };
}

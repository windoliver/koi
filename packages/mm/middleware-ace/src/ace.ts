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
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { trackAceStores } from "./ace-stores.js";
import type { AtifWriteBehindBuffer } from "./atif-buffer.js";
import { createAtifWriteBehindBuffer } from "./atif-buffer.js";
import type { AceConfig } from "./config.js";
import { selectPlaybooks, selectStructuredPlaybooks } from "./injector.js";
import type { ConsolidationPipeline } from "./pipeline.js";
import { createLlmPipeline, createStatPipeline, isLlmPipelineEnabled } from "./pipeline.js";
import { extractCitedBulletIds, serializeForInjection } from "./playbook.js";
import { createTrajectoryBuffer } from "./trajectory-buffer.js";
import type { Playbook, StructuredPlaybook, TrajectoryEntry } from "./types.js";

const DEFAULT_MAX_INJECTION_TOKENS = 500;
const DEFAULT_MIN_PLAYBOOK_CONFIDENCE = 0.3;
const DEFAULT_MAX_BUFFER_ENTRIES = 1000;

/** Default error handler for LLM pipeline failures — logs to console.warn. */
function defaultLlmPipelineErrorHandler(error: unknown, sessionId: string): void {
  console.warn(`ACE: LLM pipeline failed for session ${sessionId}`, error);
}

/** Handle for controlling ACE middleware from external code (e.g., ace_reflect tool). */
export interface AceMiddlewareHandle {
  /** The middleware instance. */
  readonly middleware: KoiMiddleware;
  /** Invalidate the cached structured playbooks, forcing a reload on the next model call. */
  readonly invalidatePlaybookCache: () => void;
  /** The ATIF write-behind buffer (for ace_reflect flush-before-read). */
  readonly atifBuffer: AtifWriteBehindBuffer | undefined;
  /** The LLM consolidation pipeline (for ace_reflect delta reflection). */
  readonly llmPipeline: ConsolidationPipeline | undefined;
  /** The compact trajectory buffer (for ace_reflect). */
  readonly trajectoryBuffer: import("./trajectory-buffer.js").TrajectoryBuffer;
  /** Get the current conversation/session ID for ATIF document lookups. */
  readonly getConversationId: () => string;
}

/** Creates the ACE middleware instance. */
export function createAceMiddleware(config: AceConfig): KoiMiddleware;
/** Creates the ACE middleware instance with a handle for external control. */
export function createAceMiddleware(
  config: AceConfig,
  options: { readonly withHandle: true },
): AceMiddlewareHandle;
export function createAceMiddleware(
  config: AceConfig,
  options?: { readonly withHandle: true },
): KoiMiddleware | AceMiddlewareHandle {
  const clock = config.clock ?? Date.now;
  const buffer = createTrajectoryBuffer(config.maxBufferEntries ?? DEFAULT_MAX_BUFFER_ENTRIES);
  const llmEnabled = isLlmPipelineEnabled(config);
  const statPipeline = createStatPipeline(config);
  const llmPipeline = llmEnabled ? createLlmPipeline(config) : undefined;

  // ATIF write-behind buffer for per-call rich trajectory recording
  const atifBuffer: AtifWriteBehindBuffer | undefined =
    config.atifStore !== undefined ? createAtifWriteBehindBuffer(config.atifStore) : undefined;

  // let: monotonically increasing step index for ATIF document
  let nextStepIndex = 0;

  // let: track the current conversation/session ID for ace_reflect
  let currentConversationId = "unknown";

  // Auto-reflection: trigger LLM pipeline every N model calls within a session
  const autoReflectInterval = config.autoReflectInterval ?? 5;
  // let: count model calls since last reflection
  let modelCallsSinceReflect = 0;
  // let: prevent concurrent auto-reflections
  let autoReflectInFlight = false;

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

  /** Update the tracked conversation ID from the current context. */
  function trackConversationId(ctx: TurnContext): void {
    currentConversationId = ctx.session.conversationId ?? ctx.session.sessionId;
  }

  /** Auto-trigger mid-session reflection after N model calls. Fire-and-forget. */
  function maybeAutoReflect(): void {
    if (llmPipeline === undefined || atifBuffer === undefined) return;
    modelCallsSinceReflect++;
    if (modelCallsSinceReflect < autoReflectInterval) return;
    if (autoReflectInFlight) return;

    autoReflectInFlight = true;
    modelCallsSinceReflect = 0;
    const docId = currentConversationId;
    const errorHandler = config.onLlmPipelineError ?? defaultLlmPipelineErrorHandler;

    void (async () => {
      try {
        // Flush ATIF buffer so rich trajectory is persisted for the reflector.
        // Do NOT flush the compact buffer — onSessionEnd needs those entries.
        await atifBuffer.flush(docId);
        // Pass empty entries — the LLM pipeline reads rich trajectory from ATIF store
        // via getStepRange (watermark-based delta). Compact entries are only for stat pipeline.
        await llmPipeline.consolidate([], docId, 1, clock, buffer);
        // Invalidate playbook cache so next model call picks up new bullets
        cachedStructuredPlaybooks = undefined;
      } catch (e: unknown) {
        errorHandler(e, docId);
      } finally {
        autoReflectInFlight = false;
      }
    })();
  }

  /** Record a rich trajectory step to the ATIF write-behind buffer. */
  function recordRichStep(
    ctx: TurnContext,
    kind: RichTrajectoryStep["kind"],
    identifier: string,
    startMs: number,
    outcome: RichTrajectoryStep["outcome"],
    request?: RichTrajectoryStep["request"],
    response?: RichTrajectoryStep["response"],
    error?: RichTrajectoryStep["error"],
    metrics?: RichTrajectoryStep["metrics"],
    bulletIds?: readonly string[],
  ): void {
    if (atifBuffer === undefined) return;

    const docId = ctx.session.conversationId ?? ctx.session.sessionId;
    const stepIndex = nextStepIndex++;
    const durationMs = clock() - startMs;

    const step: RichTrajectoryStep = {
      stepIndex,
      timestamp: clock(),
      source: kind === "model_call" ? "agent" : "tool",
      kind,
      identifier,
      outcome,
      durationMs,
      ...(request !== undefined ? { request } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
      ...(bulletIds !== undefined && bulletIds.length > 0 ? { bulletIds } : {}),
    };

    atifBuffer.append(docId, step);
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
    const totalBudget = config.maxInjectionTokens ?? DEFAULT_MAX_INJECTION_TOKENS;

    // When LLM pipeline is enabled, structured playbooks are the primary
    // learning output — stat playbooks are demoted (Decision #4: stat as fallback).
    if (llmEnabled && config.structuredPlaybookStore !== undefined) {
      // Load structured playbooks (cached per session)
      if (cachedStructuredPlaybooks === undefined) {
        const tagOptions =
          config.playbookTags !== undefined ? { tags: config.playbookTags } : undefined;
        cachedStructuredPlaybooks = await config.structuredPlaybookStore.list(tagOptions);
      }

      const filteredStructured = await selectStructuredPlaybooks(
        cachedStructuredPlaybooks ?? [],
        totalBudget,
      );

      const enrichedRequest = buildEnrichedRequest(request, [], filteredStructured, clock);
      activePlaybookCount = filteredStructured.length;
      return enrichedRequest;
    }

    // Fallback: stat-based playbooks only (no LLM pipeline)
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

    const selected = selectPlaybooks(cachedStatPlaybooks ?? [], {
      maxTokens: totalBudget,
      clock,
    });

    const enrichedRequest = buildEnrichedRequest(request, selected, [], clock);
    activePlaybookCount = selected.length;

    if (selected.length > 0) {
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
      trackConversationId(ctx);
      const enrichedRequest = await enrichRequestWithPlaybooks(request);

      // Execute and record outcome
      const start = clock();
      try {
        const response = await next(enrichedRequest);

        // Extract cited bullet IDs from response content for credit assignment
        const responseText = typeof response.content === "string" ? response.content : "";
        const bulletIds = extractCitedBulletIds(responseText);

        recordOutcome(ctx, "model_call", response.model, start, "success", bulletIds);

        // Record rich trajectory step to ATIF buffer
        // Capture all messages as request text for ATIF
        const reqText = request.messages
          .map((m) =>
            m.content
              .filter(
                (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
              )
              .map((b) => b.text)
              .join("\n"),
          )
          .filter((t) => t.length > 0)
          .join("\n---\n");
        recordRichStep(
          ctx,
          "model_call",
          response.model,
          start,
          "success",
          reqText.length > 0 ? { text: reqText } : undefined,
          responseText.length > 0 ? { text: responseText } : undefined,
          undefined,
          response.usage !== undefined
            ? {
                promptTokens: response.usage.inputTokens,
                completionTokens: response.usage.outputTokens,
              }
            : undefined,
          bulletIds,
        );

        maybeAutoReflect();
        return response;
      } catch (e: unknown) {
        recordOutcome(ctx, "model_call", request.model ?? "unknown", start, "failure");
        recordRichStep(
          ctx,
          "model_call",
          request.model ?? "unknown",
          start,
          "failure",
          undefined,
          undefined,
          { text: e instanceof Error ? e.message : String(e) },
        );
        throw e;
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      trackConversationId(ctx);
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

            // Record rich trajectory step for streaming model calls
            // Capture all user messages as request text for ATIF
            const requestText = request.messages
              .map((m) =>
                m.content
                  .filter(
                    (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
                  )
                  .map((b) => b.text)
                  .join("\n"),
              )
              .filter((t) => t.length > 0)
              .join("\n---\n");
            recordRichStep(
              ctx,
              "model_call",
              modelName,
              start,
              "success",
              requestText.length > 0 ? { text: requestText } : undefined,
              responseText.length > 0 ? { text: responseText } : undefined,
              undefined,
              resp?.usage !== undefined
                ? {
                    promptTokens: resp.usage.inputTokens,
                    completionTokens: resp.usage.outputTokens,
                  }
                : undefined,
              bulletIds,
            );

            maybeAutoReflect();
            recorded = true;
          }
          yield chunk;
        }

        // Fallback: record if loop completed without a done chunk
        if (!recorded) {
          const bulletIds = extractCitedBulletIds(responseText);
          recordOutcome(ctx, "model_call", modelName, start, "success", bulletIds);
          recordRichStep(
            ctx,
            "model_call",
            modelName,
            start,
            "success",
            undefined,
            responseText.length > 0 ? { text: responseText } : undefined,
          );
        }
      } catch (e: unknown) {
        if (!recorded) {
          recordOutcome(ctx, "model_call", modelName, start, "failure");
          recordRichStep(
            ctx,
            "model_call",
            request.model ?? "unknown",
            start,
            "failure",
            undefined,
            undefined,
            { text: e instanceof Error ? e.message : String(e) },
          );
        }
        throw e;
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      trackConversationId(ctx);
      const start = clock();
      try {
        const response = await next(request);
        recordOutcome(ctx, "tool_call", request.toolId, start, "success");
        toolCallCount++;

        // Record rich trajectory step to ATIF buffer
        const responseText = typeof response.output === "string" ? response.output : undefined;
        recordRichStep(
          ctx,
          "tool_call",
          request.toolId,
          start,
          "success",
          { data: request.input },
          responseText !== undefined ? { text: responseText } : undefined,
        );

        return response;
      } catch (e: unknown) {
        recordOutcome(ctx, "tool_call", request.toolId, start, "failure");
        recordRichStep(
          ctx,
          "tool_call",
          request.toolId,
          start,
          "failure",
          { data: request.input },
          undefined,
          { text: e instanceof Error ? e.message : String(e) },
        );
        throw e;
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      toolCallCount = 0;
      modelCallsSinceReflect = 0;

      // Clear playbook caches
      cachedStatPlaybooks = undefined;
      cachedStructuredPlaybooks = undefined;

      // Flush ATIF write-behind buffer before reflection reads
      if (atifBuffer !== undefined) {
        const docId = ctx.conversationId ?? ctx.sessionId;
        await atifBuffer.flush(docId);
      }

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
        // Use conversationId as the document key so the pipeline reads
        // from the same ATIF document that per-call recording writes to.
        if (llmPipeline !== undefined) {
          const atifDocId = ctx.conversationId ?? ctx.sessionId;
          const errorHandler = config.onLlmPipelineError ?? defaultLlmPipelineErrorHandler;
          void llmPipeline
            .consolidate(entries, atifDocId, sessionCount, clock, buffer)
            .catch((e: unknown) => {
              errorHandler(e, atifDocId);
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

  if (options?.withHandle === true) {
    return {
      middleware,
      invalidatePlaybookCache(): void {
        cachedStructuredPlaybooks = undefined;
      },
      atifBuffer,
      llmPipeline,
      trajectoryBuffer: buffer,
      getConversationId: () => currentConversationId,
    };
  }

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

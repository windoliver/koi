/**
 * Collective memory middleware — accumulates cross-run learnings from spawn results
 * and injects relevant learnings into model calls.
 *
 * Write path (wrapToolCall): extracts learnings from spawn-family tool outputs,
 *   deduplicates against existing entries, persists to ForgeStore.
 * Read path (wrapModelCall): loads brick's collective memory on first call,
 *   selects entries within budget, prepends as system message.
 */

import type {
  BrickArtifact,
  BrickId,
  CollectiveMemory,
  CollectiveMemoryEntry,
  InboundMessage,
  KoiMiddleware,
  Result,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { COLLECTIVE_MEMORY_DEFAULTS, DEFAULT_COLLECTIVE_MEMORY } from "@koi/core";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";
import { deduplicateEntries, selectEntriesWithinBudget } from "@koi/validation";
import { compactCollectiveMemory, shouldCompact } from "./compact.js";
import { createDefaultExtractor } from "./extract-learnings.js";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
import { formatCollectiveMemory } from "./inject.js";
import type { CollectiveMemoryMiddlewareConfig } from "./types.js";

/** Tool IDs that represent spawn-family operations. */
const SPAWN_TOOL_IDS = new Set(["task", "parallel_task", "delegate"]);

/** Maximum number of outputs to accumulate per session for LLM extraction. */
const MAX_SESSION_OUTPUTS = 20;

/** Extracts a string representation of the tool output for learning extraction. */
function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output !== null && output !== undefined) {
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return "";
}

/** Generates a unique entry ID using timestamp + random suffix. */
function generateEntryId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cm_${ts}_${rand}`;
}

/**
 * Creates the collective memory middleware.
 *
 * Priority 305: after context hydrator (300), before hot-memory (310).
 */
export function createCollectiveMemoryMiddleware(
  config: CollectiveMemoryMiddlewareConfig,
): KoiMiddleware {
  const extractor = config.extractor ?? createDefaultExtractor();
  const maxEntries = config.maxEntries ?? COLLECTIVE_MEMORY_DEFAULTS.maxEntries;
  const maxTokens = config.maxTokens ?? COLLECTIVE_MEMORY_DEFAULTS.maxTokens;
  const coldAgeDays = config.coldAgeDays ?? COLLECTIVE_MEMORY_DEFAULTS.coldAgeDays;
  const injectionBudget = config.injectionBudget ?? COLLECTIVE_MEMORY_DEFAULTS.injectionBudget;
  const dedupThreshold = config.dedupThreshold ?? COLLECTIVE_MEMORY_DEFAULTS.dedupThreshold;
  const autoCompact = config.autoCompact ?? true;

  // let justified: one-shot injection flag — only inject on first model call per session
  let injected = false;
  // let justified: accumulates spawn tool outputs for post-session LLM extraction
  let sessionOutputs: readonly string[] = [];

  return {
    name: "koi:collective-memory",
    priority: 305,

    describeCapabilities() {
      return {
        label: "collective-memory",
        description: "Injects cross-run learnings from collective memory into agent context",
      };
    },

    async onSessionStart() {
      injected = false;
      sessionOutputs = [];
    },

    async onSessionEnd(ctx) {
      injected = false;

      // Skip if no model call or no accumulated outputs
      if (config.modelCall === undefined || sessionOutputs.length === 0) {
        sessionOutputs = [];
        return;
      }

      const outputs = sessionOutputs;
      sessionOutputs = []; // Reset before async work

      try {
        const prompt = createExtractionPrompt(outputs);

        const response = await config.modelCall({
          messages: [
            {
              content: [{ kind: "text", text: prompt }],
              senderId: "system:collective-memory",
              timestamp: Date.now(),
            },
          ],
          ...(config.extractionModel !== undefined ? { model: config.extractionModel } : {}),
          maxTokens: config.extractionMaxTokens ?? 1024,
        });

        const candidates = parseExtractionResponse(response.content);
        if (candidates.length === 0) return;

        const brickIdStr = config.resolveBrickId(ctx.agentId);
        if (brickIdStr === undefined) return;

        await persistLearnings(brickIdStr as BrickId, candidates, ctx.agentId, ctx.runId);
      } catch (_e: unknown) {
        // Fire-and-forget: don't fail session cleanup on extraction error
      }
    },

    async wrapToolCall(ctx, request: ToolRequest, next) {
      const response: ToolResponse = await next(request);

      // Only intercept spawn-family tools
      if (!SPAWN_TOOL_IDS.has(request.toolId)) {
        return response;
      }

      const outputStr = outputToString(response.output);
      if (outputStr.length === 0) {
        return response;
      }

      // Accumulate output for post-session LLM extraction (capped to prevent unbounded growth)
      if (config.modelCall !== undefined && sessionOutputs.length < MAX_SESSION_OUTPUTS) {
        sessionOutputs = [...sessionOutputs, outputStr];
      }

      // Extract learnings (regex-based, real-time)
      const candidates = extractor.extract(outputStr);
      if (candidates.length === 0) {
        return response;
      }

      // Resolve brick for this agent type
      const agentName =
        typeof request.input.agentName === "string" ? request.input.agentName : ctx.session.agentId;
      const brickIdStr = config.resolveBrickId(agentName);
      if (brickIdStr === undefined) {
        return response;
      }

      try {
        await persistLearnings(
          brickIdStr as BrickId,
          candidates,
          ctx.session.agentId,
          ctx.session.runId,
        );
      } catch {
        // Fire-and-forget: don't break the tool call chain on persistence failure
      }

      return response;
    },

    async wrapModelCall(ctx, request, next) {
      if (injected) {
        return next(request);
      }
      injected = true;

      // Load brick for this agent
      const brickIdStr = config.resolveBrickId(ctx.session.agentId);
      if (brickIdStr === undefined) {
        return next(request);
      }

      try {
        const loadResult: Result<BrickArtifact, unknown> = await config.forgeStore.load(
          brickIdStr as BrickId,
        );
        if (!loadResult.ok) {
          return next(request);
        }
        const memory: CollectiveMemory =
          loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
        if (memory.entries.length === 0) {
          return next(request);
        }

        const selected = selectEntriesWithinBudget(
          memory.entries,
          injectionBudget,
          CHARS_PER_TOKEN,
        );
        if (selected.length === 0) {
          return next(request);
        }

        const formatted = formatCollectiveMemory(memory.entries, injectionBudget, CHARS_PER_TOKEN);
        if (formatted.length === 0) {
          return next(request);
        }

        // Fire-and-forget: increment accessCount only on entries that were actually injected
        const injectedIds: ReadonlySet<string> = new Set(selected.map((e) => e.id));
        incrementAccessCounts(brickIdStr as BrickId, memory, injectedIds).catch(() => {
          // Swallow — observability only
        });

        const systemMessage: InboundMessage = {
          content: [{ kind: "text", text: formatted }],
          senderId: "system:collective-memory",
          timestamp: Date.now(),
        };

        return next({
          ...request,
          messages: [systemMessage, ...request.messages],
        });
      } catch {
        // Don't break model calls on memory load failure
        return next(request);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async function persistLearnings(
    brickId: BrickId,
    candidates: readonly { readonly content: string; readonly category: string }[],
    agentId: string,
    runId: string,
  ): Promise<void> {
    const loadResult = await config.forgeStore.load(brickId);
    if (!loadResult.ok) return;

    const existing: CollectiveMemory =
      loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
    const nowMs = Date.now();

    // Create new entries from candidates
    const newEntries: readonly CollectiveMemoryEntry[] = candidates.map((c) => ({
      id: generateEntryId(),
      content: c.content,
      category: c.category as CollectiveMemoryEntry["category"],
      source: { agentId, runId, timestamp: nowMs },
      createdAt: nowMs,
      accessCount: 0,
      lastAccessedAt: nowMs,
    }));

    // Merge + dedup
    const merged = [...existing.entries, ...newEntries];
    const deduped = deduplicateEntries(merged, dedupThreshold, nowMs);

    const totalTokens = deduped.reduce(
      (sum, e) => sum + Math.ceil(e.content.length / CHARS_PER_TOKEN),
      0,
    );

    // let justified: mutable for conditional compaction
    let updated: CollectiveMemory = {
      entries: deduped,
      totalTokens,
      generation: existing.generation,
      lastCompactedAt: existing.lastCompactedAt,
    };

    // Auto-compact if thresholds exceeded
    if (autoCompact && shouldCompact(updated, maxEntries, maxTokens)) {
      updated = compactCollectiveMemory(updated, {
        maxEntries,
        maxTokens,
        coldAgeDays,
        dedupThreshold,
      });
    }

    // Persist — retry once on generation mismatch
    const updateResult = await config.forgeStore.update(brickId, {
      collectiveMemory: updated,
    });
    if (!updateResult.ok && updateResult.error !== undefined) {
      // One retry attempt on conflict
      const retryLoad = await config.forgeStore.load(brickId);
      if (retryLoad.ok) {
        const freshMemory = retryLoad.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
        const reMerged = [...freshMemory.entries, ...newEntries];
        const reDeduped = deduplicateEntries(reMerged, dedupThreshold, nowMs);
        const reTokens = reDeduped.reduce(
          (sum, e) => sum + Math.ceil(e.content.length / CHARS_PER_TOKEN),
          0,
        );
        await config.forgeStore.update(brickId, {
          collectiveMemory: {
            entries: reDeduped,
            totalTokens: reTokens,
            generation: freshMemory.generation,
            lastCompactedAt: freshMemory.lastCompactedAt,
          },
        });
      }
    }
  }

  async function incrementAccessCounts(
    brickId: BrickId,
    memory: CollectiveMemory,
    injectedIds: ReadonlySet<string>,
  ): Promise<void> {
    const nowMs = Date.now();
    const updatedEntries = memory.entries.map((e) =>
      injectedIds.has(e.id) ? { ...e, accessCount: e.accessCount + 1, lastAccessedAt: nowMs } : e,
    );
    await config.forgeStore.update(brickId, {
      collectiveMemory: {
        ...memory,
        entries: updatedEntries,
      },
    });
  }
}

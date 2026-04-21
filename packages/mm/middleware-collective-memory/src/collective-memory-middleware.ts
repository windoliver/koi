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
  TurnContext,
} from "@koi/core";
import { brickId, COLLECTIVE_MEMORY_DEFAULTS, DEFAULT_COLLECTIVE_MEMORY } from "@koi/core";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";
import { deduplicateEntries, selectEntriesWithinBudget } from "@koi/validation";
import { compactCollectiveMemory, shouldCompact } from "./compact.js";
import { createDefaultExtractor } from "./extract-learnings.js";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
import { formatCollectiveMemory } from "./inject.js";
import type { CollectiveMemoryMiddlewareConfig } from "./types.js";

const SPAWN_TOOL_IDS = new Set(["task", "parallel_task", "delegate"]);
const MAX_SESSION_OUTPUTS = 20;

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

function generateEntryId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cm_${ts}_${rand}`;
}

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

    describeCapabilities(_ctx: TurnContext): {
      readonly label: string;
      readonly description: string;
    } {
      return {
        label: "collective-memory",
        description: "Injects cross-run learnings from collective memory into agent context",
      };
    },

    async onSessionStart(): Promise<void> {
      injected = false;
      sessionOutputs = [];
    },

    async onSessionEnd(ctx): Promise<void> {
      injected = false;

      if (config.modelCall === undefined || sessionOutputs.length === 0) {
        sessionOutputs = [];
        return;
      }

      const outputs = sessionOutputs;
      sessionOutputs = [];

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

        const rawId = config.resolveBrickId(ctx.agentId);
        if (rawId === undefined) return;

        await persistLearnings(brickId(rawId), candidates, ctx.agentId, ctx.runId);
      } catch (_e: unknown) {
        // Fire-and-forget: don't fail session cleanup on extraction error
      }
    },

    async wrapToolCall(ctx, request: ToolRequest, next): Promise<ToolResponse> {
      const response: ToolResponse = await next(request);

      if (!SPAWN_TOOL_IDS.has(request.toolId)) return response;

      const outputStr = outputToString(response.output);
      if (outputStr.length === 0) return response;

      if (config.modelCall !== undefined && sessionOutputs.length < MAX_SESSION_OUTPUTS) {
        sessionOutputs = [...sessionOutputs, outputStr];
      }

      const candidates = extractor.extract(outputStr);
      if (candidates.length === 0) return response;

      const agentNameRaw = request.input.agentName;
      const agentName = typeof agentNameRaw === "string" ? agentNameRaw : ctx.session.agentId;
      const rawId = config.resolveBrickId(agentName);
      if (rawId === undefined) return response;

      try {
        await persistLearnings(brickId(rawId), candidates, ctx.session.agentId, ctx.session.runId);
      } catch {
        // Fire-and-forget: don't break tool call chain on persistence failure
      }

      return response;
    },

    async wrapModelCall(ctx, request, next) {
      if (injected) return next(request);
      injected = true;

      const rawId = config.resolveBrickId(ctx.session.agentId);
      if (rawId === undefined) return next(request);

      try {
        const brick: BrickId = brickId(rawId);
        const loadResult: Result<BrickArtifact, unknown> = await config.forgeStore.load(brick);
        if (!loadResult.ok) return next(request);

        const memory: CollectiveMemory =
          loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
        if (memory.entries.length === 0) return next(request);

        const selected = selectEntriesWithinBudget(
          memory.entries,
          injectionBudget,
          CHARS_PER_TOKEN,
        );
        if (selected.length === 0) return next(request);

        const formatted = formatCollectiveMemory(memory.entries, injectionBudget, CHARS_PER_TOKEN);
        if (formatted.length === 0) return next(request);

        const injectedIds: ReadonlySet<string> = new Set(selected.map((e) => e.id));
        incrementAccessCounts(brick, memory, injectedIds).catch(() => {
          // Swallow — observability only
        });

        const systemMessage: InboundMessage = {
          content: [{ kind: "text", text: formatted }],
          senderId: "system:collective-memory",
          timestamp: Date.now(),
        };

        return next({ ...request, messages: [systemMessage, ...request.messages] });
      } catch {
        return next(request);
      }
    },
  };

  async function persistLearnings(
    brick: BrickId,
    candidates: readonly { readonly content: string; readonly category: string }[],
    agentId: string,
    runId: string,
  ): Promise<void> {
    const loadResult = await config.forgeStore.load(brick);
    if (!loadResult.ok) return;

    const existing: CollectiveMemory =
      loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
    const nowMs = Date.now();

    const newEntries: readonly CollectiveMemoryEntry[] = candidates.map((c) => ({
      id: generateEntryId(),
      content: c.content,
      category: c.category as CollectiveMemoryEntry["category"],
      source: { agentId, runId, timestamp: nowMs },
      createdAt: nowMs,
      accessCount: 0,
      lastAccessedAt: nowMs,
    }));

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

    if (autoCompact && shouldCompact(updated, maxEntries, maxTokens)) {
      updated = compactCollectiveMemory(updated, {
        maxEntries,
        maxTokens,
        coldAgeDays,
        dedupThreshold,
      });
    }

    const updateResult = await config.forgeStore.update(brick, { collectiveMemory: updated });

    // Retry once on generation conflict
    if (!updateResult.ok && updateResult.error !== undefined) {
      const retryLoad = await config.forgeStore.load(brick);
      if (retryLoad.ok) {
        const fresh = retryLoad.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
        const reMerged = [...fresh.entries, ...newEntries];
        const reDeduped = deduplicateEntries(reMerged, dedupThreshold, nowMs);
        const reTokens = reDeduped.reduce(
          (sum, e) => sum + Math.ceil(e.content.length / CHARS_PER_TOKEN),
          0,
        );
        await config.forgeStore.update(brick, {
          collectiveMemory: {
            entries: reDeduped,
            totalTokens: reTokens,
            generation: fresh.generation,
            lastCompactedAt: fresh.lastCompactedAt,
          },
        });
      }
    }
  }

  async function incrementAccessCounts(
    brick: BrickId,
    memory: CollectiveMemory,
    injectedIds: ReadonlySet<string>,
  ): Promise<void> {
    const nowMs = Date.now();
    const updatedEntries = memory.entries.map((e) =>
      injectedIds.has(e.id) ? { ...e, accessCount: e.accessCount + 1, lastAccessedAt: nowMs } : e,
    );
    await config.forgeStore.update(brick, {
      collectiveMemory: { ...memory, entries: updatedEntries },
    });
  }
}

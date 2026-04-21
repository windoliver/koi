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
import { createAllSecretPatterns, createRedactor } from "@koi/redaction";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";
import { deduplicateEntries, selectEntriesWithinBudget } from "@koi/validation";
import { compactCollectiveMemory, shouldCompact } from "./compact.js";
import { createDefaultExtractor } from "./extract-learnings.js";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
import { formatCollectiveMemory } from "./inject.js";
import type { CollectiveMemoryMiddlewareConfig } from "./types.js";

// Default spawn tool IDs matching the engine-compose runtime.
// Callers can override via config.spawnToolIds.
const DEFAULT_SPAWN_TOOL_IDS: readonly string[] = ["forge_agent", "Spawn"];
const MAX_SESSION_OUTPUTS = 20;
// Truncate worker output before persisting to bound memory usage.
const MAX_OUTPUT_BYTES = 8_192;

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

// Lazily initialized centralized redactor — compiled once, reused across calls.
// let justified: lazy singleton to avoid compiling patterns on module load
let _redactor: ReturnType<typeof createRedactor> | undefined;

function getRedactor(): ReturnType<typeof createRedactor> {
  if (_redactor === undefined) {
    _redactor = createRedactor({ patterns: createAllSecretPatterns() });
  }
  return _redactor;
}

function sanitizeOutput(text: string): string {
  const truncated = text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) : text;
  const { text: redacted } = getRedactor().redactString(truncated);
  // Escape untrusted-data boundary tokens to prevent injection breakout.
  return redacted
    .replaceAll("</untrusted-data>", "&lt;/untrusted-data&gt;")
    .replaceAll("<untrusted-data>", "&lt;untrusted-data&gt;");
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
  const spawnToolIds = new Set<string>(config.spawnToolIds ?? DEFAULT_SPAWN_TOOL_IDS);

  // outputs is a mutable array ref so concurrent push() calls in the same session
  // don't race: JS is single-threaded, so push on a shared ref is atomic.
  type SessionState = { injected: boolean; outputs: string[] };
  // Per-session state keyed by sessionId — prevents concurrent sessions from
  // clobbering each other's injection flag or buffered outputs.
  const sessions = new Map<string, SessionState>();

  function getSession(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh: SessionState = { injected: false, outputs: [] };
    sessions.set(sessionId, fresh);
    return fresh;
  }

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

    async onSessionStart(ctx): Promise<void> {
      sessions.set(ctx.sessionId, { injected: false, outputs: [] as string[] });
    },

    async onSessionEnd(ctx): Promise<void> {
      const state = sessions.get(ctx.sessionId);
      sessions.delete(ctx.sessionId);

      if (config.modelCall === undefined || state === undefined || state.outputs.length === 0) {
        return;
      }

      const outputs = state.outputs;

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

      if (!spawnToolIds.has(request.toolId)) return response;

      const outputStr = sanitizeOutput(outputToString(response.output));
      if (outputStr.length === 0) return response;

      const state = getSession(ctx.session.sessionId);
      if (config.modelCall !== undefined && state.outputs.length < MAX_SESSION_OUTPUTS) {
        // Mutate the shared array ref — safe in single-threaded JS;
        // avoids the read-spread-write race with concurrent spawn completions.
        state.outputs.push(outputStr);
      }

      const candidates = extractor.extract(outputStr);
      if (candidates.length === 0) return response;

      // Always write to the current (parent) agent's brick — never trust caller-supplied
      // agentName to select a persistence target, as that string is model-controlled.
      const rawId = config.resolveBrickId(ctx.session.agentId);
      if (rawId === undefined) return response;

      try {
        await persistLearnings(brickId(rawId), candidates, ctx.session.agentId, ctx.session.runId);
      } catch {
        // Fire-and-forget: don't break tool call chain on persistence failure
      }

      return response;
    },

    async wrapModelCall(ctx, request, next) {
      const state = getSession(ctx.session.sessionId);
      if (state.injected) return next(request);
      sessions.set(ctx.session.sessionId, { ...state, injected: true });

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
        incrementAccessCounts(brick, injectedIds).catch(() => {
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

    // Retry loop: re-read on CAS conflict so concurrent writers converge without data loss.
    for (let attempt = 0; attempt < 3; attempt++) {
      const loadResult = await config.forgeStore.load(brick);
      if (!loadResult.ok) return;

      const existing: CollectiveMemory =
        loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
      const storeVersion = loadResult.value.storeVersion;

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

      const updateResult = await config.forgeStore.update(brick, {
        collectiveMemory: updated,
        ...(storeVersion !== undefined ? { expectedVersion: storeVersion } : {}),
      });

      if (updateResult.ok) return;
      // On conflict (CONFLICT error) retry with a fresh load; on other errors bail.
      const errCode = (updateResult.error as { code?: string } | undefined)?.code;
      if (errCode !== "CONFLICT") return;
    }
  }

  async function incrementAccessCounts(
    brick: BrickId,
    injectedIds: ReadonlySet<string>,
  ): Promise<void> {
    // Reload to avoid overwriting entries written by concurrent wrapToolCall calls.
    for (let attempt = 0; attempt < 3; attempt++) {
      const loadResult = await config.forgeStore.load(brick);
      if (!loadResult.ok) return;

      const memory: CollectiveMemory =
        loadResult.value.collectiveMemory ?? DEFAULT_COLLECTIVE_MEMORY;
      const storeVersion = loadResult.value.storeVersion;
      const nowMs = Date.now();

      const updatedEntries = memory.entries.map((e) =>
        injectedIds.has(e.id) ? { ...e, accessCount: e.accessCount + 1, lastAccessedAt: nowMs } : e,
      );

      const updateResult = await config.forgeStore.update(brick, {
        collectiveMemory: { ...memory, entries: updatedEntries },
        ...(storeVersion !== undefined ? { expectedVersion: storeVersion } : {}),
      });

      if (updateResult.ok) return;
      const errCode = (updateResult.error as { code?: string } | undefined)?.code;
      if (errCode !== "CONFLICT") return;
    }
  }
}

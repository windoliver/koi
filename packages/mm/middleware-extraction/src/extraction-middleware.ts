/**
 * Extraction middleware — extracts reusable learnings from spawn-family tool outputs
 * and persists them as MemoryRecord entries.
 *
 * Write path only. Does NOT inject memories into model calls — that is handled by
 * middleware-hot-memory (priority 310). After writes, calls hotMemory.notifyStoreOccurred()
 * to invalidate the hot-memory cache.
 *
 * Priority 305: after context hydrator (300), before hot-memory (310).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  SessionContext,
  SessionId,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
import { createDefaultExtractor } from "./extract-regex.js";
import type { ExtractionCandidate, ExtractionMiddlewareConfig } from "./types.js";
import { EXTRACTION_DEFAULTS } from "./types.js";

/** Default tool IDs that represent spawn-family operations in the Koi runtime. */
const DEFAULT_spawnToolIds: readonly string[] = ["Spawn", "agent_spawn", "task_delegate"];

/** Converts tool output to string for extraction. */
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

/**
 * Creates the extraction middleware.
 *
 * Session lifecycle:
 * - onSessionStart: initializes per-session state (output accumulator)
 * - wrapToolCall: intercepts spawn-family tools, extracts via regex, accumulates for LLM
 * - onSessionEnd: runs LLM extraction over accumulated outputs, cleans up state
 *
 * State is keyed by SessionId to prevent cross-session bleed under concurrency.
 */
export function createExtractionMiddleware(config: ExtractionMiddlewareConfig): KoiMiddleware {
  const extractor = config.extractor ?? createDefaultExtractor();
  const maxSessionOutputs = config.maxSessionOutputs ?? EXTRACTION_DEFAULTS.maxSessionOutputs;
  const maxOutputSizeBytes = config.maxOutputSizeBytes ?? EXTRACTION_DEFAULTS.maxOutputSizeBytes;
  const extractionMaxTokens = config.extractionMaxTokens ?? EXTRACTION_DEFAULTS.extractionMaxTokens;
  const spawnToolIds = new Set(config.spawnToolIds ?? DEFAULT_spawnToolIds);

  // Per-session output accumulator — keyed by SessionId to prevent cross-session bleed.
  const sessionOutputsMap = new Map<SessionId, string[]>();

  /**
   * Persists a batch of extraction candidates to memory.
   *
   * Candidates mapped to MemoryType "user" (e.g., preference learnings) are
   * excluded because MemoryComponent.store() does not support specifying the
   * storage type. Storing them without "user" type would allow them to bypass
   * team-sync type guards that block "user" memories from leaving the local store.
   */
  async function persistCandidates(candidates: readonly ExtractionCandidate[]): Promise<void> {
    // let justified: mutable flag tracking whether any store succeeded
    let stored = false;

    for (const candidate of candidates) {
      // Skip candidates that require "user" type isolation — MemoryComponent.store()
      // cannot set the record type, so these would be stored without the correct
      // privacy boundary and could leak through team sync.
      if (candidate.memoryType === "user") {
        continue;
      }

      try {
        await config.memory.store(candidate.content, {
          category: candidate.category,
        });
        stored = true;
      } catch (_e: unknown) {
        // Fire-and-forget: don't fail the tool call chain on persistence failure
      }
    }

    // Notify hot-memory to invalidate cache after successful writes
    if (stored && config.hotMemory !== undefined) {
      config.hotMemory.notifyStoreOccurred();
    }
  }

  return {
    name: "koi:extraction",
    priority: 305,

    describeCapabilities(): CapabilityFragment | undefined {
      return {
        label: "extraction",
        description: "Extracts reusable learnings from agent tool outputs into persistent memory",
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessionOutputsMap.set(ctx.sessionId, []);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const outputs = sessionOutputsMap.get(ctx.sessionId) ?? [];
      sessionOutputsMap.delete(ctx.sessionId); // Clean up before async work

      // Skip LLM extraction if no model call or no accumulated outputs
      if (config.modelCall === undefined || outputs.length === 0) {
        return;
      }

      try {
        const prompt = createExtractionPrompt(outputs, maxOutputSizeBytes);

        const response = await config.modelCall({
          messages: [
            {
              content: [{ kind: "text", text: prompt }],
              senderId: "system:extraction",
              timestamp: Date.now(),
            },
          ],
          ...(config.extractionModel !== undefined ? { model: config.extractionModel } : {}),
          maxTokens: extractionMaxTokens,
        });

        const candidates = parseExtractionResponse(response.content);
        if (candidates.length > 0) {
          await persistCandidates(candidates);
        }
      } catch (_e: unknown) {
        // Fire-and-forget: don't fail session cleanup on extraction error
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      const response: ToolResponse = await next(request);

      // Only intercept spawn-family tools
      if (!spawnToolIds.has(request.toolId)) {
        return response;
      }

      const outputStr = outputToString(response.output);
      if (outputStr.length === 0) {
        return response;
      }

      // Accumulate output for post-session LLM extraction (bounded, per-session)
      const sessionId = ctx.session.sessionId;
      const outputs = sessionOutputsMap.get(sessionId);
      if (
        config.modelCall !== undefined &&
        outputs !== undefined &&
        outputs.length < maxSessionOutputs
      ) {
        sessionOutputsMap.set(sessionId, [...outputs, outputStr]);
      }

      // Extract learnings via regex (real-time)
      const candidates = extractor.extract(outputStr);
      if (candidates.length > 0) {
        // Fire-and-forget — don't block the tool call chain
        persistCandidates(candidates).catch(() => {
          // Swallow — extraction failures are non-critical
        });
      }

      return response;
    },
  };
}

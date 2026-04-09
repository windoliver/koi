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
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
import { createDefaultExtractor } from "./extract-regex.js";
import type { ExtractionCandidate, ExtractionMiddlewareConfig } from "./types.js";
import { EXTRACTION_DEFAULTS } from "./types.js";

/** Tool IDs that represent spawn-family operations. */
const SPAWN_TOOL_IDS = new Set(["task", "parallel_task", "delegate"]);

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
 * - onSessionStart: initializes session state (output accumulator)
 * - wrapToolCall: intercepts spawn-family tools, extracts via regex, accumulates for LLM
 * - onSessionEnd: runs LLM extraction over accumulated outputs, cleans up state
 */
export function createExtractionMiddleware(config: ExtractionMiddlewareConfig): KoiMiddleware {
  const extractor = config.extractor ?? createDefaultExtractor();
  const maxSessionOutputs = config.maxSessionOutputs ?? EXTRACTION_DEFAULTS.maxSessionOutputs;
  const maxOutputSizeBytes = config.maxOutputSizeBytes ?? EXTRACTION_DEFAULTS.maxOutputSizeBytes;
  const extractionMaxTokens = config.extractionMaxTokens ?? EXTRACTION_DEFAULTS.extractionMaxTokens;

  // Session-scoped state — initialized in onSessionStart, cleaned in onSessionEnd.
  // let justified: mutable session state for output accumulation across tool calls
  let sessionOutputs: string[] = [];

  /** Persists a batch of extraction candidates to memory. */
  async function persistCandidates(candidates: readonly ExtractionCandidate[]): Promise<void> {
    // let justified: mutable flag tracking whether any store succeeded
    let stored = false;

    for (const candidate of candidates) {
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

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      sessionOutputs = [];
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      const outputs = sessionOutputs;
      sessionOutputs = []; // Clean up before async work

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
      _ctx: TurnContext,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      const response: ToolResponse = await next(request);

      // Only intercept spawn-family tools
      if (!SPAWN_TOOL_IDS.has(request.toolId)) {
        return response;
      }

      const outputStr = outputToString(response.output);
      if (outputStr.length === 0) {
        return response;
      }

      // Accumulate output for post-session LLM extraction (bounded)
      if (config.modelCall !== undefined && sessionOutputs.length < maxSessionOutputs) {
        sessionOutputs = [...sessionOutputs, outputStr];
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

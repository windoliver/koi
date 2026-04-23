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
import { countSecrets } from "./sanitize.js";
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
 * Trusted output field names for spawn-family tool results.
 *
 * Allowlist approach: only fields whose values are model-authored output are
 * descended into. This prevents poisoning via echoed request text in fields
 * like `request`, `input`, `task` (task_delegate subject), `metadata`, as well
 * as raw command streams (`stdout`/`stderr`) which can contain arbitrary
 * subprocess output, echoed user input, or stack traces.
 *
 * Convention: spawn agents that produce extractable learnings should place
 * their output in one of these standard field names.
 */
const OUTPUT_FIELD_NAMES = new Set([
  "result",
  "output",
  "text",
  "message",
  "content",
  "response",
  "summary",
]);

/**
 * Returns true when `val` is a typed command-result envelope: an object with
 * both `stdout` (string) and `exitCode` (number). This is the shape produced
 * by Bash/command tools and serialized by `createTextCollector` when a
 * tool-only child agent ends on a tool call rather than text output.
 *
 * Using a structural type check (not just presence of `stdout`) prevents
 * arbitrary JSON objects that happen to have a `stdout` key from triggering
 * the extraction path.
 */
function isCommandResultEnvelope(
  val: unknown,
): val is { readonly stdout: string; readonly exitCode: number } {
  if (typeof val !== "object" || val === null) return false;
  const record = val as Record<string, unknown>;
  return typeof record.stdout === "string" && typeof record.exitCode === "number";
}

/**
 * Extracts strings from a parsed JSON value, restricting object traversal to
 * OUTPUT_FIELD_NAMES at every level of nesting. The allowlist is applied
 * recursively so nested non-output fields (e.g., `result.request`, `result.args`,
 * `result.command`) cannot leak through an allowed top-level envelope.
 *
 * Security rationale: a denylist approach (block only known-bad keys once inside
 * a trusted field) was considered and rejected — any key not explicitly blocked
 * (e.g. `result.command`, `result.args`) can carry echoed user or tool-input content.
 * The allowlist approach trades coverage of deeply structured payloads for a hard
 * poisoning boundary. Spawn agents that produce extractable learnings should place
 * them in one of the standard field names at each nesting level.
 *
 * `allowDirectStrings` is threaded through the traversal and set to `true`
 * only once we have descended into an allowed field. This prevents top-level
 * or disallowed-key arrays of strings from bypassing the field filter.
 *
 * - Plain strings: only returned when inside an allowed field subtree.
 * - Arrays: descended with the same `allowDirectStrings` context.
 * - Objects: only keys in OUTPUT_FIELD_NAMES are descended into at every level.
 * - JSON strings inside a trusted field: re-filtered through allowlist.
 *   Command-result envelopes ({ stdout, exitCode }) are skipped before reaching
 *   this function via the IIFE in wrapToolCall.
 */
function extractOutputStrings(val: unknown, allowDirectStrings = false): readonly string[] {
  if (typeof val === "string") {
    if (!allowDirectStrings) return [];
    // If a string under an allowed field is itself JSON-shaped, re-filter it
    // through the allowlist rather than passing it verbatim. This prevents
    // nested JSON blobs (e.g. request metadata serialized inside an `output`
    // field) from smuggling poisoned [LEARNING:...] markers past the filter.
    const firstChar = val.trimStart()[0];
    if (firstChar === "{" || firstChar === "[") {
      try {
        const nested: unknown = JSON.parse(val);
        return extractOutputStrings(nested, false);
      } catch {
        // Not valid JSON — plain string, safe to pass through
      }
    }
    return [val];
  }
  if (Array.isArray(val)) {
    return val.flatMap((item: unknown) => extractOutputStrings(item, allowDirectStrings));
  }
  if (typeof val === "object" && val !== null) {
    const record = val as Record<string, unknown>;
    return Object.entries(record)
      .filter(([k]) => OUTPUT_FIELD_NAMES.has(k))
      .flatMap(([, v]) => extractOutputStrings(v, true)); // strings allowed once inside allowed field
  }
  return [];
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
   * Candidates mapped to MemoryType "user" (preference learnings) are excluded —
   * these represent personal preferences that must not cross team-sync boundaries.
   * All other types (feedback, reference, project) are stored with their correct type.
   */
  async function persistCandidates(candidates: readonly ExtractionCandidate[]): Promise<void> {
    // let justified: mutable flag tracking whether any store succeeded
    let stored = false;

    for (const candidate of candidates) {
      // Drop candidates whose content contains secrets — check before any logging
      // so secret-bearing candidates are never written to stderr or CI logs.
      if (countSecrets(candidate.content) > 0) {
        continue;
      }

      // Skip user-typed (preference) learnings — the file-backed CLI store has no
      // per-user namespace isolation and its recall path injects into every session
      // from the same directory. Persisting personal preferences here would make one
      // user's preferences durable and visible to later sessions. Restore this once
      // namespace-aware storage and recall are wired end-to-end.
      if (candidate.memoryType === "user") {
        console.warn(`[koi:extraction] preference learning skipped (no namespace-isolated store)`);
        continue;
      }

      try {
        await config.memory.store(candidate.content, {
          type: candidate.memoryType,
          category: candidate.category,
          confidence: candidate.confidence,
          ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        });
        stored = true;
      } catch (e: unknown) {
        // Do not propagate — extraction must not disrupt the tool call chain.
        // Log so that misconfigured adapters (e.g. namespace rejected) surface
        // rather than silently dropping all writes.
        console.warn(
          `[koi:extraction] failed to persist candidate (category=${candidate.category}):`,
          e instanceof Error ? e.message : String(e),
        );
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

      // Pre-process output: for JSON-shaped output, restrict to trusted output
      // fields (OUTPUT_FIELD_NAMES) to prevent poisoning via echoed request text,
      // task subjects, metadata, or other non-output fields. Both the realtime
      // regex pass and the LLM accumulation buffer see the same filtered view.
      // If valid JSON but no output fields exist, skip extraction entirely.
      // If not valid JSON (e.g., "[LEARNING:...] text" starts with "["), treat as plain text.
      const extractionInput: string | undefined = (() => {
        // Trim leading whitespace before probing for JSON shape: JSON.parse()
        // accepts leading whitespace but the first-char probe must too.
        const firstChar = outputStr.trimStart()[0];
        if (firstChar !== "{" && firstChar !== "[") {
          return outputStr;
        }
        try {
          const parsed: unknown = JSON.parse(outputStr);
          // Command-result envelopes ({ stdout, exitCode }) are tool-only spawn
          // output: stdout is raw subprocess text, not model-authored content.
          // Extracting from stdout would trust arbitrary shell output as a
          // learning signal. Skip silently — there is no model-authored text
          // to extract from a child that ended on a tool call.
          if (isCommandResultEnvelope(parsed)) {
            return undefined;
          }
          const strings = extractOutputStrings(parsed);
          // Valid JSON: use output-field strings or skip (never raw JSON fallback)
          return strings.length > 0 ? strings.join("\n") : undefined;
        } catch {
          // Not valid JSON — treat as plain text
          return outputStr;
        }
      })();
      if (extractionInput === undefined) {
        return response;
      }

      // Accumulate filtered output for post-session LLM extraction (bounded, per-session).
      // Uses extractionInput (not outputStr) so the LLM sees the same filtered view.
      const sessionId = ctx.session.sessionId;
      const outputs = sessionOutputsMap.get(sessionId);
      if (
        config.modelCall !== undefined &&
        outputs !== undefined &&
        outputs.length < maxSessionOutputs
      ) {
        sessionOutputsMap.set(sessionId, [...outputs, extractionInput]);
      }

      const candidates = extractor.extract(extractionInput);
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

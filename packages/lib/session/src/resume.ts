/**
 * resumeFromTranscript — convert transcript entries into InboundMessages for engine replay.
 *
 * Pure function — no side effects, no I/O.
 *
 * Handles:
 * - compaction folding: compaction entries → synthetic "user" messages with summary
 * - system entries → "system:resume" senderId so the request-mapper grants system authority
 * - tool_call entries → ONE assistant message per turn (metadata.toolCalls array) so
 *   fixTranscriptOrdering sees a single tool_calls turn and preserves all result linkages
 * - tool_call/tool_result positional pairing: nth result matches nth call in the array
 * - dangling crash recovery: tool_calls with no result → synthetic error tool_results
 * - shape validation: valid-JSON but malformed tool_call payloads are skipped with issues
 *
 * repairSession() is NOT called on the output:
 * - Tool results are paired positionally (authoritative transcript data, not LLM output)
 * - Dangling calls are already injected as synthetic error results above
 * - Compaction boundary extension prevents tool_result orphans (compact() never splits pairs)
 * - repairSession uses metadata.callId for orphan detection, which conflicts with the
 *   metadata.toolCalls shape used here for request-mapper multi-call fidelity
 */

import type {
  InboundMessage,
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  TranscriptEntry,
} from "@koi/core";
import { validateNonEmpty } from "@koi/core";
import type { RepairIssue } from "@koi/session-repair";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ResumeResult {
  readonly messages: readonly InboundMessage[];
  readonly issues: readonly RepairIssue[];
}

// ---------------------------------------------------------------------------
// Shape validation for tool_call payload
// ---------------------------------------------------------------------------

interface ToolCallPayload {
  readonly id: string;
  readonly toolName: string;
  readonly args: string;
}

function isToolCallPayload(value: unknown): value is ToolCallPayload {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" && typeof obj.toolName === "string" && typeof obj.args === "string"
  );
}

// ---------------------------------------------------------------------------
// Pure conversion
// ---------------------------------------------------------------------------

/**
 * Convert transcript entries to InboundMessages ready for engine replay.
 *
 * @param entries - Ordered transcript entries from SessionTranscript.load()
 * @returns ResumeResult with messages and any issues found during parsing
 */
export function resumeFromTranscript(
  entries: readonly TranscriptEntry[],
): Result<ResumeResult, KoiError> {
  const messages: InboundMessage[] = [];
  const issues: RepairIssue[] = [];

  // Pending tool_calls waiting for positional tool_result matching.
  // Queue semantics: pendingCalls[pendingCallOffset] is the next unmatched call.
  // Stores both callId and toolName so tool_result messages can round-trip the
  // full metadata the request-mapper expects (toolCallId, toolName).
  const pendingCalls: Array<{ readonly id: string; readonly toolName: string }> = [];
  let pendingCallOffset = 0;

  for (const transcriptEntry of entries) {
    switch (transcriptEntry.role) {
      case "compaction": {
        // Fold into a synthetic user message so the model sees the prior summary
        messages.push({
          senderId: "user",
          content: [{ kind: "text", text: `[Summary] ${transcriptEntry.content}` }],
          timestamp: transcriptEntry.timestamp,
          metadata: { synthetic: true, compacted: true },
        });
        break;
      }

      case "user":
      case "assistant": {
        messages.push({
          senderId: transcriptEntry.role,
          content: [{ kind: "text", text: transcriptEntry.content }],
          timestamp: transcriptEntry.timestamp,
        });
        break;
      }

      case "system": {
        // Use "system:resume" prefix so resolveRole() in the request-mapper
        // grants system authority. Plain senderId "system" doesn't match the
        // "system:*" startsWith check and falls back to "user" role.
        messages.push({
          senderId: "system:resume",
          content: [{ kind: "text", text: transcriptEntry.content }],
          timestamp: transcriptEntry.timestamp,
        });
        break;
      }

      case "tool_call": {
        // Parse and validate the calls array: [{id, toolName, args}, ...]
        let raw: unknown;
        try {
          raw = JSON.parse(transcriptEntry.content);
        } catch {
          // Corrupt tool_call entry — skip and record issue
          issues.push({
            phase: "orphan-tool",
            description: `Skipped malformed tool_call entry (id: ${transcriptEntry.id}): JSON parse error`,
            index: messages.length,
            action: "removed",
          });
          break;
        }
        if (!Array.isArray(raw)) {
          issues.push({
            phase: "orphan-tool",
            description: `Skipped malformed tool_call entry (id: ${transcriptEntry.id}): payload is not an array`,
            index: messages.length,
            action: "removed",
          });
          break;
        }
        // Filter out entries with missing/non-string id, toolName, or args.
        // Invalid entries are silently dropped (schema mismatch, not data corruption).
        const calls = raw.filter(isToolCallPayload);
        if (calls.length === 0) {
          issues.push({
            phase: "orphan-tool",
            description: `Skipped tool_call entry (id: ${transcriptEntry.id}): no valid call objects`,
            index: messages.length,
            action: "removed",
          });
          break;
        }

        // Emit ONE assistant message per tool_call transcript entry (i.e., per
        // model turn). This is critical: fixTranscriptOrdering() in the request-
        // mapper replaces pendingCallIds on each new assistant tool_calls message,
        // so splitting a multi-call turn into N separate messages would cause
        // results 1..N-1 to be dropped as stale.
        //
        // Use metadata.toolCalls (the request-mapper primary path) to store the
        // full ChatCompletionToolCall array for faithful reconstruction. This is
        // intentionally NOT sent through repairSession(), which pairs by
        // metadata.callId — repairSession would treat every resumed tool result
        // as an orphan and insert spurious synthetic assistants, producing multiple
        // assistant tool_calls turns per original model turn.
        const toolCalls = calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.toolName, arguments: call.args },
        }));
        // Use first call.id as content text — UUIDs are unique across turns so
        // the dedup phase (content-hash only) won't collapse consecutive turns.
        messages.push({
          senderId: "assistant",
          content: [{ kind: "text", text: calls[0]?.id ?? transcriptEntry.id }],
          timestamp: transcriptEntry.timestamp,
          metadata: { toolCalls },
        });
        // Track each call for positional result matching below.
        for (const call of calls) {
          pendingCalls.push({ id: call.id, toolName: call.toolName });
        }
        break;
      }

      case "tool_result": {
        // Positional match: consume the earliest unmatched call.
        // Emit toolCallId + toolName so the request-mapper can reconstruct the
        // tool_result block using the linkage keys (callId, toolCallId, toolName).
        const pending = pendingCalls[pendingCallOffset] ?? { id: "unknown", toolName: "unknown" };
        pendingCallOffset++;
        messages.push({
          senderId: "tool",
          content: [{ kind: "text", text: transcriptEntry.content }],
          timestamp: transcriptEntry.timestamp,
          metadata: { callId: pending.id, toolCallId: pending.id, toolName: pending.toolName },
        });
        break;
      }
    }
  }

  // Any remaining pending calls are dangling — the process crashed before the
  // tool completed and wrote its result. Inject synthetic error results so the
  // model knows these calls failed on the next turn.
  const lastTimestamp = entries.at(-1)?.timestamp ?? Date.now();
  for (let i = pendingCallOffset; i < pendingCalls.length; i++) {
    const pending = pendingCalls[i] ?? { id: "unknown", toolName: "unknown" };
    messages.push({
      senderId: "tool",
      content: [
        { kind: "text", text: "[Tool result lost — session crashed before tool completed]" },
      ],
      timestamp: lastTimestamp,
      metadata: {
        callId: pending.id,
        toolCallId: pending.id,
        toolName: pending.toolName,
        synthetic: true,
        isError: true,
      },
    });
    issues.push({
      phase: "orphan-tool",
      description: `Injected synthetic error result for dangling tool_call (callId: ${pending.id})`,
      index: messages.length - 1,
      action: "inserted",
    });
  }

  return { ok: true, value: { messages, issues } };
}

// ---------------------------------------------------------------------------
// Store-integrated wrapper
// ---------------------------------------------------------------------------

/**
 * Load transcript from store and convert to InboundMessages.
 * Validates sessionId before loading — VALIDATION error for empty ID.
 */
export async function resumeForSession(
  sid: SessionId,
  transcript: SessionTranscript,
): Promise<Result<ResumeResult, KoiError>> {
  const idCheck = validateNonEmpty(sid, "Session ID");
  if (!idCheck.ok) return idCheck;

  const loadResult = await transcript.load(sid);
  if (!loadResult.ok) return loadResult;

  return resumeFromTranscript(loadResult.value.entries);
}

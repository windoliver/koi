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
 * - final repair pass via repairSession(): orphan pairs, dedup, merge
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
import { repairSession } from "@koi/session-repair";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ResumeResult {
  readonly messages: readonly InboundMessage[];
  readonly issues: readonly RepairIssue[];
}

// ---------------------------------------------------------------------------
// Pure conversion
// ---------------------------------------------------------------------------

/**
 * Convert transcript entries to InboundMessages ready for engine replay.
 *
 * @param entries - Ordered transcript entries from SessionTranscript.load()
 * @returns ResumeResult with repaired messages and any repair issues
 */
export function resumeFromTranscript(
  entries: readonly TranscriptEntry[],
): Result<ResumeResult, KoiError> {
  const messages: InboundMessage[] = [];

  // Pending tool_calls waiting for positional tool_result matching.
  // Queue semantics: pendingCalls[pendingCallOffset] is the next unmatched call.
  // Stores both callId and toolName so tool_result messages can round-trip the
  // full metadata the request-mapper and repairSession expect (callId, toolCallId,
  // toolName) without lossy reconstruction.
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
        // Parse the calls array: [{id, toolName, args}, ...]
        let calls: Array<{ id: string; toolName: string; args: string }>;
        try {
          calls = JSON.parse(transcriptEntry.content) as Array<{
            id: string;
            toolName: string;
            args: string;
          }>;
        } catch {
          // Corrupt tool_call entry — skip to avoid crashing resume
          break;
        }
        // Emit ONE assistant message per tool_call transcript entry (i.e., per
        // model turn). This is critical: fixTranscriptOrdering() in the request-
        // mapper replaces pendingCallIds on each new assistant tool_calls message,
        // so splitting a multi-call turn into N separate messages would cause
        // results 1..N-1 to be dropped as stale (their call IDs are no longer
        // in pendingCallIds when the results arrive).
        //
        // Use metadata.toolCalls (the request-mapper primary path) to store the
        // full ChatCompletionToolCall array for faithful reconstruction. The
        // single-call callId/callName/callArgs fallback path in the mapper is
        // NOT used here — it only handles one call per message.
        const toolCalls = calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.toolName, arguments: call.args },
        }));
        // Use first call.id as content text — UUIDs are unique across turns so
        // repairSession()'s dedup phase (content-hash only) won't collapse them.
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
        // Emit toolCallId + toolName alongside callId so the request-mapper
        // can reconstruct the tool_result block using any of the linkage keys
        // (callId, toolCallId) and so repairSession can classify the result.
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
  // tool completed and wrote its result. Inject synthetic error results so that
  // repairSession sees a balanced history and the model knows these calls failed.
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
  }

  // Final repair pass: clean up any remaining orphans, deduplicate, merge
  const repairResult = repairSession(messages);

  return { ok: true, value: { messages: repairResult.messages, issues: repairResult.issues } };
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

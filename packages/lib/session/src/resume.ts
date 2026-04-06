/**
 * resumeFromTranscript — convert transcript entries into InboundMessages for engine replay.
 *
 * Pure function — no side effects, no I/O.
 *
 * Handles:
 * - compaction folding: compaction entries → synthetic "user" messages with summary
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

  // callIds of tool_calls waiting for positional tool_result matching.
  // Queue semantics: pendingCalls[pendingCallOffset] is the next unmatched callId.
  const pendingCalls: string[] = [];
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
      case "assistant":
      case "system": {
        messages.push({
          senderId: transcriptEntry.role,
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
        // Each call becomes one assistant message with its callId for pairing
        for (const call of calls) {
          messages.push({
            senderId: "assistant",
            content: [{ kind: "text", text: call.toolName }],
            timestamp: transcriptEntry.timestamp,
            metadata: { callId: call.id, toolName: call.toolName },
          });
          pendingCalls.push(call.id);
        }
        break;
      }

      case "tool_result": {
        // Positional match: consume the earliest unmatched callId
        const callId = pendingCalls[pendingCallOffset] ?? "unknown";
        pendingCallOffset++;
        messages.push({
          senderId: "tool",
          content: [{ kind: "text", text: transcriptEntry.content }],
          timestamp: transcriptEntry.timestamp,
          metadata: { callId },
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
    const callId = pendingCalls[i] ?? "unknown";
    messages.push({
      senderId: "tool",
      content: [
        { kind: "text", text: "[Tool result lost — session crashed before tool completed]" },
      ],
      timestamp: lastTimestamp,
      metadata: { callId, synthetic: true, isError: true },
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

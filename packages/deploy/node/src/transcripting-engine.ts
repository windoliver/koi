/**
 * Transcripting engine decorator — wraps an EngineAdapter to auto-append
 * transcript entries on `turn_end` and `done` events.
 *
 * Captures user input, assistant text (from text_delta), and tool calls
 * (from tool_call_start/tool_call_end) as transcript entries.
 *
 * The append callback is fire-and-forget: failures are swallowed (logged
 * via catch) so they never block the event stream.
 */

import type {
  ContentBlock,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  SessionId,
  SessionTranscript,
  TextBlock,
  TranscriptEntry,
  TranscriptEntryRole,
} from "@koi/core";
import { transcriptEntryId } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TranscriptingEngineConfig {
  readonly sessionId: SessionId;
  readonly transcript: SessionTranscript;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEntry(
  role: TranscriptEntry["role"],
  content: string,
  metadata?: Readonly<Record<string, unknown>>,
): TranscriptEntry {
  return {
    id: transcriptEntryId(`${role}-${String(Date.now())}-${crypto.randomUUID().slice(0, 8)}`),
    role,
    content,
    timestamp: Date.now(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Extract text from content blocks of an inbound message. */
function extractText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Map an InboundMessage senderId to the appropriate transcript entry role. */
function mapSenderIdToRole(senderId: string): TranscriptEntryRole {
  const lower = senderId.toLowerCase();
  if (lower.includes("assistant")) return "assistant";
  if (lower.includes("tool")) return "tool_result";
  if (lower.includes("system")) return "system";
  return "user";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap an engine adapter so that user input and assistant output are
 * automatically appended to a transcript store.
 */
export function createTranscriptingEngine(
  inner: EngineAdapter,
  config: TranscriptingEngineConfig,
): EngineAdapter {
  const { sessionId, transcript } = config;

  function fireAppend(entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) return;
    void Promise.resolve(transcript.append(sessionId, entries)).catch(() => {
      // Intentionally swallowed — transcript failure must not block the stream.
    });
  }

  async function* wrappedStream(input: EngineInput): AsyncGenerator<EngineEvent> {
    // -- Capture input as user entry ------------------------------------------
    if (input.kind === "text") {
      fireAppend([createEntry("user", input.text)]);
    } else if (input.kind === "messages") {
      const entries = input.messages
        .map((msg) => ({ text: extractText(msg.content), role: mapSenderIdToRole(msg.senderId) }))
        .filter(({ text }) => text.length > 0)
        .map(({ text, role }) => createEntry(role, text));
      fireAppend(entries);
    }
    // kind === "resume" — no user entry (engine state restore)

    // -- Accumulate output for assistant entry --------------------------------
    // let: reset on each turn_end/done flush
    let assistantText = "";
    let pendingToolCalls: readonly TranscriptEntry[] = [];

    function flush(): void {
      const entries: readonly TranscriptEntry[] = [
        ...(assistantText.length > 0 ? [createEntry("assistant", assistantText)] : []),
        ...pendingToolCalls,
      ];
      fireAppend(entries);
      assistantText = "";
      pendingToolCalls = [];
    }

    for await (const event of inner.stream(input)) {
      yield event;

      switch (event.kind) {
        case "text_delta": {
          assistantText += event.delta;
          break;
        }
        case "tool_call_start": {
          pendingToolCalls = [
            ...pendingToolCalls,
            createEntry(
              "tool_call",
              JSON.stringify({
                toolName: event.toolName,
                callId: event.callId,
                args: event.args,
              }),
            ),
          ];
          break;
        }
        case "tool_call_end": {
          pendingToolCalls = [
            ...pendingToolCalls,
            createEntry(
              "tool_result",
              JSON.stringify({ callId: event.callId, result: event.result }),
            ),
          ];
          break;
        }
        case "turn_end":
        case "done": {
          flush();
          break;
        }
        default:
          break;
      }
    }
  }

  // Build adapter, only including optional properties when they exist on inner.
  // This satisfies exactOptionalPropertyTypes (absent property vs. undefined).
  return {
    engineId: inner.engineId,
    capabilities: inner.capabilities,
    stream: wrappedStream,
    ...(inner.terminals !== undefined ? { terminals: inner.terminals } : {}),
    ...(inner.saveState !== undefined ? { saveState: inner.saveState } : {}),
    ...(inner.loadState !== undefined ? { loadState: inner.loadState } : {}),
    ...(inner.inject !== undefined ? { inject: inner.inject } : {}),
    ...(inner.dispose !== undefined ? { dispose: inner.dispose } : {}),
  };
}

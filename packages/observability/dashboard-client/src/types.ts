/**
 * Shared types for the dashboard client layer.
 *
 * Error types, chat message types, and session path constants
 * used by admin-client, agui-client, and session loading.
 */

// ─── Error Types ─────────────────────────────────────────────────────

/** All expected failure modes for the dashboard client. */
export type DashboardClientError =
  | {
      readonly kind: "connection_refused";
      readonly url: string;
    }
  | {
      readonly kind: "auth_failed";
      readonly message: string;
    }
  | {
      readonly kind: "stream_dropped";
      readonly sessionId: string;
    }
  | {
      readonly kind: "agent_terminated";
      readonly agentId: string;
    }
  | {
      readonly kind: "timeout";
      readonly operation: string;
      readonly ms: number;
    }
  | {
      readonly kind: "api_error";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "unexpected";
      readonly cause: unknown;
    };

// ─── Chat Types ──────────────────────────────────────────────────────

/** A single message in the agent console conversation. */
export type ChatMessage =
  | {
      readonly kind: "user";
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "tool_call";
      readonly name: string;
      readonly args: string;
      readonly result: string | undefined;
      readonly toolCallId?: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "lifecycle";
      readonly event: string;
      readonly timestamp: number;
    };

// ─── Session Path Constants ──────────────────────────────────────────

/** TUI session persistence path prefix. */
export const TUI_SESSION_PREFIX = "/session/tui";

/** Engine session records path prefix (canonical SessionRecord storage). */
export const ENGINE_SESSION_PREFIX = "/session/records";

/** Shared chat log prefix (written by AG-UI dispatch). */
export const CHAT_SESSION_PREFIX = "/session/chat";

// ─── Session Parsing ─────────────────────────────────────────────────

/** Parsed metadata from a SessionRecord JSON file. */
export interface SessionInfo {
  readonly sessionId: string;
  readonly connectedAt: number;
  readonly agentName: string;
  readonly agentId?: string | undefined;
  readonly path: string;
}

/** Parse a SessionRecord JSON file to extract session metadata. */
export function parseSessionRecord(content: string): Omit<SessionInfo, "path"> | null {
  if (content.trim() === "") return null;

  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    const sessionId = record.sessionId;
    if (typeof sessionId !== "string") return null;

    const connectedAt = typeof record.connectedAt === "number" ? record.connectedAt : Date.now();

    // Try direct agentName first (TUI-written records), then manifestSnapshot (engine records)
    let agentName = "unknown";
    if (typeof record.agentName === "string") {
      agentName = record.agentName;
    } else {
      const manifest = record.manifestSnapshot;
      if (typeof manifest === "object" && manifest !== null) {
        const name = (manifest as Record<string, unknown>).name;
        if (typeof name === "string") {
          agentName = name;
        }
      }
    }

    const agentId = typeof record.agentId === "string" ? record.agentId : undefined;

    return { sessionId, connectedAt, agentName, agentId };
  } catch {
    return null;
  }
}

/** Parse TUI chat log (JSON-lines format) into ChatMessage array. */
export function parseTuiChatLog(content: string): readonly ChatMessage[] {
  if (content.trim() === "") return [];

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
        const msg = parsed as Record<string, unknown>;
        const kind = msg.kind;
        if (
          kind === "user" ||
          kind === "assistant" ||
          kind === "lifecycle" ||
          kind === "tool_call"
        ) {
          messages.push(parsed as ChatMessage);
        }
      }
    } catch {
      // Not JSON — skip line
    }
  }

  return messages;
}

/**
 * Conversation middleware — links stateless channel sessions via threadId.
 *
 * Loads history on session start, injects it into model calls,
 * and persists new turns on session end.
 */
import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ThreadMessage,
  ThreadMessageRole,
  TurnContext,
} from "@koi/core";
import { agentId, threadId, threadMessageId } from "@koi/core";
import { estimateTokens as defaultEstimateTokens } from "@koi/token-estimator";

import type { ConversationConfig } from "./config.js";
import { CONVERSATION_DEFAULTS } from "./config.js";
import { mapThreadMessageToInbound } from "./map-thread-to-inbound.js";
import { pruneHistory } from "./prune-history.js";

/**
 * Create a conversation middleware that loads/persists thread history.
 *
 * @param config - Store, limits, and optional callbacks.
 * @returns A KoiMiddleware that manages conversation continuity.
 */
export function createConversationMiddleware(config: ConversationConfig): KoiMiddleware {
  const { store } = config;
  const maxHistoryTokens = config.maxHistoryTokens ?? CONVERSATION_DEFAULTS.maxHistoryTokens;
  const maxMessages = config.maxMessages ?? CONVERSATION_DEFAULTS.maxMessages;
  const estimate = config.estimateTokens ?? defaultEstimateTokens;

  // Per-thread write mutex: serializes writes per threadId
  const pendingWrites = new Map<string, Promise<void>>();

  // --- Session-scoped state (reset on each onSessionEnd) ---
  // let justified: tracks loaded history for the current session
  let loadedHistory: readonly InboundMessage[] | undefined;
  // let justified: pre-computed per-message token estimates
  let loadedTokenEstimates: readonly number[] | undefined;
  // let justified: resolved thread ID for the current session
  let resolvedThreadId: string | undefined;
  // let justified: count of loaded history messages for describeCapabilities
  let historyCount = 0;
  // let justified: accumulates new messages during the session for persistence
  let newTurnMessages: readonly ThreadMessage[] = [];
  // let justified: session context reference for building ThreadMessageIds
  let sessionRef: SessionContext | undefined;
  // let justified: monotonic counter for generating unique message IDs within session
  let messageCounter = 0;
  // let justified: raw ThreadMessages loaded from store, reused in onSessionEnd for pruning
  let loadedRawMessages: readonly ThreadMessage[] = [];
  // let justified: tracks captured message timestamps to prevent duplicates across calls
  let capturedTimestamps = new Set<number>();

  /** Derive role from senderId: agent → assistant, system:* → system, tool:* → tool, else user. */
  function deriveRole(msg: InboundMessage): ThreadMessageRole {
    if (sessionRef !== undefined && msg.senderId === sessionRef.agentId) return "assistant";
    if (msg.senderId.startsWith("system")) return "system";
    if (msg.senderId.startsWith("tool")) return "tool";
    return "user";
  }

  /**
   * Inject loaded history into a model request, respecting the token budget.
   * Always includes at least the newest message even if it exceeds the budget.
   */
  function injectHistory(request: ModelRequest): ModelRequest {
    if (loadedHistory === undefined || loadedHistory.length === 0) {
      return request;
    }

    const estimates = loadedTokenEstimates ?? [];
    // let justified: tracks remaining token budget during backwards walk
    let budget = maxHistoryTokens;
    // let justified: start index of selected history slice
    let startIndex = loadedHistory.length;

    // Walk backwards (newest first), accumulate until budget exhausted
    for (let i = loadedHistory.length - 1; i >= 0; i--) {
      const est = estimates[i] ?? 0;
      if (budget - est < 0 && startIndex < loadedHistory.length) {
        // Budget exceeded and we already have at least one message
        break;
      }
      budget -= est;
      startIndex = i;
    }

    const selectedHistory = loadedHistory.slice(startIndex);
    return {
      ...request,
      messages: [...selectedHistory, ...request.messages],
    };
  }

  /**
   * Map an InboundMessage back to a ThreadMessage for persistence.
   */
  function mapInboundToThread(
    msg: InboundMessage,
    role: ThreadMessageRole,
    sessionId: string,
  ): ThreadMessage {
    // Extract text content from content blocks
    const text = msg.content
      .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
      .map((b) => b.text)
      .join("");

    messageCounter += 1;
    return {
      id: threadMessageId(`${sessionId}-${messageCounter}-${role}`),
      role,
      content: text,
      createdAt: msg.timestamp,
    };
  }

  /**
   * Build a ThreadMessage from a ModelResponse (assistant turn).
   */
  function mapResponseToThread(response: ModelResponse, sessionId: string): ThreadMessage {
    messageCounter += 1;
    return {
      id: threadMessageId(`${sessionId}-${messageCounter}-assistant`),
      role: "assistant",
      content: response.content,
      createdAt: Date.now(),
    };
  }

  /**
   * Check if an InboundMessage was injected from history.
   */
  function isFromHistory(m: InboundMessage): boolean {
    if (m.metadata === undefined) {
      return false;
    }
    return "fromHistory" in m.metadata && m.metadata.fromHistory === true;
  }

  /**
   * Record new user messages from a model request (excluding history).
   */
  function captureNewUserMessages(request: ModelRequest, sessionId: string): void {
    const fresh = request.messages.filter(
      (m) => !isFromHistory(m) && !capturedTimestamps.has(m.timestamp),
    );

    if (fresh.length > 0) {
      const mapped = fresh.map((m) => {
        capturedTimestamps = new Set([...capturedTimestamps, m.timestamp]);
        return mapInboundToThread(m, deriveRole(m), sessionId);
      });
      newTurnMessages = [...newTurnMessages, ...mapped];
    }
  }

  return {
    name: "koi:conversation",
    priority: 100,
    phase: "resolve",

    async onSessionStart(ctx: SessionContext): Promise<void> {
      // Reset session state
      loadedHistory = undefined;
      loadedTokenEstimates = undefined;
      historyCount = 0;
      newTurnMessages = [];
      messageCounter = 0;
      sessionRef = ctx;
      loadedRawMessages = [];
      capturedTimestamps = new Set();

      const rawThreadId = ctx.metadata.threadId;
      const metadataThreadId = typeof rawThreadId === "string" ? rawThreadId : undefined;
      const tid = config.resolveThreadId?.(ctx) ?? metadataThreadId ?? ctx.channelId;

      if (tid === undefined) {
        resolvedThreadId = undefined;
        return;
      }

      resolvedThreadId = tid;
      const result = await store.listMessages(threadId(tid), maxMessages);

      if (!result.ok) {
        // Cannot load history — continue without it
        resolvedThreadId = undefined;
        return;
      }

      const messages = result.value;
      loadedRawMessages = messages;
      if (messages.length === 0) {
        return;
      }

      loadedHistory = messages.map((m) => mapThreadMessageToInbound(m, ctx.agentId, ctx.userId));
      loadedTokenEstimates = messages.map((m) => estimate(m.content));
      historyCount = messages.length;
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const sid = sessionRef?.sessionId ?? "";

      // Capture new user messages before injection
      captureNewUserMessages(request, sid);

      const enriched = injectHistory(request);
      const response = await next(enriched);

      // Capture assistant response
      const assistantMsg = mapResponseToThread(response, sid);
      newTurnMessages = [...newTurnMessages, assistantMsg];

      return response;
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sid = sessionRef?.sessionId ?? "";

      // Capture new user messages before injection
      captureNewUserMessages(request, sid);

      const enriched = injectHistory(request);

      for await (const chunk of next(enriched)) {
        if (chunk.kind === "done") {
          const assistantMsg = mapResponseToThread(chunk.response, sid);
          newTurnMessages = [...newTurnMessages, assistantMsg];
        }
        yield chunk;
      }
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      if (resolvedThreadId === undefined) {
        return;
      }

      if (newTurnMessages.length === 0) {
        // Nothing to persist — reset state
        loadedHistory = undefined;
        loadedTokenEstimates = undefined;
        resolvedThreadId = undefined;
        historyCount = 0;
        sessionRef = undefined;
        loadedRawMessages = [];
        return;
      }

      // Reuse messages cached from onSessionStart (avoids redundant I/O)
      const allMessages = [...loadedRawMessages, ...newTurnMessages];
      const pruned = pruneHistory(allMessages, {
        maxMessages,
        compact: config.compact,
      });

      const snapshot = {
        kind: "message" as const,
        threadId: threadId(resolvedThreadId),
        agentId: agentId(sessionRef?.agentId ?? "unknown"),
        sessionId: sessionRef?.sessionId,
        messages: pruned,
        turnIndex: newTurnMessages.length,
        createdAt: Date.now(),
      };

      const tid = resolvedThreadId;
      const messagesToPersist = newTurnMessages;

      // Serialize writes per-thread via promise chain mutex
      const prev = pendingWrites.get(tid) ?? Promise.resolve();
      const write = prev
        .then(async () => {
          const writeResult = await store.appendAndCheckpoint(
            threadId(tid),
            messagesToPersist,
            snapshot,
          );
          if (!writeResult.ok) {
            throw new Error(
              `Failed to persist conversation for thread ${tid}: ${writeResult.error.message}`,
              { cause: writeResult.error },
            );
          }
        })
        .finally(() => {
          // Clean up to prevent memory leak — only if this is still the latest write
          if (pendingWrites.get(tid) === write) {
            pendingWrites.delete(tid);
          }
        });
      pendingWrites.set(tid, write);
      await write;

      // Reset session state
      loadedHistory = undefined;
      loadedTokenEstimates = undefined;
      resolvedThreadId = undefined;
      historyCount = 0;
      newTurnMessages = [];
      sessionRef = undefined;
      messageCounter = 0;
      loadedRawMessages = [];
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (historyCount === 0) {
        return undefined;
      }
      return {
        label: "conversation",
        description: `${historyCount} turns loaded for thread ${resolvedThreadId}`,
      };
    },
  };
}

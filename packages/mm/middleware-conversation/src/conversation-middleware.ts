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

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

/**
 * Internal mutable session state — not shared outside middleware.
 * Fields are intentionally non-readonly: this type describes internal
 * accumulator state that is mutated within the middleware closure and
 * replaced atomically via createInitialState() on session boundaries.
 */
type SessionState = {
  // Set once in onSessionStart, read-only during session
  loadedHistory: readonly InboundMessage[] | undefined;
  loadedTokenEstimates: readonly number[] | undefined;
  loadedRawMessages: readonly ThreadMessage[];
  resolvedThreadId: string | undefined;
  historyCount: number;
  sessionRef: SessionContext | undefined;
  /** Pre-computed history slice respecting token budget — avoids repeated budget walk. */
  precomputedHistory: readonly InboundMessage[];
  // Mutated during session
  messageCounter: number;
  /** Mutable accumulator — push() used intentionally on internal state. */
  newTurnMessages: ThreadMessage[];
  /** Mutable accumulator — add() used intentionally on internal state. */
  capturedKeys: Set<string>;
};

function createInitialState(): SessionState {
  return {
    loadedHistory: undefined,
    loadedTokenEstimates: undefined,
    loadedRawMessages: [],
    resolvedThreadId: undefined,
    historyCount: 0,
    sessionRef: undefined,
    precomputedHistory: [],
    messageCounter: 0,
    newTurnMessages: [],
    capturedKeys: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

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

  // Per-thread write mutex: serializes writes per threadId (persists across sessions)
  const pendingWrites = new Map<string, Promise<void>>();

  // Session state — replaced atomically on session boundaries
  // let justified: single mutable reference, replaced via createInitialState()
  let state = createInitialState();

  /** Derive role from senderId: agent → assistant, system:* → system, tool:* → tool, else user. */
  function deriveRole(msg: InboundMessage): ThreadMessageRole {
    if (state.sessionRef !== undefined && msg.senderId === state.sessionRef.agentId)
      return "assistant";
    if (msg.senderId.startsWith("system")) return "system";
    if (msg.senderId.startsWith("tool")) return "tool";
    return "user";
  }

  /**
   * Inject pre-computed history into a model request.
   * History slice is computed once in onSessionStart — no repeated budget walk.
   */
  function injectHistory(request: ModelRequest): ModelRequest {
    if (state.precomputedHistory.length === 0) {
      return request;
    }

    return {
      ...request,
      messages: [...state.precomputedHistory, ...request.messages],
    };
  }

  /**
   * Pre-compute the history slice that fits within the token budget.
   * Always includes at least the newest message even if it exceeds the budget.
   */
  function computeHistorySlice(): readonly InboundMessage[] {
    if (state.loadedHistory === undefined || state.loadedHistory.length === 0) {
      return [];
    }

    const estimates = state.loadedTokenEstimates ?? [];
    // let justified: tracks remaining token budget during backwards walk
    let budget = maxHistoryTokens;
    // let justified: start index of selected history slice
    let startIndex = state.loadedHistory.length;

    // Walk backwards (newest first), accumulate until budget exhausted
    for (let i = state.loadedHistory.length - 1; i >= 0; i--) {
      const est = estimates[i] ?? 0;
      if (budget - est < 0 && startIndex < state.loadedHistory.length) {
        // Budget exceeded and we already have at least one message
        break;
      }
      budget -= est;
      startIndex = i;
    }

    return state.loadedHistory.slice(startIndex);
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

    state.messageCounter += 1;
    return {
      id: threadMessageId(`${sessionId}-${state.messageCounter}-${role}`),
      role,
      content: text,
      createdAt: msg.timestamp,
    };
  }

  /**
   * Build a ThreadMessage from a ModelResponse (assistant turn).
   */
  function mapResponseToThread(response: ModelResponse, sessionId: string): ThreadMessage {
    state.messageCounter += 1;
    return {
      id: threadMessageId(`${sessionId}-${state.messageCounter}-assistant`),
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
   * Uses mutable accumulators — internal state not shared outside middleware.
   */
  function captureNewUserMessages(request: ModelRequest, sessionId: string): void {
    for (const m of request.messages) {
      if (isFromHistory(m)) continue;
      const key = `${m.timestamp}:${m.senderId}`;
      if (state.capturedKeys.has(key)) continue;
      state.capturedKeys.add(key);
      state.newTurnMessages.push(mapInboundToThread(m, deriveRole(m), sessionId));
    }
  }

  return {
    name: "koi:conversation",
    priority: 100,
    phase: "resolve",

    async onSessionStart(ctx: SessionContext): Promise<void> {
      state = createInitialState();
      state.sessionRef = ctx;

      const rawThreadId = ctx.metadata.threadId;
      const metadataThreadId = typeof rawThreadId === "string" ? rawThreadId : undefined;
      const tid = config.resolveThreadId?.(ctx) ?? metadataThreadId ?? ctx.channelId;

      if (tid === undefined) {
        return;
      }

      state.resolvedThreadId = tid;
      const result = await store.listMessages(threadId(tid), maxMessages);

      if (!result.ok) {
        // Cannot load history — continue without injection but keep thread for persistence
        return;
      }

      const messages = result.value;
      state.loadedRawMessages = messages;
      if (messages.length === 0) {
        return;
      }

      state.loadedHistory = messages.map((m) =>
        mapThreadMessageToInbound(m, ctx.agentId, ctx.userId),
      );
      state.loadedTokenEstimates = messages.map((m) => estimate(m.content));
      state.historyCount = messages.length;
      state.precomputedHistory = computeHistorySlice();
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const sid = state.sessionRef?.sessionId ?? "";

      // Capture new user messages before injection
      captureNewUserMessages(request, sid);

      const enriched = injectHistory(request);
      const response = await next(enriched);

      // Internal mutable accumulator — not shared outside middleware
      state.newTurnMessages.push(mapResponseToThread(response, sid));

      return response;
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sid = state.sessionRef?.sessionId ?? "";

      // Capture new user messages before injection
      captureNewUserMessages(request, sid);

      const enriched = injectHistory(request);

      for await (const chunk of next(enriched)) {
        if (chunk.kind === "done") {
          // Internal mutable accumulator — not shared outside middleware
          state.newTurnMessages.push(mapResponseToThread(chunk.response, sid));
        }
        yield chunk;
      }
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      if (state.resolvedThreadId === undefined) {
        state = createInitialState();
        return;
      }

      if (state.newTurnMessages.length === 0) {
        state = createInitialState();
        return;
      }

      // Reuse messages cached from onSessionStart (avoids redundant I/O)
      const allMessages = [...state.loadedRawMessages, ...state.newTurnMessages];
      const pruned = pruneHistory(allMessages, {
        maxMessages,
        compact: config.compact,
      });

      const snapshot = {
        kind: "message" as const,
        threadId: threadId(state.resolvedThreadId),
        agentId: agentId(state.sessionRef?.agentId ?? "unknown"),
        sessionId: state.sessionRef?.sessionId,
        messages: pruned,
        turnIndex: state.newTurnMessages.length,
        createdAt: Date.now(),
      };

      const tid = state.resolvedThreadId;
      // Snapshot mutable array before async write
      const messagesToPersist = [...state.newTurnMessages];

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

      state = createInitialState();
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (state.historyCount === 0) {
        return undefined;
      }
      return {
        label: "conversation",
        description: `${state.historyCount} turns loaded for thread ${state.resolvedThreadId}`,
      };
    },
  };
}

/**
 * Zustand store for console chat state — messages, streaming, sessions.
 *
 * Mirrors the TUI's state model adapted for React:
 * - Immutable updates via Zustand
 * - Sliding window (500 messages max)
 * - Token buffering handled externally via ref + rAF (Issue 13A)
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// ─── Chat Types ──────────────────────────────────────────────────────

/** A single message in the console conversation. */
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
      readonly timestamp: number;
    }
  | {
      readonly kind: "lifecycle";
      readonly event: string;
      readonly timestamp: number;
    };

/** Active chat session state. */
export interface ChatSession {
  readonly agentId: string;
  readonly sessionId: string;
  readonly threadId: string;
}

/** Maximum messages kept in session memory (sliding window). */
export const MAX_SESSION_MESSAGES = 500;

/** Maximum messages rendered in the DOM (windowed rendering). */
export const MAX_RENDERED_MESSAGES = 100;

// ─── Store ───────────────────────────────────────────────────────────

interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly session: ChatSession | null;
  readonly isStreaming: boolean;
  /** Pending streamed text not yet committed as a message (flushed from ref by rAF). */
  readonly pendingText: string;
  /** Active tool calls being streamed (toolCallId → accumulated args). */
  readonly activeToolCalls: Readonly<
    Record<string, { readonly name: string; readonly args: string }>
  >;
  readonly error: string | null;
  /** Last user message text — enables retry after stream failure. */
  readonly lastUserMessage: string | null;
  /** Whether the agent has been terminated (disables composer). */
  readonly agentTerminated: boolean;

  // Actions
  readonly addMessage: (message: ChatMessage) => void;
  readonly appendTokens: (text: string) => void;
  readonly flushTokens: () => void;
  readonly setStreaming: (isStreaming: boolean) => void;
  readonly setSession: (session: ChatSession | null) => void;
  readonly setError: (error: string | null) => void;
  readonly startToolCall: (toolCallId: string, name: string) => void;
  readonly appendToolCallArgs: (toolCallId: string, delta: string) => void;
  readonly finishToolCall: (toolCallId: string, result: string | undefined) => void;
  readonly clearMessages: () => void;
  /** Clear orphaned tool calls (e.g. on cancel or stream error). */
  readonly clearActiveToolCalls: () => void;
  /** Load messages from a persisted session (e.g. JSONL restore). */
  readonly loadMessages: (messages: readonly ChatMessage[]) => void;
  readonly setAgentTerminated: (terminated: boolean) => void;
}

/** Enforce sliding window on messages array. */
function trimMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  if (messages.length <= MAX_SESSION_MESSAGES) return messages;
  return messages.slice(messages.length - MAX_SESSION_MESSAGES);
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  session: null,
  isStreaming: false,
  pendingText: "",
  activeToolCalls: {},
  error: null,
  lastUserMessage: null,
  agentTerminated: false,

  addMessage: (message) =>
    set((state) => ({
      messages: trimMessages([...state.messages, message]),
      lastUserMessage: message.kind === "user" ? message.text : state.lastUserMessage,
    })),

  appendTokens: (text) =>
    set((state) => ({
      pendingText: state.pendingText + text,
    })),

  flushTokens: () =>
    set((state) => {
      if (state.pendingText === "") return state;
      const message: ChatMessage = {
        kind: "assistant",
        text: state.pendingText,
        timestamp: Date.now(),
      };
      // If the last message is an assistant message from streaming,
      // merge into it instead of creating a new one
      const prev = state.messages[state.messages.length - 1];
      if (prev !== undefined && prev.kind === "assistant" && state.isStreaming) {
        const updated = [...state.messages];
        updated[updated.length - 1] = {
          kind: "assistant",
          text: prev.text + state.pendingText,
          timestamp: prev.timestamp,
        };
        return { messages: trimMessages(updated), pendingText: "" };
      }
      return {
        messages: trimMessages([...state.messages, message]),
        pendingText: "",
      };
    }),

  setStreaming: (isStreaming) => set({ isStreaming }),

  setSession: (session) =>
    set({
      session,
      messages: [],
      pendingText: "",
      activeToolCalls: {},
      error: null,
      isStreaming: false,
      lastUserMessage: null,
      // Note: agentTerminated is NOT reset here — the caller (ConsoleView)
      // should set it based on the agent's actual state after setSession().
    }),

  setError: (error) => set({ error }),

  startToolCall: (toolCallId, name) =>
    set((state) => ({
      activeToolCalls: {
        ...state.activeToolCalls,
        [toolCallId]: { name, args: "" },
      },
    })),

  appendToolCallArgs: (toolCallId, delta) =>
    set((state) => {
      const existing = state.activeToolCalls[toolCallId];
      if (existing === undefined) return state;
      return {
        activeToolCalls: {
          ...state.activeToolCalls,
          [toolCallId]: { ...existing, args: existing.args + delta },
        },
      };
    }),

  finishToolCall: (toolCallId, result) =>
    set((state) => {
      const tc = state.activeToolCalls[toolCallId];
      if (tc === undefined) return state;
      const { [toolCallId]: _, ...remaining } = state.activeToolCalls;
      const message: ChatMessage = {
        kind: "tool_call",
        name: tc.name,
        args: tc.args,
        result,
        timestamp: Date.now(),
      };
      return {
        activeToolCalls: remaining,
        messages: trimMessages([...state.messages, message]),
      };
    }),

  clearMessages: () => set({ messages: [], pendingText: "", activeToolCalls: {} }),

  clearActiveToolCalls: () => set({ activeToolCalls: {} }),

  loadMessages: (messages) =>
    set({ messages: trimMessages(messages), pendingText: "", activeToolCalls: {} }),

  setAgentTerminated: (terminated) => set({ agentTerminated: terminated }),
}));

// ─── Selectors ──────────────────────────────────────────────────────

/** Select messages for rendering (last N for windowed display). */
export function useRenderedMessages(): readonly ChatMessage[] {
  return useChatStore(useShallow((state) => state.messages.slice(-MAX_RENDERED_MESSAGES)));
}

/** Select whether the console is actively streaming. */
export function useChatIsStreaming(): boolean {
  return useChatStore((state) => state.isStreaming);
}

/** Select the current chat session. */
export function useChatSession(): ChatSession | null {
  return useChatStore((state) => state.session);
}

/** Select the current error message. */
export function useChatError(): string | null {
  return useChatStore((state) => state.error);
}

/** Select pending streaming text. */
export function usePendingText(): string {
  return useChatStore((state) => state.pendingText);
}

/** Select active tool calls for display. */
export function useActiveToolCalls(): Readonly<
  Record<string, { readonly name: string; readonly args: string }>
> {
  return useChatStore(useShallow((state) => state.activeToolCalls));
}

/** Select whether the agent has been terminated. */
export function useChatAgentTerminated(): boolean {
  return useChatStore((state) => state.agentTerminated);
}

/** Select last user message for retry capability. */
export function useLastUserMessage(): string | null {
  return useChatStore((state) => state.lastUserMessage);
}

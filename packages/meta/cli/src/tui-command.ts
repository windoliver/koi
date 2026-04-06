/**
 * `koi tui` command handler.
 *
 * Wires together the TUI application shell:
 *   store + permissionBridge + batcher → createTuiApp → handle.start()
 *
 * Engine wiring: creates a minimal EngineAdapter backed by the OpenAI-compat
 * model adapter and composes it through createRuntime for middleware support.
 *
 * Model config is read from environment variables:
 *   OPENROUTER_API_KEY — key for OpenRouter (default base URL: openrouter.ai)
 *   OPENAI_API_KEY     — key for OpenAI (default base URL: api.openai.com/v1)
 *   OPENAI_BASE_URL or OPENROUTER_BASE_URL — optional explicit override
 *   KOI_MODEL — optional, defaults to "google/gemini-2.0-flash-001"
 */

import type { ModelChunk } from "@koi/core";
import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core/engine";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { createRuntime } from "@koi/runtime";
import type { EventBatcher, TuiStore } from "@koi/tui";
import {
  createEventBatcher,
  createInitialState,
  createPermissionBridge,
  createStore,
  createTuiApp,
} from "@koi/tui";
import { SyntaxStyle } from "@opentui/core";
import type { TuiFlags } from "./args.js";

// ---------------------------------------------------------------------------
// Drain loop (exported for unit testing — Decision 4A from test review)
// ---------------------------------------------------------------------------

/**
 * Drain an async engine event stream into the store via the batcher.
 *
 * Sets connection status to "connected" before streaming, "disconnected" after.
 * On stream failure: dispatches add_error + disconnected (Decision 3A from code
 * quality review — error handling wraps the drain loop with try/catch/finally).
 *
 * Exported for testing. Not part of the public @koi/tui API.
 */
export async function drainEngineStream(
  stream: AsyncIterable<EngineEvent>,
  store: TuiStore,
  batcher: EventBatcher<EngineEvent>,
): Promise<void> {
  store.dispatch({ kind: "set_connection_status", status: "connected" });
  try {
    for await (const event of stream) {
      batcher.enqueue(event);
    }
    batcher.flushSync();
  } catch (e: unknown) {
    batcher.flushSync();
    store.dispatch({
      kind: "add_error",
      code: "ENGINE_ERROR",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    store.dispatch({ kind: "set_connection_status", status: "disconnected" });
  }
}

// ---------------------------------------------------------------------------
// Engine adapter (minimal streaming adapter backed by the model HTTP client)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "google/gemini-2.0-flash-001";

/** A single turn stored in the local conversation history. */
type HistoryEntry = {
  readonly content: ReadonlyArray<{ readonly kind: "text"; readonly text: string }>;
  readonly senderId: string;
  readonly timestamp: number;
};

/**
 * Build a minimal EngineAdapter whose `stream()` forwards text input to the
 * model and maps model chunks back to EngineEvents.
 *
 * The `history` array is mutated in-place by the adapter: each completed turn
 * appends user + assistant entries so subsequent turns include full context.
 * Callers should pass the same array for the lifetime of a session and reset
 * it (splice to length 0) when the user clears the conversation.
 *
 * Tool calls are not supported in this adapter (pass-through only). The
 * `terminals` field exposes the raw model call handlers so `createRuntime`
 * can compose middleware (event-trace, hooks, …) around them.
 */
function createTextEngineAdapter(modelName: string, history: HistoryEntry[]): EngineAdapter {
  return {
    engineId: "koi-tui",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      if (handlers?.modelStream === undefined) {
        throw new Error(
          "koi-tui adapter: no modelStream handler in callHandlers. " +
            "Ensure the adapter is wrapped via createRuntime with a model adapter.",
        );
      }

      const text = input.kind === "text" ? input.text : "";
      const userEntry: HistoryEntry = {
        content: [{ kind: "text", text }],
        senderId: "user",
        timestamp: Date.now(),
      };

      const modelReq = {
        // Replay full history then append the current user message
        messages: [...history, userEntry],
        model: modelName,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      };

      yield { kind: "turn_start", turnIndex: 0 };

      let inputTokens = 0;
      let outputTokens = 0;
      // `let` justified: accumulated across streaming chunks, read after loop
      let assistantText = "";

      // `let` justified: set in catch block, read after to emit interrupted terminal
      let wasAborted = false;

      try {
        for await (const chunk of handlers.modelStream(modelReq)) {
          const c = chunk as ModelChunk;
          switch (c.kind) {
            case "text_delta":
              assistantText += c.delta;
              yield c;
              break;
            case "thinking_delta":
              yield c;
              break;
            case "usage":
              inputTokens = c.inputTokens;
              outputTokens = c.outputTokens;
              break;
            case "done":
              if (c.response.usage !== undefined) {
                inputTokens = c.response.usage.inputTokens;
                outputTokens = c.response.usage.outputTokens;
              }
              break;
            case "error":
              throw new Error(c.message);
            case "tool_call_start":
            case "tool_call_delta":
            case "tool_call_end":
              // Tool calls are not yet supported in the TUI adapter
              break;
            default:
              break;
          }
        }
      } catch (e: unknown) {
        // Treat AbortError as a clean user cancellation — not an engine error.
        if (e instanceof Error && e.name === "AbortError") {
          wasAborted = true;
        } else {
          throw e;
        }
      }

      // Also catch late-abort: signal fired after the last chunk arrived.
      if (input.signal?.aborted === true) {
        wasAborted = true;
      }

      if (wasAborted) {
        // Do NOT persist partial turn — would replay cancelled content on next submit.
        yield { kind: "turn_end", turnIndex: 0 };
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason: "interrupted",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        };
        return;
      }

      // Persist the completed turn so the next submit sees full context.
      history.push(userEntry);
      if (assistantText !== "") {
        history.push({
          content: [{ kind: "text", text: assistantText }],
          senderId: "assistant",
          timestamp: Date.now(),
        });
      }

      yield { kind: "turn_end", turnIndex: 0 };
      yield {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: {
            totalTokens: inputTokens + outputTokens,
            inputTokens,
            outputTokens,
            turns: 1,
            durationMs: 0,
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function runTuiCommand(_flags: TuiFlags): Promise<void> {
  // TTY check first — same condition as createTuiApp so the error is consistent
  if (!process.stdout.isTTY) {
    process.stderr.write("error: koi tui requires a TTY (stdout is not a terminal)\n");
    process.exit(1);
  }

  // Resolve API key and pick the correct provider base URL.
  // OPENROUTER_API_KEY → OpenRouter (adapter default; no explicit baseUrl needed).
  // OPENAI_API_KEY only → OpenAI endpoint; supply base URL so the key is not
  // accidentally forwarded to OpenRouter and rejected.
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;
  const apiKey = openRouterKey ?? openAiKey;
  if (apiKey === undefined || apiKey === "") {
    process.stderr.write(
      "error: koi tui requires an API key.\n" +
        "  Set OPENROUTER_API_KEY or OPENAI_API_KEY in your environment or .env file.\n",
    );
    process.exit(1);
  }

  const modelName = process.env.KOI_MODEL ?? DEFAULT_MODEL;
  // Explicit env override takes precedence; otherwise derive from key source.
  const explicitBaseUrl = process.env.OPENAI_BASE_URL ?? process.env.OPENROUTER_BASE_URL;
  const providerDefaultUrl = openRouterKey !== undefined ? undefined : "https://api.openai.com/v1";
  const baseUrl = explicitBaseUrl ?? providerDefaultUrl;

  // Wire the model HTTP client as terminals on a real OpenAI-compat adapter,
  // then compose middleware via createRuntime.
  const modelAdapter = createOpenAICompatAdapter({
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    model: modelName,
  });

  // Conversation history — shared mutable array threaded through the adapter.
  // Cleared on agent:clear so the model starts a fresh context.
  // `let` justified: splice-reset on clear, reassignment avoided by using splice.
  const conversationHistory: HistoryEntry[] = [];

  // Wrap model adapter as engine adapter: exposes terminals so createRuntime
  // can compose middleware (event-trace, permissions, hooks) around them.
  const rawEngineAdapter: EngineAdapter = {
    ...createTextEngineAdapter(modelName, conversationHistory),
    terminals: {
      modelCall: modelAdapter.complete,
      modelStream: modelAdapter.stream,
    },
  };

  const runtime = createRuntime({ adapter: rawEngineAdapter });

  const store = createStore(createInitialState());
  const permissionBridge = createPermissionBridge({ store });

  // Flush callback extracted so it can be reused when recreating the batcher.
  const dispatchBatch = (batch: readonly EngineEvent[]): void => {
    for (const event of batch) {
      store.dispatch({ kind: "engine_event", event });
    }
  };

  // Event batcher: coalesces rapid engine events into 16ms flush windows
  // matching the OpenTUI render cadence (Decision 2A — direct stream path).
  // `let` justified: recreated on agent:clear to drop stale pre-clear events
  // (dispose() drops the buffer; the in-flight drainEngineStream still holds a
  // reference to the old disposed batcher, so its enqueue/flushSync are no-ops).
  let batcher = createEventBatcher<EngineEvent>(dispatchBatch);

  // `let` justified: set once after createTuiApp resolves, read in callbacks
  let appHandle: { readonly stop: () => Promise<void> } | null = null;
  // `let` justified: per-submit abort controller, replaced on each new stream
  let activeController: AbortController | null = null;

  const onInterrupt = (): void => {
    permissionBridge.dispose();
    activeController?.abort();
  };

  const result = createTuiApp({
    store,
    permissionBridge,
    onCommand: (commandId: string): void => {
      switch (commandId) {
        case "agent:interrupt":
          onInterrupt();
          break;
        case "agent:clear":
          // Abort the in-flight stream and drop its buffered events atomically.
          // Dispose drops the buffer without flushing; drainEngineStream still
          // holds the old disposed batcher ref, so its later enqueue/flushSync
          // are no-ops. The new batcher receives only post-clear events.
          // Null activeController immediately so a fresh submit is unblocked
          // even if the aborted stream's finally-cleanup settles late.
          activeController?.abort();
          activeController = null;
          batcher.dispose();
          batcher = createEventBatcher<EngineEvent>(dispatchBatch);
          store.dispatch({ kind: "clear_messages" });
          conversationHistory.splice(0);
          break;
        case "system:quit":
          void appHandle?.stop().then(() => {
            batcher.dispose();
            void runtime.dispose().then(() => process.exit(0));
          });
          break;
        case "session:new":
          // Same as agent:clear — reset state and start fresh.
          // Null activeController immediately (same reasoning as agent:clear above).
          activeController?.abort();
          activeController = null;
          batcher.dispose();
          batcher = createEventBatcher<EngineEvent>(dispatchBatch);
          store.dispatch({ kind: "clear_messages" });
          conversationHistory.splice(0);
          break;
        default:
          // Surface unimplemented commands explicitly rather than silently no-oping.
          store.dispatch({
            kind: "add_error",
            code: "COMMAND_NOT_IMPLEMENTED",
            message: `'${commandId}' is not yet available.`,
          });
          break;
      }
    },
    onSessionSelect: (_sessionId: string): void => {
      // Session persistence is not yet implemented. Fail closed: abort any
      // in-flight stream, clear all state (messages + history), and return to
      // the conversation view — identical to agent:clear so no stale context
      // leaks into what the user believes is a fresh session.
      activeController?.abort();
      activeController = null;
      batcher.dispose();
      batcher = createEventBatcher<EngineEvent>(dispatchBatch);
      store.dispatch({ kind: "clear_messages" });
      conversationHistory.splice(0);
      store.dispatch({ kind: "set_view", view: "conversation" });
      store.dispatch({
        kind: "add_error",
        code: "SESSIONS_NOT_IMPLEMENTED",
        message: "Session resume is not yet available. Starting a new conversation.",
      });
    },
    // syntaxStyle enables JSON highlighting in tool call blocks (<code> path).
    // TextBlock also receives syntaxStyle but falls back to <text> since
    // treeSitterClient is not wired yet — prose renders correctly. See #1542.
    syntaxStyle: SyntaxStyle.create(),
    onSubmit: async (text: string): Promise<void> => {
      // Guard against overlapping submits: reject while a stream is in flight.
      // The user can Ctrl+C (agent:interrupt) to abort the active stream first.
      if (activeController !== null) {
        store.dispatch({
          kind: "add_error",
          code: "SUBMIT_IN_PROGRESS",
          message: "A response is already streaming. Press Ctrl+C to interrupt it first.",
        });
        return;
      }

      store.dispatch({
        kind: "add_user_message",
        id: `user-${Date.now()}`,
        blocks: [{ kind: "text", text }],
      });

      const controller = new AbortController();
      activeController = controller;
      try {
        const stream = runtime.adapter.stream({
          kind: "text",
          text,
          signal: controller.signal,
        });
        await drainEngineStream(stream, store, batcher);
      } finally {
        if (activeController === controller) {
          activeController = null;
        }
      }
    },
    onInterrupt,
  });

  if (!result.ok) {
    process.stderr.write("error: koi tui requires a TTY (stdout is not a terminal)\n");
    process.exit(1);
  }

  appHandle = result.value;

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = (): void => {
    void result.value.stop().then(() => {
      batcher.dispose();
      void runtime.dispose().then(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await result.value.start();
  // Block until stop() completes (SIGINT/SIGTERM/quit command all call stop()
  // and then process.exit — done() resolves right before that exit).
  await result.value.done();
}

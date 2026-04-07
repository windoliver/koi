/**
 * `koi tui` command handler.
 *
 * Wires the TUI application shell:
 *   store + permissionBridge + batcher → createTuiApp → handle.start()
 *
 * Architecture note: this command does NOT route through createKoi / createCliHarness.
 * The TUI owns the full terminal UX including the input box (TUI-owns-UX model),
 * while the harness is designed for the CLI model where the channel handles input
 * and an optional TuiAdapter is a pure renderer. Bridging these two models
 * (implementing TuiAdapter on createTuiApp) is a future issue.
 *
 * Model config is read from environment variables (see env.ts for resolution order):
 *   OPENROUTER_API_KEY — key for OpenRouter (default provider)
 *   OPENAI_API_KEY     — key for OpenAI (injects api.openai.com/v1)
 *   OPENAI_BASE_URL or OPENROUTER_BASE_URL — explicit base URL override
 *   KOI_MODEL — model name override (default: google/gemini-2.0-flash-001)
 *
 * Sessions are recorded to JSONL transcripts at ~/.koi/sessions/<sessionId>.jsonl.
 * The session ID is generated once per TUI process launch; agent:clear / session:new
 * resets the conversation history but continues writing to the same transcript file.
 *
 * Tools wired:
 *   Glob, Grep           — codebase search (cwd-rooted)
 *   web_fetch            — HTTP fetch via @koi/tools-web
 *   Bash                 — shell execution via @koi/tools-bash
 *   fs_read/write/edit   — filesystem via createRuntime({ filesystem })
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  InboundMessage,
  SessionTranscript,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, sessionId } from "@koi/core";
import { createSystemPromptMiddleware } from "@koi/engine";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { runTurn } from "@koi/query-engine";
import { createRuntime, createToolDispatcher } from "@koi/runtime";
import {
  createJsonlTranscript,
  createSessionTranscriptMiddleware,
  resumeForSession,
} from "@koi/session";
import { createBashTool } from "@koi/tools-bash";
import { createGlobTool, createGrepTool } from "@koi/tools-builtin";
import { createWebExecutor, createWebFetchTool } from "@koi/tools-web";
import type { EventBatcher, SessionSummary, TuiStore } from "@koi/tui";
import {
  createEventBatcher,
  createInitialState,
  createPermissionBridge,
  createStore,
  createTuiApp,
} from "@koi/tui";
import { SyntaxStyle } from "@opentui/core";
import type { TuiFlags } from "./args.js";
import { resolveApiConfig } from "./env.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 10;
/**
 * Default system prompt for the TUI agent.
 * Tells the model it has tools available and should use them.
 * Without this, models (especially Gemini) default to chatbot mode and
 * refuse tool use even when tools are wired in the API request.
 */
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI coding assistant with access to tools. " +
  "Use your available tools (Bash for shell commands, Glob/Grep for search, " +
  "fs_read/fs_write/fs_edit for files, web_fetch for HTTP) to complete tasks. " +
  "Always prefer using tools to gather accurate real-time information rather than " +
  "answering from memory.";
/**
 * Maximum number of transcript messages sent in each model request.
 * Caps context window to control token costs in long sessions.
 * Matches the default for `koi start --context-window`.
 */
const MAX_TRANSCRIPT_MESSAGES = 100;
/** JSONL transcript files are stored at ~/.koi/sessions/<sessionId>.jsonl */
const SESSIONS_DIR = join(homedir(), ".koi", "sessions");
/** Maximum characters for session name (first user message) in session picker. */
const SESSION_NAME_MAX = 60;
/** Maximum characters for session preview (last message) in session picker. */
const SESSION_PREVIEW_MAX = 80;

// ---------------------------------------------------------------------------
// Session list loader
// ---------------------------------------------------------------------------

/**
 * Scan the sessions directory and build SessionSummary entries for the TUI
 * session picker. Returns an empty list if the directory doesn't exist yet.
 *
 * Uses the same jsonlTranscript instance as the running TUI so no extra
 * file handles are opened.
 */
async function loadSessionList(
  sessionsDir: string,
  transcript: SessionTranscript,
): Promise<readonly SessionSummary[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    // Dir not created yet — no sessions to show.
    return [];
  }

  const summaries = await Promise.all(
    files
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (file): Promise<SessionSummary | null> => {
        const id = file.slice(0, -".jsonl".length);
        const result = await transcript.load(sessionId(id));
        if (!result.ok || result.value.entries.length === 0) return null;

        const entries = result.value.entries;
        const lastEntry = entries.at(-1);
        const firstUserEntry = entries.find((e) => e.role === "user");

        if (lastEntry === undefined) return null;

        const name =
          firstUserEntry !== undefined
            ? firstUserEntry.content.slice(0, SESSION_NAME_MAX)
            : new Date(entries[0]?.timestamp ?? Date.now()).toLocaleString();

        return {
          id,
          name,
          lastActivityAt: lastEntry.timestamp,
          messageCount: entries.length,
          preview: lastEntry.content.slice(0, SESSION_PREVIEW_MAX),
        };
      }),
  );

  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

// ---------------------------------------------------------------------------
// Drain loop (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Drain an async engine event stream into the store via the batcher.
 *
 * Sets connection status to "connected" before streaming, "disconnected" after.
 * On stream failure: dispatches add_error + disconnected.
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
// Command handler
// ---------------------------------------------------------------------------

/**
 * `koi tui` — launch the full-screen TUI.
 *
 * See architecture note at top of file for why this bypasses createKoi/harness.
 */
export async function runTuiCommand(_flags: TuiFlags): Promise<void> {
  // TTY check first — createTuiApp will also check, but early exit gives a
  // cleaner error before any setup allocations.
  if (!process.stdout.isTTY) {
    process.stderr.write("error: koi tui requires a TTY (stdout is not a terminal)\n");
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 1. API configuration
  // ---------------------------------------------------------------------------

  const apiConfigResult = resolveApiConfig();
  if (!apiConfigResult.ok) {
    process.stderr.write(`error: koi tui requires an API key.\n  ${apiConfigResult.error}\n`);
    process.exit(1);
  }
  const { apiKey, baseUrl, model: modelName } = apiConfigResult.value;

  // ---------------------------------------------------------------------------
  // 2. Engine adapter — model→tool→model loop via runTurn
  // ---------------------------------------------------------------------------

  // Mutable conversation history shared across all stream() calls for this session.
  // Cleared on agent:clear / session:new via resetConversation().
  // let: justified — splice-reset on clear, never replaced
  const conversationHistory: InboundMessage[] = [];

  const modelAdapter = createOpenAICompatAdapter({
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    model: modelName,
  });

  // Build search, web, and bash tool instances.
  // fs_read/write/edit are handled by createRuntime({ filesystem }) below.
  const cwd = process.cwd();
  const globTool = createGlobTool({ cwd });
  const grepTool = createGrepTool({ cwd });
  const webExecutor = createWebExecutor({ allowHttps: true });
  const webFetchTool = createWebFetchTool(webExecutor, "web", DEFAULT_UNSANDBOXED_POLICY);
  const bashTool = createBashTool({ workspaceRoot: cwd });

  // Inline tool registry for the toolCall terminal.
  // fs tools are not in this map — createRuntime wraps them on top via its
  // own createToolDispatcher(fsToolMap, rawAdapter.terminals.toolCall) chain.
  const localTools: ReadonlyMap<string, Tool> = new Map<string, Tool>([
    [globTool.descriptor.name, globTool],
    [grepTool.descriptor.name, grepTool],
    [webFetchTool.descriptor.name, webFetchTool],
    [bashTool.descriptor.name, bashTool],
  ]);

  const localToolDescriptors: readonly ToolDescriptor[] = [
    globTool.descriptor,
    grepTool.descriptor,
    webFetchTool.descriptor,
    bashTool.descriptor,
  ];

  const rawEngineAdapter: EngineAdapter = {
    engineId: "koi-tui",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelAdapter.complete,
      modelStream: modelAdapter.stream,
      // Route tool calls to the local registry.
      // createRuntime stacks fs tools on top of this via createToolDispatcher(fsMap, this).
      toolCall: createToolDispatcher(localTools),
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      if (handlers === undefined) {
        throw new Error(
          "koi-tui adapter: callHandlers required. " +
            "Ensure the adapter is wrapped via createRuntime.",
        );
      }
      const text = input.kind === "text" ? input.text : "";
      const stagedUserMsg: InboundMessage = {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text }],
      };

      let deltaText = "";
      let doneContentText = "";
      // Cap context window to MAX_TRANSCRIPT_MESSAGES to control token costs.
      const contextWindow = [...conversationHistory.slice(-MAX_TRANSCRIPT_MESSAGES), stagedUserMsg];

      return (async function* (): AsyncIterable<EngineEvent> {
        for await (const event of runTurn({
          callHandlers: handlers,
          messages: contextWindow,
          signal: input.signal,
          maxTurns: DEFAULT_MAX_TURNS,
        })) {
          yield event;
          if (event.kind === "text_delta") {
            deltaText += event.delta;
          }
          if (event.kind === "done") {
            doneContentText = event.output.content
              .filter((b) => b.kind === "text")
              .map((b) => (b as { readonly kind: "text"; readonly text: string }).text)
              .join("");
            // Only persist completed turns — aborted/failed turns must not leave
            // orphaned user prompts in history.
            if (event.output.stopReason === "completed") {
              const assistantText = doneContentText.length > 0 ? doneContentText : deltaText;
              conversationHistory.push(stagedUserMsg);
              if (assistantText.length > 0) {
                conversationHistory.push({
                  senderId: "assistant",
                  timestamp: Date.now(),
                  content: [{ kind: "text", text: assistantText }],
                });
              }
            }
          }
        }
      })();
    },
  };

  // One session ID per TUI process launch. agent:clear / session:new reset the
  // conversation history but continue writing to the same transcript file — the
  // JSONL is a journal of everything that happened in this TUI invocation.
  const tuiSessionId = sessionId(crypto.randomUUID());
  const jsonlTranscript = createJsonlTranscript({ baseDir: SESSIONS_DIR });

  const runtime = createRuntime({
    adapter: rawEngineAdapter,
    middleware: [
      createSessionTranscriptMiddleware({ transcript: jsonlTranscript, sessionId: tuiSessionId }),
      createSystemPromptMiddleware(DEFAULT_SYSTEM_PROMPT),
    ],
    // Wire fs_read, fs_write, fs_edit via the meta-runtime filesystem facility.
    // createRuntime stacks these on top of rawEngineAdapter.terminals.toolCall
    // via createToolDispatcher(fsToolMap, rawAdapter.terminals.toolCall).
    filesystem: { backend: "local", operations: ["read", "write", "edit"] },
    cwd,
    // Advertise local tools to the model (fs tools are added by createRuntime internally).
    toolDescriptors: localToolDescriptors,
    // Local TUI runs on the user's machine — no exfiltration risk.
    exfiltrationGuard: false,
  });

  // ---------------------------------------------------------------------------
  // 3. TUI state setup
  // ---------------------------------------------------------------------------

  const store = createStore(createInitialState());
  const permissionBridge = createPermissionBridge({ store });

  // Flush callback extracted so it can be reused when recreating the batcher.
  const dispatchBatch = (batch: readonly EngineEvent[]): void => {
    for (const event of batch) {
      store.dispatch({ kind: "engine_event", event });
    }
  };

  // Event batcher: coalesces rapid engine events into 16ms flush windows
  // matching the OpenTUI render cadence.
  // let: justified — recreated on resetConversation() to drop stale pre-clear events
  let batcher = createEventBatcher<EngineEvent>(dispatchBatch);

  // let: set once after createTuiApp resolves, read in shutdown
  let appHandle: { readonly stop: () => Promise<void> } | null = null;
  // let: per-submit abort controller, replaced on each new stream
  let activeController: AbortController | null = null;

  // ---------------------------------------------------------------------------
  // 4. Helpers
  // ---------------------------------------------------------------------------

  const onInterrupt = (): void => {
    permissionBridge.dispose();
    activeController?.abort();
  };

  /**
   * Reset conversation state: abort in-flight stream, drop stale buffered events,
   * clear store messages, and wipe conversation history.
   *
   * Used by agent:clear, session:new, and onSessionSelect.
   * Null activeController immediately so a fresh submit is unblocked
   * even if the aborted stream's finally-cleanup settles late.
   */
  const resetConversation = (): void => {
    activeController?.abort();
    activeController = null;
    // dispose() drops the buffer without flushing — the in-flight drainEngineStream
    // still holds the old batcher ref, so its later enqueue/flushSync are no-ops.
    batcher.dispose();
    batcher = createEventBatcher<EngineEvent>(dispatchBatch);
    store.dispatch({ kind: "clear_messages" });
    conversationHistory.splice(0);
  };

  // Idempotent shutdown — called by both system:quit and signal handlers.
  // let: justified — set once on first shutdown call
  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await appHandle?.stop();
      batcher.dispose();
      await runtime.dispose();
    } finally {
      process.exit(0);
    }
  };

  // ---------------------------------------------------------------------------
  // 5. Create TUI app
  // ---------------------------------------------------------------------------

  const result = createTuiApp({
    store,
    permissionBridge,
    onCommand: (commandId: string): void => {
      switch (commandId) {
        case "agent:interrupt":
          onInterrupt();
          break;
        case "agent:clear":
          resetConversation();
          break;
        case "system:quit":
          void shutdown();
          break;
        case "session:new":
          resetConversation();
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
    onSessionSelect: (selectedId: string): void => {
      // Abort any in-flight stream, clear the display, and wipe history so no
      // stale context leaks into the resumed session.
      resetConversation();
      store.dispatch({ kind: "set_view", view: "conversation" });

      void (async (): Promise<void> => {
        store.dispatch({ kind: "set_connection_status", status: "connected" });
        try {
          const resumeResult = await resumeForSession(sessionId(selectedId), jsonlTranscript);
          if (!resumeResult.ok) {
            store.dispatch({
              kind: "add_error",
              code: "SESSION_RESUME_ERROR",
              message: `Could not load session: ${resumeResult.error.message}`,
            });
            return;
          }
          // Pre-populate conversation history so the AI has full context.
          for (const msg of resumeResult.value.messages) {
            conversationHistory.push(msg);
          }
          // Replay messages into the TUI store so the user sees the prior
          // conversation. Tool entries are skipped (display-only limitation).
          store.dispatch({
            kind: "load_history",
            messages: resumeResult.value.messages,
          });
        } finally {
          store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        }
      })();
    },
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
    process.stderr.write(`error: koi tui failed to start (${result.error.kind})\n`);
    process.exit(1);
  }

  appHandle = result.value;

  // ---------------------------------------------------------------------------
  // 6. Signal handling and start
  // ---------------------------------------------------------------------------

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await result.value.start();

  // Load saved sessions in the background after the TUI is rendering.
  // Fire-and-forget: failures are silently swallowed (non-critical feature).
  void loadSessionList(SESSIONS_DIR, jsonlTranscript).then((sessions) => {
    store.dispatch({ kind: "set_session_list", sessions });
  });
  // Block until stop() completes (SIGINT/SIGTERM/quit command all call stop()
  // and then process.exit — done() resolves right before that exit).
  await result.value.done();
}

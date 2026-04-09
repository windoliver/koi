/**
 * `koi tui` command handler.
 *
 * Wires the TUI application shell:
 *   store + permissionBridge + batcher → createTuiApp → handle.start()
 *
 * Runtime assembly is delegated to createTuiRuntime() (tui-runtime.ts) which
 * wires the full L2 tool stack via createKoi. This command owns the TUI UX:
 * store, event batching, session management, signal handling.
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
 * Tools wired (via createTuiRuntime):
 *   Glob, Grep, ToolSearch — codebase search (cwd-rooted)
 *   web_fetch              — HTTP fetch via @koi/tools-web
 *   Bash, bash_background  — shell execution via @koi/tools-bash
 *   fs_read/write/edit     — filesystem via @koi/fs-local
 *   task_*                 — background task management via @koi/task-tools
 *   agent_spawn — real spawning via createSpawnToolProvider (#1582 wired)
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, RichTrajectoryStep, SessionTranscript } from "@koi/core";
import { sessionId } from "@koi/core";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { createJsonlTranscript, resumeForSession } from "@koi/session";
import { createSkillsRuntime } from "@koi/skills-runtime";
import type { EventBatcher, SessionSummary, TrajectoryStepSummary, TuiStore } from "@koi/tui";
import {
  createEventBatcher,
  createInitialState,
  createPermissionBridge,
  createStore,
  createTuiApp,
} from "@koi/tui";
import { getTreeSitterClient, SyntaxStyle } from "@opentui/core";
import type { TuiFlags } from "./args.js";
import { resolveApiConfig } from "./env.js";
import type { TuiRuntimeHandle } from "./tui-runtime.js";
import { createTuiRuntime } from "./tui-runtime.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  "answering from memory.\n\n" +
  "Use TodoWrite to track your progress across multi-step tasks.";
/** JSONL transcript files are stored at ~/.koi/sessions/<sessionId>.jsonl */
const SESSIONS_DIR = join(homedir(), ".koi", "sessions");
/** Maximum characters for session name (first user message) in session picker. */
const SESSION_NAME_MAX = 60;
/** Maximum characters for session preview (last message) in session picker. */
const SESSION_PREVIEW_MAX = 80;

// ---------------------------------------------------------------------------
// Trajectory step mapping
// ---------------------------------------------------------------------------

/** Annotate tool identifier with sandbox status when visible in response. */
function annotateSandboxed(step: RichTrajectoryStep): string {
  if (step.kind === "tool_call" && step.response?.text?.includes('"sandboxed":true')) {
    return `${step.identifier} (sandboxed)`;
  }
  return step.identifier;
}

/** Map rich trajectory steps to TUI summaries with content for expandable detail. */
function mapTrajectorySteps(
  steps: readonly RichTrajectoryStep[],
): readonly TrajectoryStepSummary[] {
  return steps.map((step) => ({
    stepIndex: step.stepIndex,
    kind: step.kind,
    identifier: annotateSandboxed(step),
    durationMs: step.durationMs,
    outcome: step.outcome,
    timestamp: step.timestamp,
    requestText: step.request?.text,
    responseText: step.response?.text,
    errorText: step.error?.text,
    tokens:
      step.metrics !== undefined
        ? {
            promptTokens: step.metrics.promptTokens,
            completionTokens: step.metrics.completionTokens,
            cachedTokens: step.metrics.cachedTokens,
          }
        : undefined,
    middlewareSpan:
      step.metadata !== undefined && step.metadata.type === "middleware_span"
        ? {
            hook: step.metadata.hook as string | undefined,
            phase: step.metadata.phase as string | undefined,
            nextCalled: step.metadata.nextCalled as boolean | undefined,
          }
        : undefined,
  }));
}

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
    // `let` justified: tracks last yield time for frame-rate-limited yielding
    let lastYieldAt = Date.now();
    for await (const event of stream) {
      batcher.enqueue(event);
      // Yield to the event loop at most once per frame (~16ms) during any
      // consumer-visible streaming event so OpenTUI can paint progressively.
      //
      // Without yielding, HTTP response body chunks contain many SSE events
      // which are all consumed synchronously, starving the render loop.
      // This covers text_delta, thinking_delta, and tool_call lifecycle —
      // not just text — so the thinking spinner and tool status animate
      // during tool-first or reasoning-first turns.
      if (
        event.kind === "text_delta" ||
        event.kind === "thinking_delta" ||
        event.kind === "tool_call_start" ||
        event.kind === "tool_call_delta" ||
        event.kind === "tool_call_end"
      ) {
        const now = Date.now();
        if (now - lastYieldAt >= 16) {
          batcher.flushSync();
          await new Promise<void>((r) => setTimeout(r, 0));
          lastYieldAt = Date.now();
        }
      }
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
 * Architecture: the TUI owns the full terminal UX (input box, store, events).
 * Runtime assembly (tools, middleware, providers) is delegated to createTuiRuntime().
 * The conversation loop is driven by KoiRuntime.run() from @koi/engine.
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

  const modelAdapter = createOpenAICompatAdapter({
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    model: modelName,
  });

  // ---------------------------------------------------------------------------
  // 2. TUI state setup (P2-A: show TUI immediately, before runtime assembly)
  // ---------------------------------------------------------------------------

  const store = createStore(createInitialState());
  const permissionBridge = createPermissionBridge({ store });

  // Flush callback: reduces entire batch in one pass, single notification.
  // Avoids N state updates + N signal invalidations per 16ms flush window.
  const dispatchBatch = (batch: readonly EngineEvent[]): void => {
    store.dispatchBatch(batch.map((event) => ({ kind: "engine_event" as const, event })));
  };

  // Event batcher: coalesces rapid engine events into 16ms flush windows
  // matching the OpenTUI render cadence.
  // let: justified — recreated on resetConversation() to drop stale pre-clear events
  let batcher = createEventBatcher<EngineEvent>(dispatchBatch);

  // One session ID per TUI process launch. agent:clear / session:new reset the
  // conversation history but continue writing to the same transcript file — the
  // JSONL is a journal of everything that happened in this TUI invocation.
  const tuiSessionId = sessionId(crypto.randomUUID());
  const jsonlTranscript = createJsonlTranscript({ baseDir: SESSIONS_DIR });

  // ---------------------------------------------------------------------------
  // 3. Assemble runtime (A1-A: delegate to createTuiRuntime)
  // ---------------------------------------------------------------------------

  // --- Load skills before runtime creation (same as koi start on main) ---
  // Skills prepend project/user workflow rules to the system prompt.
  const skillRuntime = createSkillsRuntime();
  const skillContent = await (async (): Promise<string> => {
    const outer = await skillRuntime.loadAll();
    if (!outer.ok) return "";
    const parts: string[] = [];
    for (const [, result] of outer.value) {
      if (result.ok) parts.push(result.value.body);
    }
    return parts.sort().join("\n\n---\n\n");
  })();
  const systemPrompt =
    skillContent.length > 0 ? `${skillContent}\n\n${DEFAULT_SYSTEM_PROMPT}` : DEFAULT_SYSTEM_PROMPT;

  // Runtime assembly happens in parallel with TUI rendering (P2-A).
  // The runtimeReady promise resolves before the first submit.
  // let: set once when the promise resolves
  let runtimeHandle: TuiRuntimeHandle | null = null;
  const runtimeReady = createTuiRuntime({
    modelAdapter,
    modelName,
    approvalHandler: permissionBridge.handler,
    cwd: process.cwd(),
    systemPrompt,
    session: { transcript: jsonlTranscript, sessionId: tuiSessionId },
    // Bridge spawn lifecycle events into the TUI store so /agents view and
    // inline spawn_call blocks reflect real spawn state. Each spawn call
    // produces one spawn_requested + one agent_status_changed event.
    onSpawnEvent: (event): void => {
      if (event.kind === "spawn_requested") {
        store.dispatch({
          kind: "engine_event",
          event: {
            kind: "spawn_requested",
            childAgentId: event.agentId as unknown as import("@koi/core").AgentId,
            request: {
              agentName: event.agentName,
              description: event.description,
              signal: new AbortController().signal,
            },
          },
        });
      } else {
        // agent_status_changed: use the dedicated set_spawn_terminal action so the
        // outcome (complete vs failed) is preserved. The engine's ProcessState only
        // has a single "terminated" value — routing through that path would collapse
        // failures into successes.
        const outcome: "complete" | "failed" = event.status === "failed" ? "failed" : "complete";
        store.dispatch({
          kind: "set_spawn_terminal",
          agentId: event.agentId,
          outcome,
        });
      }
    },
  }).then((handle) => {
    runtimeHandle = handle;
    return handle;
  });

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
   * clear store messages, reset runtime session state, and wipe transcript.
   *
   * Used by agent:clear, session:new, and onSessionSelect.
   */
  // Promise that resolves when session reset is complete. New submits block on
  // this to prevent hitting stale task board / trajectory state.
  // let: justified — replaced on each reset
  let resetBarrier: Promise<void> = Promise.resolve();

  const resetConversation = (): void => {
    // Abort the active controller first — C4-A ordering constraint requires
    // signal.aborted === true before calling resetSessionState().
    activeController?.abort();
    activeController = null;

    // dispose() drops the buffer without flushing — the in-flight drainEngineStream
    // still holds the old batcher ref, so its later enqueue/flushSync are no-ops.
    batcher.dispose();
    batcher = createEventBatcher<EngineEvent>(dispatchBatch);
    store.dispatch({ kind: "clear_messages" });
    // Clear trajectory data so /trajectory doesn't show prior-session data.
    store.dispatch({ kind: "set_trajectory_data", steps: [] });

    // Always reset runtime session state — even in the idle case (no active stream).
    // resetSessionState is async (awaits task board + trajectory prune).
    // New submits block on resetBarrier before proceeding.
    if (runtimeHandle !== null) {
      const idleController = new AbortController();
      idleController.abort();
      resetBarrier = runtimeHandle.resetSessionState(idleController.signal).then(() => {
        runtimeHandle?.transcript.splice(0);
      });
    }
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
      if (runtimeHandle !== null) {
        const hadLiveTasks = runtimeHandle.shutdownBackgroundTasks();
        // Wait for SIGTERM→SIGKILL escalation window so stubborn subprocesses
        // are killed before we exit. Without this, children that ignore SIGTERM
        // outlive the TUI as orphans. SIGKILL_ESCALATION_MS = 3000.
        if (hadLiveTasks) {
          await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
        }
        await runtimeHandle.runtime.dispose();
      }
    } finally {
      process.exit(0);
    }
  };

  // ---------------------------------------------------------------------------
  // 5. Initialize tree-sitter for markdown rendering
  // ---------------------------------------------------------------------------

  const treeSitterClient = getTreeSitterClient();
  await treeSitterClient.initialize();

  // ---------------------------------------------------------------------------
  // 6. Create TUI app
  // ---------------------------------------------------------------------------

  // #11: pending image attachments collected from InputArea paste events.
  // Flushed into the next onSubmit() as image ContentBlocks alongside the text.
  // let: mutable — grows on onImageAttach, cleared on submit
  let pendingImages: Array<{ readonly url: string; readonly mime: string }> = [];

  // #16: turn-complete notification — BEL (0x07) when terminal is not focused.
  // OpenTUI doesn't expose focus state; we emit BEL unconditionally. Most
  // terminals only signal (visual/audible bell) when the window isn't focused.
  const handleTurnComplete = (): void => {
    if (process.stdout.isTTY) {
      process.stdout.write("\x07");
    }
  };

  // #13: session fork — snapshot the current conversation to a NEW session file.
  // The user's current session continues uninterrupted; the fork creates a
  // resumable checkpoint at the current turn that can be resumed via the session
  // picker. No context is lost — the active session stays on its own track.
  const handleFork = (): void => {
    void (async (): Promise<void> => {
      if (runtimeHandle === null) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_NOT_READY",
          message: "Cannot fork: runtime not yet initialized.",
        });
        return;
      }

      // Snapshot the current transcript as TranscriptEntry list. The runtime's
      // `transcript` array holds InboundMessage[] (the live context window);
      // we load the durable entries from the JSONL file for a complete copy.
      //
      // IMPORTANT: load from runtime.sessionId, NOT tuiSessionId. The session
      // middleware uses ctx.session.sessionId (= runtime's internal factory
      // sessionId) to route transcript writes. tuiSessionId is a separate
      // identifier that no file is keyed by.
      const activeSessionId = sessionId(runtimeHandle.runtime.sessionId);
      const loadResult = await jsonlTranscript.load(activeSessionId);
      if (!loadResult.ok) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_LOAD_ERROR",
          message: `Cannot fork: failed to read current session — ${loadResult.error.message}`,
        });
        return;
      }

      const forkedSessionId = sessionId(crypto.randomUUID());
      const appendResult = await jsonlTranscript.append(forkedSessionId, loadResult.value.entries);
      if (!appendResult.ok) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_WRITE_ERROR",
          message: `Cannot fork: failed to write forked session — ${appendResult.error.message}`,
        });
        return;
      }

      // Refresh session list so the new forked session shows up in the picker.
      void loadSessionList(SESSIONS_DIR, jsonlTranscript).then((sessions) => {
        store.dispatch({ kind: "set_session_list", sessions });
      });

      // Notify the user that the fork was created. They can resume it via
      // the session picker (Ctrl+P → Sessions → pick the new one).
      store.dispatch({
        kind: "add_user_message",
        id: `fork-notice-${Date.now()}`,
        blocks: [
          {
            kind: "text",
            text: `[Forked session ${forkedSessionId.slice(0, 8)}… — resume via Sessions view]`,
          },
        ],
      });
    })();
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
          // Ensure runtime is ready AND prior reset is complete before hydrating.
          // Without awaiting resetBarrier, the async transcript.splice(0) from
          // resetConversation() can wipe the just-loaded history.
          if (runtimeHandle === null) {
            await runtimeReady;
          }
          await resetBarrier;
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
          if (runtimeHandle !== null) {
            for (const msg of resumeResult.value.messages) {
              runtimeHandle.transcript.push(msg);
            }
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
    treeSitterClient,
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

      // P2-A: block on runtime assembly if not yet ready.
      // First submit waits for createTuiRuntime to complete; subsequent
      // submits use the cached runtimeHandle (already resolved).
      if (runtimeHandle === null) {
        try {
          await runtimeReady;
        } catch (e: unknown) {
          store.dispatch({
            kind: "add_error",
            code: "RUNTIME_INIT_ERROR",
            message: `Runtime failed to initialize: ${e instanceof Error ? e.message : String(e)}`,
          });
          return;
        }
      }

      // runtimeHandle is guaranteed non-null after runtimeReady resolves.
      // The await above sets runtimeHandle; if it threw, we returned early.
      if (runtimeHandle === null) return;
      const handle = runtimeHandle;

      // Wait for any pending session reset to complete before submitting.
      // Prevents hitting stale task board or trajectory state.
      await resetBarrier;

      // #11: include any pending clipboard images as image ContentBlocks
      // alongside the text. Bridge clears pendingImages after dispatch so the
      // next submit starts with an empty list.
      const imageBlocks = pendingImages.map((img) => ({
        kind: "image" as const,
        url: img.url,
      }));
      pendingImages = [];
      store.dispatch({
        kind: "add_user_message",
        id: `user-${Date.now()}`,
        blocks: [{ kind: "text", text }, ...imageBlocks],
      });

      const controller = new AbortController();
      activeController = controller;
      try {
        // A2-A: drive conversation via runtime.run() — the KoiRuntime handles
        // middleware composition, tool dispatch, and transcript management.
        const stream = handle.runtime.run({
          kind: "text",
          text,
          signal: controller.signal,
        });
        await drainEngineStream(stream, store, batcher);

        // Refresh trajectory data after each turn so /trajectory view is current.
        // Delay 100ms to let fire-and-forget trace-wrapper appends settle —
        // wrapMiddlewareWithTrace records MW spans asynchronously via
        // void store.append(...). Without the delay, getTrajectorySteps()
        // reads before all spans are written.
        void new Promise<void>((resolve) => setTimeout(resolve, 500))
          .then(() => handle.getTrajectorySteps())
          .then((steps) => {
            store.dispatch({
              kind: "set_trajectory_data",
              steps: mapTrajectorySteps(steps),
            });
          });
      } finally {
        if (activeController === controller) {
          activeController = null;
        }
      }
    },
    onInterrupt,
    // #13: session fork — called from command palette "Fork session"
    onFork: handleFork,
    // #11: image paste — InputArea collects images and calls this per paste
    onImageAttach: (image) => {
      pendingImages.push(image);
    },
    // #16: turn-complete notification
    onTurnComplete: handleTurnComplete,
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

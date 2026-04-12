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
 *   KOI_MODEL          — model name override (default: anthropic/claude-sonnet-4-6)
 *   KOI_FALLBACK_MODEL — comma-separated fallback models; enables model-router
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
import { createArgvGate, type LoopRuntime, runUntilPass } from "@koi/loop";
import { createApprovalStore } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import {
  createModelRouter,
  createModelRouterMiddleware,
  validateRouterConfig,
} from "@koi/model-router";
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
import { scrubSensitiveEnv } from "./commands/start.js";
import { resolveApiConfig } from "./env.js";
import { createSigintHandler, createUnrefTimer } from "./sigint-handler.js";
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
  signal?: AbortSignal,
): Promise<void> {
  store.dispatch({ kind: "set_connection_status", status: "connected" });
  // Track partial usage yielded as `custom` events so an aborted stream
  // (which throws instead of emitting a real terminal `done`) can still
  // fold the tokens it had already accrued into its synthetic done.
  //
  // Usage snapshots are ABSOLUTE, not deltas: the model adapter's
  // stream-parser assigns `acc.inputTokens = chunk.usage.prompt_tokens`
  // and yields that total on every usage event. Always overwrite with
  // the latest snapshot rather than summing — accumulation would
  // double-count tokens when multiple usage updates arrive.
  let partialInputTokens = 0;
  let partialOutputTokens = 0;
  try {
    // `let` justified: tracks last yield time for frame-rate-limited yielding
    let lastYieldAt = Date.now();
    for await (const event of stream) {
      // #1742: if resetConversation() disposed our batcher mid-stream, stop
      // feeding events into a dead sink — they would silently vanish and
      // leave the UI with a half-rendered or missing reply. The drain exits
      // cleanly; the caller's finally block handles connection-status reset.
      if (batcher.isDisposed) return;
      if (event.kind === "custom" && event.type === "usage") {
        const usage = event.data as { inputTokens?: number; outputTokens?: number };
        if (typeof usage.inputTokens === "number") {
          partialInputTokens = usage.inputTokens;
        }
        if (typeof usage.outputTokens === "number") {
          partialOutputTokens = usage.outputTokens;
        }
      }
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
    if (!batcher.isDisposed) batcher.flushSync();
  } catch (e: unknown) {
    // #1742: the batcher may have been disposed by resetConversation() while
    // the stream was still producing. In that case the store has already been
    // cleared/reset, so there is nothing to flush or signal — just return.
    if (batcher.isDisposed) return;
    batcher.flushSync();
    // User-initiated aborts must surface as a clean interrupted turn, not
    // a generic engine error. Narrow the translation to: (1) the caller
    // passed a signal, (2) that signal is actually aborted at the time of
    // catch, AND (3) the error looks like an AbortError. This avoids
    // swallowing timeout-driven or internal aborts that throw AbortError
    // without a user-initiated cancel. See issue #1653.
    if (
      signal?.aborted &&
      e instanceof Error &&
      (e.name === "AbortError" || (e as { code?: unknown }).code === "ABORT_ERR")
    ) {
      // Synthesize a terminal `done` event so the reducer finalizes the
      // streaming assistant message, clears running tool state, and
      // returns agentStatus to idle. Without this, a cancelled turn
      // leaves the UI stuck in a "processing" state. Carry forward any
      // partial usage accumulated from `custom` usage events so cost
      // accounting isn't lost on the fallback path.
      const syntheticDone: EngineEvent = {
        kind: "done",
        output: {
          stopReason: "interrupted",
          content: [],
          metrics: {
            totalTokens: partialInputTokens + partialOutputTokens,
            inputTokens: partialInputTokens,
            outputTokens: partialOutputTokens,
            turns: 0,
            durationMs: 0,
          },
        },
      };
      batcher.enqueue(syntheticDone);
      batcher.flushSync();
      return;
    }
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
export async function runTuiCommand(flags: TuiFlags): Promise<void> {
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
  const { apiKey, baseUrl, model: modelName, fallbackModels } = apiConfigResult.value;

  const modelAdapter = createOpenAICompatAdapter({
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    model: modelName,
  });

  // Build model-router when KOI_FALLBACK_MODEL is set. All targets share the
  // same API key and base URL (typical for OpenRouter which hosts all models).
  // Primary is always the KOI_MODEL adapter; fallbacks follow in order.
  //
  // ProviderAdapter.stream returns AsyncGenerator; ModelAdapter.stream returns
  // AsyncIterable. Wrap with async function* to bridge the gap.
  const modelRouterMiddleware =
    fallbackModels.length > 0
      ? (() => {
          const allModels = [modelName, ...fallbackModels];
          const adapterMap = new Map(
            allModels.map((m) => {
              const a = createOpenAICompatAdapter({
                apiKey,
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                model: m,
              });
              return [
                m,
                {
                  id: m,
                  complete: (req: import("@koi/core").ModelRequest) => a.complete(req),
                  stream: async function* (req: import("@koi/core").ModelRequest) {
                    yield* a.stream(req);
                  },
                },
              ] as const;
            }),
          );
          const configResult = validateRouterConfig({
            strategy: "fallback",
            targets: allModels.map((m) => ({ provider: m, model: m, adapterConfig: {} })),
            retry: { maxRetries: 0 },
          });
          if (!configResult.ok) {
            process.stderr.write(
              `warn: model-router config invalid (${configResult.error.message}) — routing disabled\n`,
            );
            return undefined;
          }
          const router = createModelRouter(configResult.value, adapterMap);
          process.stderr.write(
            `[koi/tui] model-router: ${modelName} → [${fallbackModels.join(", ")}]\n`,
          );
          return createModelRouterMiddleware(router);
        })()
      : undefined;

  // ---------------------------------------------------------------------------
  // 2. TUI state setup (P2-A: show TUI immediately, before runtime assembly)
  // ---------------------------------------------------------------------------

  const store = createStore(createInitialState());
  // Persistent approval store — gracefully degrade if DB can't be opened
  // (corrupt file, permissions issue, etc.). TUI still works without it.
  // let: approvalStore is conditionally set based on DB availability
  let approvalStore: ReturnType<typeof createApprovalStore> | undefined;
  try {
    approvalStore = createApprovalStore({
      dbPath: join(homedir(), ".koi", "approvals.db"),
    });
  } catch {
    // DB unavailable — permanent approvals disabled for this session.
  }
  const permissionBridge = createPermissionBridge({
    store,
    permanentAvailable: approvalStore !== undefined,
  });

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

  // Loop mode (--until-pass): each user turn becomes a runUntilPass
  // invocation that iterates the agent against the verifier until
  // convergence or budget exhaustion. Disables session transcript
  // persistence because intermediate loop iterations are not
  // resumable — matches koi start --until-pass semantics.
  const isLoopMode = flags.untilPass.length > 0;

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
    ...(modelRouterMiddleware !== undefined ? { modelRouterMiddleware } : {}),
    // In loop mode, session persistence is intentionally omitted so
    // failed iterations don't pollute the resumable JSONL transcript.
    // Loop mode is a self-correcting execution, not a conversation.
    ...(isLoopMode ? {} : { session: { transcript: jsonlTranscript, sessionId: tuiSessionId } }),
    skillsRuntime: skillRuntime,
    ...(approvalStore !== undefined ? { persistentApprovals: approvalStore } : {}),
    ...(flags.goal.length > 0 ? { goals: flags.goal } : {}),
    // KOI_OTEL_ENABLED=true opts into OTel span emission for the TUI session.
    // Requires an OTel SDK initialised before this point (e.g. via OTLP exporter).
    ...(process.env.KOI_OTEL_ENABLED === "true" ? { otel: true as const } : {}),
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

  // The raw abort action used by the SIGINT state machine's graceful path.
  // Aborts the active model stream and closes pending approval prompts.
  // Does NOT tear down the TUI — the user stays in the session.
  //
  // Background subprocesses (bash_background) are intentionally NOT killed
  // here: the session-wide `bgController` is shared across turns, and
  // `runtimeHandle.shutdownBackgroundTasks()` also disposes MCP
  // resolvers/providers that are built once and never rebuilt. Cancelling
  // the current response must not kill unrelated background work from
  // earlier turns or permanently break MCP tools for the rest of the
  // session. Users who want to reset everything can use `/clear` or quit.
  const abortActiveStream = (): void => {
    permissionBridge.dispose();
    activeController?.abort();
  };

  // TUI interrupt protocol (see docs/L2/interrupt.md, issue #1653):
  //  - First tap → abortActiveStream(); user stays in the TUI and the engine
  //    emits its terminal `done` with `stopReason: "interrupted"` through the
  //    normal flush path.
  //  - Second tap within 2s → graceful shutdown(130) (standard SIGINT exit).
  //  - No failsafe: the graceful path here is a synchronous
  //    `controller.abort()`, so there is nothing to time out. Shutdown on the
  //    second tap has its own SIGKILL escalation for background tasks.
  //
  // Both the process-level SIGINT and the in-app Ctrl+C (via TUI keyboard
  // layer) route through this single handler so the force-exit escape hatch
  // is available in raw-mode sessions, not just when SIGINT reaches the
  // process directly.
  // No auto-failsafe on the TUI handler. A previous iteration installed a
  // 10s failsafeMs to handle non-cooperative in-flight tools (e.g. MCP
  // calls that ignore the abort signal), but that silently upgrades a
  // single "cancel this turn" tap into full session loss after 10s —
  // interrupted turns aren't committed to the transcript, so the user
  // loses context they never asked to discard. The double-tap force path
  // is already the explicit escape hatch for hung tools; requiring the
  // user to press Ctrl+C a second time if their cancel didn't take is
  // better UX than surprise session termination.
  //
  // Defense-in-depth: the TUI has two interrupt ingress paths — the
  // keyboard layer's Ctrl+C callback AND the process-level SIGINT
  // handler — both routing through this single state machine. Most
  // terminal configurations deliver through only one (raw mode captures
  // Ctrl+C as stdin bytes, non-raw delivers SIGINT via process group),
  // but edge cases can fire both. A 150ms coalesce window is well below
  // the 300-500ms human intentional double-tap reflex but well above any
  // plausible dual-path delivery delay, so it defends the first tap
  // without blocking a legitimate force double-tap.
  const TUI_COALESCE_WINDOW_MS = 150;
  const sigintHandler = createSigintHandler({
    onGraceful: () => {
      // Idle sessions (no active stream) have nothing to cancel, so the
      // first Ctrl+C quits the TUI — matching the standard single-SIGINT
      // termination convention. When a stream IS active, abort it and let
      // the user stay in the TUI; a second Ctrl+C within 2s forces exit.
      if (activeController === null) {
        void shutdown(130);
        return;
      }
      abortActiveStream();
    },
    onForce: () => {
      // Force path: abort the active foreground stream FIRST so no
      // further model/tool work can execute during the exit window,
      // then kick background-task SIGTERM so subprocesses start dying.
      // Without the foreground abort, side-effecting tools could keep
      // running for the full 3.5s SIGKILL-escalation wait below.
      abortActiveStream();
      const liveTasks = runtimeHandle?.shutdownBackgroundTasks() ?? false;
      if (liveTasks) {
        // Wait long enough for the runtime's SIGKILL escalation window
        // (SIGKILL_ESCALATION_MS = 3000ms in tui-runtime / bash exec) to
        // fire before this process — and its in-process escalation
        // timer — dies. Exiting earlier orphans subprocesses that
        // ignore SIGTERM, exactly the failure mode "force" is supposed
        // to handle.
        setTimeout(() => process.exit(130), 3500);
        return;
      }
      process.exit(130);
    },
    write: (msg: string) => {
      process.stderr.write(msg);
    },
    doubleTapWindowMs: 2000,
    coalesceWindowMs: TUI_COALESCE_WINDOW_MS,
    setTimer: createUnrefTimer,
  });
  // Shared entry point: in-app Ctrl+C (via createTuiApp's `onInterrupt`
  // prop) and the `agent:interrupt` command both route through here.
  const onInterrupt = (): void => {
    sigintHandler.handleSignal();
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
  // Every invocation arms a hard-exit failsafe so the user is never stranded
  // if `appHandle.stop()`, background-task drain, or `runtime.dispose()`
  // wedges. The failsafe is unref'd, so natural cleanup completion before
  // the timer fires still lets the process exit cleanly via `process.exit`.
  const SHUTDOWN_HARD_EXIT_MS = 8000;
  // let: justified — set once on first shutdown call
  let shutdownStarted = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    // Abort the active foreground run FIRST so no further model/tool
    // work can execute during teardown. Without this, long-running or
    // non-cooperative tools can keep mutating local/remote state during
    // the cooperative shutdown window (up to 8s) or the SIGKILL
    // escalation wait (3.5s) — after the user or supervisor has already
    // requested termination. Matches the invariant also enforced on the
    // force path in onForce.
    abortActiveStream();
    // Kick background-task teardown synchronously so stubborn
    // subprocesses start receiving SIGTERM before anything else that could
    // wedge (appHandle.stop, runtime.dispose). This guarantees the
    // invariant — "subprocesses always get SIGTERM before the process
    // exits" — even if the cooperative shutdown path wedges and the
    // hard-exit timer fires. The return flag tells us whether to pay the
    // SIGKILL escalation wait below (idle/no-task exits stay immediate).
    const hadLiveTasks = runtimeHandle?.shutdownBackgroundTasks() ?? false;
    // Hard-exit failsafe. If any cooperative step hangs, this terminates
    // the process. It runs AFTER the background-task SIGTERM has already
    // been issued above, so orphaned subprocesses get cleaned up by their
    // own SIGKILL escalation (launched by the runtime) rather than outliving
    // the TUI.
    const hardExit = setTimeout(() => {
      process.exit(exitCode);
    }, SHUTDOWN_HARD_EXIT_MS);
    if (typeof hardExit === "object" && hardExit !== null && "unref" in hardExit) {
      (hardExit as { unref: () => void }).unref();
    }
    try {
      await appHandle?.stop();
      batcher.dispose();
      if (runtimeHandle !== null) {
        // Only pay the SIGTERM→SIGKILL escalation wait when we actually
        // had live subprocesses to drain. Idle exits stay immediate.
        // SIGKILL_ESCALATION_MS = 3000 in the runtime.
        if (hadLiveTasks) {
          await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
        }
        await runtimeHandle.runtime.dispose();
      }
      approvalStore?.close();
    } finally {
      process.exit(exitCode);
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
    onCommand: (commandId: string, args: string): void => {
      switch (commandId) {
        case "agent:interrupt":
          onInterrupt();
          break;
        case "agent:clear":
          resetConversation();
          break;
        case "agent:rewind":
          // /rewind <n> rolls back N turns (file edits + conversation) via
          // @koi/checkpoint. `args` comes from the slash dispatch chain
          // (parseSlashCommand → handleSlashSelect → handleCommandSelect →
          // onCommand). Defaults to 1 when no arg is given. Negative or
          // non-integer args are surfaced as REWIND_INVALID_ARGS.
          void (async (): Promise<void> => {
            if (runtimeHandle === null) {
              store.dispatch({
                kind: "add_error",
                code: "REWIND_RUNTIME_NOT_READY",
                message: "Runtime is still initializing — try again in a moment.",
              });
              return;
            }

            // Parse the rewind count: empty string defaults to 1, otherwise
            // require a positive integer. Reject anything else loudly so the
            // user knows their `/rewind <garbage>` was malformed.
            let n = 1;
            const trimmed = args.trim();
            if (trimmed.length > 0) {
              const parsed = Number.parseInt(trimmed, 10);
              if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== trimmed) {
                store.dispatch({
                  kind: "add_error",
                  code: "REWIND_INVALID_ARGS",
                  message: `Usage: /rewind [n] — n must be a positive integer (got "${trimmed}").`,
                });
                return;
              }
              n = parsed;
            }

            // Use the ENGINE session ID (from @koi/engine's createKoi),
            // not tuiSessionId. The checkpoint middleware captures chains
            // keyed by ctx.session.sessionId which is the engine's
            // composite "agent:{agentId}:{instanceId}" ID — tuiSessionId
            // is a TUI-local UUID that never matches a captured chain.
            const engineSessionId = sessionId(runtimeHandle.runtime.sessionId);
            const rewindStart = performance.now();
            const result = await runtimeHandle.checkpoint.rewind(engineSessionId, n);
            const rewindDurationMs = performance.now() - rewindStart;
            if (!result.ok) {
              store.dispatch({
                kind: "add_error",
                code: "REWIND_FAILED",
                message: `Rewind failed: ${result.error.message}`,
              });
              return;
            }

            // After a successful rewind the restore protocol has already
            // truncated the JSONL transcript to the target turn's entry
            // count. Mirror the session-resume flow: call resetConversation
            // so the engine's internal state (task board, trajectory, abort
            // controller, batcher) is rebuilt, then await resetBarrier so
            // the async reset is complete before we push the retained
            // entries back in. Without the reset, the next user submit
            // runs against a stale engine state and produces no output.
            resetConversation();
            await resetBarrier;
            const resumeResult = await resumeForSession(engineSessionId, jsonlTranscript);
            if (resumeResult.ok) {
              for (const msg of resumeResult.value.messages) {
                runtimeHandle.transcript.push(msg);
              }
              store.dispatch({
                kind: "load_history",
                messages: resumeResult.value.messages,
              });
            }

            // Record the rewind operation as a synthetic ATIF step so
            // /trajectory can show it. Rewind runs outside the engine's
            // turn loop (doesn't go through runTurn), so the trace wrapper
            // never sees it — we emit one manually. Append AFTER
            // resetConversation so it lands in the freshly-pruned store.
            const rewindStep: RichTrajectoryStep = {
              stepIndex: 0,
              timestamp: Date.now(),
              source: "system",
              kind: "tool_call",
              identifier: "checkpoint:rewind",
              outcome: "success",
              durationMs: rewindDurationMs,
              request: {
                data: { n, sessionId: String(engineSessionId) },
              },
              response: {
                data: {
                  turnsRewound: result.turnsRewound,
                  opsApplied: result.opsApplied,
                  targetNodeId: String(result.targetNodeId),
                  newHeadNodeId: String(result.newHeadNodeId),
                  driftWarnings: result.driftWarnings,
                },
              },
              metadata: { type: "checkpoint_rewind" },
            };
            await runtimeHandle.appendTrajectoryStep(rewindStep);
            // Refresh the trajectory view so the step shows up in the
            // UI without waiting for the next turn to refresh it.
            void runtimeHandle.getTrajectorySteps().then((steps) => {
              store.dispatch({
                kind: "set_trajectory_data",
                steps: mapTrajectorySteps(steps),
              });
            });

            // Surface drift warnings — paths the rewind could not restore
            // because they were modified outside the tracked tool pipeline
            // (bash-mediated rm/mv/sed, build artifacts). The user needs to
            // know these so they can manually reconcile.
            if (result.driftWarnings.length > 0) {
              const head = `Rewound ${result.turnsRewound} turn${result.turnsRewound === 1 ? "" : "s"}, but ${result.driftWarnings.length} change${result.driftWarnings.length === 1 ? "" : "s"} could not be restored:`;
              const body = result.driftWarnings.map((w) => `  ${w}`).join("\n");
              store.dispatch({
                kind: "add_error",
                code: "REWIND_DRIFT",
                message: `${head}\n${body}`,
              });
            }
            // Surface incomplete-snapshot warnings — turns whose capture
            // soft-failed are walked past on rewind because their file ops
            // are not recorded. The file state from those turns may still
            // be on disk and differ from the restored target.
            if (result.incompleteSnapshotsSkipped.length > 0) {
              const n = result.incompleteSnapshotsSkipped.length;
              store.dispatch({
                kind: "add_error",
                code: "REWIND_INCOMPLETE",
                message:
                  `Rewound past ${n} turn${n === 1 ? "" : "s"} with a soft-failed capture. ` +
                  "File changes made during those turns are not recorded and may remain on disk — " +
                  "verify the workspace state manually if anything looks off.",
              });
            }
          })();
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
        //
        // Loop mode: each user turn becomes a runUntilPass invocation that
        // iterates the agent against --until-pass until convergence. The
        // multiplexing stream below surfaces all iterations' EngineEvents
        // into drainEngineStream so the TUI renders each iteration's model
        // output naturally.
        const stream = isLoopMode
          ? runTuiLoopTurn(handle.runtime, text, controller.signal, flags, store)
          : handle.runtime.run({
              kind: "text",
              text,
              signal: controller.signal,
            });
        await drainEngineStream(stream, store, batcher, controller.signal);

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
        // Guard against cross-run races: only clear activeController and
        // reset the SIGINT handler if THIS run is still the active one.
        // If resetConversation() or a new submit replaced the controller
        // mid-drain, this finally is stale and must not disarm the
        // SIGINT state that now belongs to the newer run.
        const isStillActive = activeController === controller;
        if (isStillActive) {
          activeController = null;
        }
        // The active run has settled. Reset the double-tap window so a
        // later Ctrl+C is treated as a fresh first tap rather than a
        // late-arriving second tap of a cancellation that already
        // completed. Only safe when this run is still the active one —
        // a stale finally from a reset-and-replaced run must not
        // disarm SIGINT state that now belongs to a newer turn.
        if (isStillActive) {
          sigintHandler.complete();
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

  const onProcessSigint = (): void => {
    sigintHandler.handleSignal();
  };
  // SIGTERM is a separate termination cause (supervisor/OOM/operator kill)
  // and must not share SIGINT's exit code. 143 = 128 + 15 (SIGTERM), per
  // POSIX convention, so supervisors and incident tooling can distinguish
  // external termination from Ctrl+C.
  const onProcessSigterm = (): void => {
    void shutdown(143);
  };
  process.on("SIGINT", onProcessSigint);
  process.once("SIGTERM", onProcessSigterm);

  try {
    await result.value.start();

    // Load saved sessions in the background after the TUI is rendering.
    // Fire-and-forget: failures are silently swallowed (non-critical feature).
    void loadSessionList(SESSIONS_DIR, jsonlTranscript).then((sessions) => {
      store.dispatch({ kind: "set_session_list", sessions });
    });
    // Block until stop() completes. `shutdown()` / quit command exit the
    // process directly, so the cleanup in `finally` only runs when `done()`
    // resolves because the renderer was destroyed externally (e.g. in tests
    // or embedded callers) — which is precisely the path that would leak
    // signal handlers and armed double-tap timers without explicit cleanup.
    await result.value.done();
  } finally {
    sigintHandler.dispose();
    process.removeListener("SIGINT", onProcessSigint);
    process.removeListener("SIGTERM", onProcessSigterm);
  }
}

// ---------------------------------------------------------------------------
// Loop-mode turn execution (#1624)
// ---------------------------------------------------------------------------

/**
 * Run a single user turn through @koi/loop's runUntilPass. Each iteration
 * calls the underlying KoiRuntime via a tee-runtime that forwards
 * EngineEvents into a shared queue. The generator returned by this
 * function yields events from that queue in order, so drainEngineStream
 * sees a continuous stream of all iterations' events — the TUI renders
 * each retry naturally.
 *
 * Loop lifecycle events (iteration.start, verifier.complete, terminal)
 * are surfaced as synthetic text_delta events prefixed with "[loop]" so
 * the user can see iteration progress and the final terminal state
 * without needing a new TUI surface. The synthetic messages are
 * formatted as plain text and treated as part of the assistant turn.
 */
async function* runTuiLoopTurn(
  runtime: TuiRuntimeHandle["runtime"],
  text: string,
  signal: AbortSignal,
  flags: TuiFlags,
  store: TuiStore,
): AsyncIterable<EngineEvent> {
  void store; // reserved for future inline status dispatches
  if (flags.untilPass.length === 0) {
    throw new Error("runTuiLoopTurn: untilPass must be non-empty");
  }
  const argv: readonly [string, ...string[]] = [
    flags.untilPass[0] as string,
    ...flags.untilPass.slice(1),
  ];

  // Verifier subprocess: minimal env by default, opt-in to inherit
  // parent env (minus Koi provider keys) via --verifier-inherit-env.
  const verifier = createArgvGate(argv, {
    cwd: process.cwd(),
    timeoutMs: flags.verifierTimeoutMs,
    ...(flags.verifierInheritEnv ? { env: scrubSensitiveEnv(process.env) } : {}),
  });

  // Event queue: tee-runtime pushes, generator pops. loopDone signals
  // when runUntilPass has settled so the generator exits cleanly.
  const queue: EngineEvent[] = [];
  // let: mutable resolver reassigned each wait cycle
  let waiter: (() => void) | null = null;
  // let: mutable flag set when the loop terminates
  let loopDone = false;

  const enqueue = (event: EngineEvent): void => {
    queue.push(event);
    if (waiter !== null) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  };

  const teeRuntime: LoopRuntime = {
    async *run(input) {
      for await (const event of runtime.run({
        kind: input.kind,
        text: input.text,
        signal: input.signal,
      })) {
        enqueue(event);
        yield event;
      }
    },
  };

  // Fire the loop in the background. finally() signals completion so
  // the generator's drain loop below exits.
  const loopPromise = runUntilPass({
    runtime: teeRuntime,
    verifier,
    initialPrompt: text,
    workingDir: process.cwd(),
    maxIterations: flags.maxIter,
    verifierTimeoutMs: flags.verifierTimeoutMs,
    // Same CLI semantics: the library breaker is unreachable so
    // --max-iter is the binding iteration budget.
    maxConsecutiveFailures: Number.MAX_SAFE_INTEGER,
    signal,
    onEvent: (event) => {
      // Surface iteration boundaries as plain text_delta events so the
      // user sees "--- loop iteration N / M ---" banners inline with
      // the model output in the TUI. Using text_delta keeps the
      // existing TUI renderer working without new event surface.
      if (event.kind === "loop.iteration.start") {
        enqueue({
          kind: "text_delta",
          delta: `\n--- loop iteration ${event.iteration} / ${flags.maxIter} ---\n`,
        });
      } else if (event.kind === "loop.verifier.complete") {
        const line = event.result.ok
          ? `✔ verifier passed (${argv[0]})\n`
          : `✘ verifier failed: ${event.result.reason}\n`;
        enqueue({ kind: "text_delta", delta: line });
      } else if (event.kind === "loop.terminal") {
        const result = event.result;
        const summary =
          result.status === "converged"
            ? `\nkoi: loop converged after ${result.iterations} iteration(s)\n`
            : `\nkoi: loop ended (${result.status}) after ${result.iterations} iteration(s) — ${result.terminalReason}\n`;
        enqueue({ kind: "text_delta", delta: summary });
      }
    },
  }).finally(() => {
    loopDone = true;
    if (waiter !== null) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  });

  // Drain the queue to the generator's consumer. When loopDone is set
  // AND the queue is empty, exit cleanly.
  try {
    while (!loopDone || queue.length > 0) {
      const event = queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (loopDone) break;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  } finally {
    // Always await the loop promise so any rejection is observed.
    // Swallow errors here — the loop's own error handling has
    // already recorded them via onEvent/iterationRecords.
    await loopPromise.catch(() => {
      // intentional
    });
  }
}

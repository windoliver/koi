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

import { writeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  EngineEvent,
  InboundMessage,
  RichTrajectoryStep,
  SessionId,
  SessionTranscript,
} from "@koi/core";
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
import { formatPickerModeResumeHint, formatResumeHint } from "./resume-hint.js";
import { resumeSessionFromJsonl } from "./shared-wiring.js";
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
        // Filenames on disk are `encodeURIComponent(sessionId).jsonl`
        // so composite ids like `agent:<agentId>:<uuid>` live as
        // `agent%3A<agentId>%3A<uuid>.jsonl`. Decode the basename
        // back to the raw id before branding + loading — otherwise
        // `transcript.load` re-encodes and looks up a file that
        // does not exist (e.g. `agent%253A...` instead of
        // `agent%3A...`), making legacy pre-branch transcripts
        // invisible to the picker and unresumable via the list.
        let decoded: string;
        try {
          decoded = decodeURIComponent(file.slice(0, -".jsonl".length));
        } catch {
          // Malformed percent-encoding — skip the file rather than
          // crash the picker. The user can still pass the raw
          // basename via `koi tui --resume` if they need to.
          return null;
        }
        const id = decoded;
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
    batcher.flushSync();
  } catch (e: unknown) {
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

  // Mint a plain UUID for this TUI session. This is passed through to
  // `createKoi` via the `sessionId` override, so the engine uses it as
  // `runtime.sessionId` and as `ctx.session.sessionId` — which is what
  // the session-transcript middleware routes on. The post-quit resume
  // hint prints this exact id, and the `~/.koi/sessions/<id>.jsonl`
  // file is keyed on it, so copy-pasting the hint into
  // `koi tui --resume` or `koi start --resume` Just Works.
  // let: justified — reassigned on successful --resume so new writes
  // append to the existing JSONL instead of forking.
  let tuiSessionId = sessionId(crypto.randomUUID());
  const jsonlTranscript = createJsonlTranscript({ baseDir: SESSIONS_DIR });

  // --- Session resume (optional, --resume <id>) ---
  // Loads the historical message list from the JSONL transcript and
  // dispatches `rehydrate_messages` so the TUI renders the previous
  // conversation on mount. The resumed id then becomes `tuiSessionId`
  // and is passed through to `createKoi` as the `sessionId` override,
  // so new turns append to the same JSONL file instead of forking to
  // a fresh one.
  // let: justified — the resumed message list must be spliced into the
  // runtime's mutable transcript array after assembly, because the
  // model's context window is built from that array on every turn.
  // Dispatching `rehydrate_messages` alone only updates the UI — the
  // model would still see an empty history and treat the resumed
  // session as a fresh conversation.
  let resumedMessagesToPrime: readonly InboundMessage[] = [];
  if (flags.resume !== undefined) {
    const resumeResult = await resumeSessionFromJsonl(flags.resume, jsonlTranscript, SESSIONS_DIR);
    if (!resumeResult.ok) {
      process.stderr.write(
        `koi tui: cannot resume session "${flags.resume}" — ${resumeResult.error}\n`,
      );
      process.exit(1);
    }
    tuiSessionId = resumeResult.value.sid;
    store.dispatch({
      kind: "rehydrate_messages",
      messages: resumeResult.value.messages,
    });
    resumedMessagesToPrime = resumeResult.value.messages;
    if (resumeResult.value.issueCount > 0) {
      // Non-fatal: surface once via stderr (visible before alt-screen
      // engages) so the operator knows the transcript needed repair.
      process.stderr.write(
        `koi tui: resumed with ${resumeResult.value.issueCount} repair issue(s)\n`,
      );
    }
  }

  // Populate the status-bar session chip immediately so users see the
  // same identifier the post-quit resume hint will emit, instead of the
  // placeholder "no session" label. Provider is a best-effort label
  // derived from the resolved base URL (or "openrouter" when omitted,
  // which matches resolveApiConfig's default).
  const provider = ((): string => {
    if (baseUrl === undefined) return "openrouter";
    try {
      const host = new URL(baseUrl).hostname;
      if (host.includes("openrouter")) return "openrouter";
      if (host.includes("openai.com")) return "openai";
      return host;
    } catch {
      return "custom";
    }
  })();
  store.dispatch({
    kind: "set_session_info",
    modelName,
    provider,
    sessionName: "",
    sessionId: tuiSessionId,
  });

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
    // Prime the runtime's in-memory transcript with the resumed
    // messages. The runtime's context-window builder reads from this
    // array on every turn, so without this push the model would see
    // an empty history and treat the first post-resume turn as a
    // fresh conversation. Dispatching `rehydrate_messages` only
    // updates the UI; this line makes the agent remember.
    if (resumedMessagesToPrime.length > 0) {
      handle.transcript.push(...resumedMessagesToPrime);
      resumedMessagesToPrime = [];
    }
    return handle;
  });

  // let: set once after createTuiApp resolves, read in shutdown
  let appHandle: { readonly stop: () => Promise<void> } | null = null;
  // let: per-submit abort controller, replaced on each new stream
  let activeController: AbortController | null = null;
  // let: promise tracking the in-flight `drainEngineStream` call.
  // `resetConversation()` must await this before truncating or
  // overwriting the session file, otherwise the session-transcript
  // middleware's finally-block append (which runs on turns that
  // already observed a `done` chunk before the caller aborted) can
  // land AFTER the truncate and silently resurrect pre-clear history.
  let activeRunPromise: Promise<void> | null = null;

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

  // Reflects the most recent `jsonlTranscript.truncate()` outcome
  // during a clear/new reset. Shutdown checks this flag (not
  // resetBarrier rejection) to suppress the post-quit resume hint:
  // advertising a session as resumable when its durable clear
  // didn't land would silently re-expose the pre-clear history on
  // the next `koi tui --resume`. Using a flag instead of a
  // rejected promise lets `onSubmit` and other `await resetBarrier`
  // sites proceed cleanly after a failed clear; the visible error
  // is still surfaced via
  // `store.dispatch({ code: "SESSION_CLEAR_PERSIST_FAILED" })`.
  //
  // Reset at the top of each `resetConversation()` call so a
  // subsequent successful clear re-enables the hint. A sticky
  // process-wide flag would permanently strand the user if a
  // transient I/O blip during one clear happened to precede hours
  // of later work — the shutdown hint would be withheld even
  // though the final session state is perfectly resumable.
  // let: justified — toggled per clear attempt.
  let clearPersistFailed = false;

  // Rewind-boundary tracking: `rewindBoundaryActive` is true
  // whenever `/rewind` must refuse to walk past some boundary
  // earlier in the persistent checkpoint chain. Two conditions
  // flip it:
  //   1. The user issued `agent:clear` or `session:new` in this
  //      process — pre-clear snapshots still exist in the chain
  //      and rewinding past them would restore file state the
  //      user explicitly asked to drop.
  //   2. The TUI was launched with `--resume` — the prior
  //      process may have issued a clear we cannot see from
  //      here, and the chain still contains whatever snapshots
  //      it ever held. The safe default is to treat the resume
  //      point itself as a boundary until the user takes new
  //      turns in this process.
  // Rewind is then bounded to `postClearTurnCount`, which counts
  // only turns whose snapshots were definitely added by this
  // process, so we can't accidentally cross into territory we
  // don't own.
  // let: justified — may be flipped by subsequent in-process clears
  let rewindBoundaryActive = flags.resume !== undefined;

  // Clear-only tracking: `clearedThisProcess` is `true` only
  // when the user EXPLICITLY issued `/clear` or `/new` in the
  // current process. Shutdown uses this (NOT the rewind flag
  // above) to decide whether to suppress the resume hint for a
  // cleared-and-untouched session. Reusing the rewind flag
  // would misclassify a plain `--resume` + quit as "cleared"
  // and strand inspection-only opens without a hint to relaunch.
  // let: justified — set on explicit /clear or /new, never on resume
  let clearedThisProcess = false;

  // Counts user turns taken AFTER the most recent rewind
  // boundary (either an explicit `/clear`/`/new` OR the resume
  // point at launch when `--resume` was used). Reset to 0 each
  // time the boundary shifts and incremented in `onSubmit` after
  // each turn settles. `/rewind n` rejects when
  // `n > postClearTurnCount`, so a rewind can never cross the
  // boundary while still letting users roll back mistakes made
  // in the current session. When `rewindBoundaryActive` is
  // false the counter is effectively unused because the guard
  // skips the check entirely.
  // let: justified — incremented per turn, reset on each boundary shift.
  let postClearTurnCount = 0;

  // The session id the user is currently VIEWING. Starts as
  // `tuiSessionId` (the startup session), gets rotated to the
  // picked session id after a successful `onSessionSelect`, and
  // rotates BACK to `tuiSessionId` when the user selects the
  // startup session from the picker. The post-quit resume hint,
  // the status-bar chip, and the operator-facing "relaunch with
  // --resume" guidance all use this id so the user is always
  // pointed at the file that matches what they just saw on
  // screen. This stays decoupled from `tuiSessionId` (the
  // runtime's durable routing key) because the runtime cannot be
  // rebound mid-session.
  //
  // Picker read-only mode is DERIVED from the comparison
  // `viewedSessionId !== tuiSessionId` rather than a one-way
  // latch. A user who opens an archive, then returns to the
  // startup session via the picker, regains full submit / clear /
  // rewind / fork capability the moment the two ids converge
  // again — matches the pre-branch behavior of the picker flow.
  // let: justified — rotated on every successful picker load
  let viewedSessionId: SessionId = tuiSessionId;

  // Latches to `true` for the duration of an in-flight
  // `onSessionSelect` async flow, so the picker-mode guards fire
  // the instant the user clicks a session even though
  // `viewedSessionId` is only rotated after the async
  // load/validate/reset work settles. Without this, a fast submit
  // (or slash command) in the window between "user picked" and
  // "async flow completed" would still run against the startup
  // session, silently mutating the wrong transcript. Cleared in
  // the `onSessionSelect` finally block regardless of outcome.
  // let: justified — toggled per picker-select invocation.
  let pendingSessionSwitch = false;
  const isInPickerMode = (): boolean => pendingSessionSwitch || viewedSessionId !== tuiSessionId;

  // Shared reset primitive. Callers that represent a true privacy /
  // rollback boundary (agent:clear, session:new) must additionally
  // flip `rewindBoundaryActive` and `clearedThisProcess` themselves
  // — session-switch via the picker intentionally does NOT flip
  // them, because the post-switch turns establish a usable rewind
  // chain of their own.
  //
  // `truncatePersistedTranscript` controls whether the on-disk
  // `<tuiSessionId>.jsonl` is cleared alongside the in-memory
  // state. agent:clear / session:new pass `true` because the
  // durable transcript is exactly what the user wants erased.
  // Session switching must NOT pass `true` — the live JSONL
  // belongs to the startup session id and must survive the switch,
  // otherwise any work done before the pick is destroyed and the
  // post-quit resume hint points at a file whose identity no
  // longer matches that work.
  const resetConversation = (options: { readonly truncatePersistedTranscript: boolean }): void => {
    // Clear any stale flag from a PREVIOUS reset — if the
    // current truncate succeeds, shutdown's hint suppression
    // should not fire on the basis of an earlier transient
    // failure. The new truncate path below will re-set the flag
    // if and only if THIS reset's durable clear fails.
    clearPersistFailed = false;
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

    // Snapshot the in-flight run promise BEFORE scheduling any
    // asynchronous reset work. `drainEngineStream` may still be
    // running against the now-aborted controller, and the session-
    // transcript middleware commits turn entries in a `finally` block
    // whenever it already observed a `done` chunk. If we truncated
    // before that append resolved, the committed entries would land
    // on the freshly-emptied file and silently resurrect pre-clear
    // history. Await the drain first, then truncate.
    const inflightRun = activeRunPromise;
    const shouldTruncate = options.truncatePersistedTranscript;
    // A `/clear` / `/new` issued during the startup resume window
    // (before createTuiRuntime has resolved) still has to honor
    // the privacy boundary. Two concrete holes need closing:
    //   1. `resumedMessagesToPrime` is pushed into the runtime's
    //      in-memory transcript inside the `runtimeReady.then(...)`
    //      callback. Without clearing it here, a pre-ready clear
    //      would drop the UI but still prime the model with the
    //      pre-clear history on the first post-ready turn.
    //   2. The on-disk JSONL truncate was previously gated behind
    //      `runtimeHandle !== null`, so a pre-ready clear left the
    //      durable transcript intact. A follow-up `--resume <id>`
    //      from the hint would resurrect the supposedly-cleared
    //      history.
    // Clearing the prime array is synchronous and safe regardless
    // of runtime readiness. The truncate is deferred into the
    // barrier either way — see the branches below.
    resumedMessagesToPrime = [];
    // Always reset runtime session state — even in the idle case (no active stream).
    // resetSessionState is async (awaits task board + trajectory prune).
    // New submits block on resetBarrier before proceeding.
    if (runtimeHandle !== null) {
      const idleController = new AbortController();
      idleController.abort();
      resetBarrier = (async () => {
        try {
          // Drain any in-flight run to its settled state so late
          // middleware-finally appends from the aborted turn cannot
          // land after the truncate below. drainEngineStream catches
          // AbortError and returns normally, so this await never
          // rejects; still guard with catch for any other teardown
          // exception so the reset pipeline cannot wedge.
          if (inflightRun !== null) {
            try {
              await inflightRun;
            } catch {
              /* already reported upstream via add_error */
            }
          }
          await runtimeHandle?.resetSessionState(idleController.signal);
          runtimeHandle?.transcript.splice(0);
          if (shouldTruncate) {
            // Truncate the on-disk JSONL so a subsequent `--resume`
            // of this session id cannot resurrect the pre-clear
            // conversation. Without this, `agent:clear` /
            // `session:new` only wipe in-memory state — the durable
            // transcript still holds the old turns and they reappear
            // on the next resume, silently breaking any user who
            // treats clear as a privacy or context boundary.
            //
            // On failure: surface to the store AND set the
            // `clearPersistFailed` flag so shutdown suppresses the
            // resume hint. We do NOT throw — an earlier version of
            // this code made the reset barrier reject to signal
            // failure, but `onSubmit` also awaits the barrier, and
            // a rejection there turned every later submit into an
            // unhandled-rejection crash. The flag-based approach
            // keeps the barrier a normal settle-success promise so
            // submits after a failed clear still reach the runtime.
            const truncateResult = await jsonlTranscript.truncate(tuiSessionId, 0);
            if (!truncateResult.ok) {
              clearPersistFailed = true;
              store.dispatch({
                kind: "add_error",
                code: "SESSION_CLEAR_PERSIST_FAILED",
                message: `Failed to clear persisted transcript — ${truncateResult.error.message}`,
              });
            }
          }
        } catch (err: unknown) {
          // Belt-and-suspenders: keep the barrier a settle-success
          // promise even if an unexpected reset step throws, so
          // awaiters in onSubmit / onSessionSelect / rewind don't
          // turn into unhandled rejections.
          clearPersistFailed = true;
          store.dispatch({
            kind: "add_error",
            code: "SESSION_RESET_FAILED",
            message: `Session reset failed — ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    } else {
      // Pre-runtime-ready reset path. `resetConversation` was
      // called before `createTuiRuntime` resolved, so we can't do
      // the runtime-scoped reset work yet. Schedule it behind
      // `runtimeReady`: the barrier waits for assembly to finish,
      // then performs the in-memory splice + (optional) durable
      // truncate. Future submits, shutdown, and session-pick
      // actions all `await resetBarrier`, so they correctly block
      // on the deferred work even though the call returned
      // synchronously. Without this branch, a `/clear` issued
      // during the startup resume window would silently leave
      // both `resumedMessagesToPrime` (cleared above) and the
      // durable JSONL untouched — a real privacy/context hole.
      resetBarrier = (async () => {
        try {
          // Wait for runtime assembly. After this resolves,
          // `runtimeHandle` is guaranteed non-null and the
          // runtime-ready `.then()` callback has already seen an
          // empty `resumedMessagesToPrime`, so no stale history
          // will have been pushed into `handle.transcript`.
          await runtimeReady.catch(() => {
            /* runtime init errors are reported upstream via add_error */
          });
          // TS narrows the captured `runtimeHandle` to `null`
          // inside this branch because the enclosing
          // `if (runtimeHandle !== null) { ... } else { ... }`
          // check narrowed it there. After the `await runtimeReady`
          // above, the `.then(handle => { runtimeHandle = handle; })`
          // side of the promise has definitely run, but TS can't
          // see that. Read the value through a function boundary
          // so TS widens it back to the full `TuiRuntimeHandle | null`
          // type.
          const handleAfterReady = ((): TuiRuntimeHandle | null => runtimeHandle)();
          if (handleAfterReady !== null) {
            handleAfterReady.transcript.splice(0);
          }
          if (shouldTruncate) {
            const truncateResult = await jsonlTranscript.truncate(tuiSessionId, 0);
            if (!truncateResult.ok) {
              clearPersistFailed = true;
              store.dispatch({
                kind: "add_error",
                code: "SESSION_CLEAR_PERSIST_FAILED",
                message: `Failed to clear persisted transcript — ${truncateResult.error.message}`,
              });
            }
          }
        } catch (err: unknown) {
          clearPersistFailed = true;
          store.dispatch({
            kind: "add_error",
            code: "SESSION_RESET_FAILED",
            message: `Session reset failed — ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
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
      // Wait for any in-flight clear/reset barrier to land BEFORE
      // emitting the resume hint. Without this, `/clear` followed by
      // an immediate `/quit` can race: the hint may print and
      // `process.exit` fire while `jsonlTranscript.truncate()` is
      // still in flight, leaving the old JSONL on disk and allowing
      // a later `--resume` to resurrect the supposedly-cleared
      // history. The barrier is bounded by `SHUTDOWN_HARD_EXIT_MS`
      // via the failsafe timer above, so a wedged reset cannot
      // block exit indefinitely.
      try {
        await resetBarrier;
      } catch {
        // Defensive: resetConversation now only resolves its
        // barrier, but if a future change accidentally reintroduces
        // a rejection path we still want shutdown to suppress the
        // resume hint rather than propagate an unhandled rejection.
        clearPersistFailed = true;
      }
      // Print the resume hint here — after the TUI renderer has
      // released the alt screen and the reset barrier has settled
      // but before any potentially-slow runtime teardown — so the
      // user always sees it, even if a later teardown step hangs
      // and the hard-exit failsafe fires from outside this
      // try/finally. Loop mode (--until-pass) intentionally skips
      // transcript persistence, so there is nothing to resume from.
      // writeSync on fd 1 is used because the eventual process.exit()
      // aborts before async stdout flushes, which would otherwise
      // swallow the hint entirely.
      if (!isLoopMode) {
        try {
          // A cleared-and-untouched session is intentionally
          // unresumable: `/clear` / `/new` truncated the JSONL to
          // zero entries, and `resumeSessionFromJsonl` rejects
          // empty transcripts as "not found" to catch typos.
          // Printing a resume hint in that case would advertise
          // an id that the next launch will reject. Suppress the
          // hint instead — the user explicitly asked to drop
          // this session, so offering to restore it is pointless.
          // Suppress the hint ONLY on an explicit /clear or /new
          // that left the session empty. `rewindBoundaryActive`
          // also flips on `--resume`, which must still print a
          // hint for inspection-only opens.
          const sessionIsEmpty = clearedThisProcess && postClearTurnCount === 0;
          if (clearPersistFailed) {
            writeSync(2, "koi tui: session clear did not persist — NOT printing a resume hint.\n");
          } else if (sessionIsEmpty) {
            writeSync(2, "koi tui: session was cleared — no resume hint to print.\n");
          } else if (tuiSessionId === viewedSessionId) {
            // Non-picker (or picker-of-self) case: both ids agree.
            // Print the single normal hint.
            writeSync(1, formatResumeHint(tuiSessionId));
          } else {
            // Picker mode: `tuiSessionId` is the writable startup
            // session where any work done this process landed on
            // disk; `viewedSessionId` is the read-only archive the
            // user was inspecting when they quit. Print BOTH so
            // the user can choose — otherwise the hint would
            // strand one handle. Without this, a user who did
            // work in the startup session, opened the picker to
            // inspect an older archive, and quit would only see
            // the archive id and might conclude their recent
            // work is lost.
            writeSync(1, formatPickerModeResumeHint(tuiSessionId, viewedSessionId));
          }
        } catch {
          // stdout may be closed during abnormal teardown — swallow.
        }
      }
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
      // Block fork in picker mode. `handleFork()` clones by
      // `runtime.sessionId`, which in picker mode is still the
      // startup session — not the conversation the user is viewing.
      // Forking here would silently clone the wrong transcript and
      // report success, which is a real wrong-target mutation.
      if (isInPickerMode()) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_AFTER_PICKER_LOAD",
          message:
            "Fork is disabled after loading a saved session via the picker — " +
            "the command would clone this process's original session, not the " +
            "one you are viewing. Quit and relaunch with " +
            "`koi tui --resume <id>` to fork from a runtime bound to the " +
            "loaded session.",
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
          // Block `/clear` in picker mode: `tuiSessionId` is still
          // bound to the startup session, so a truncate would delete
          // the unrelated startup archive instead of clearing the
          // visible (picker-loaded) session. That is destructive
          // data loss AND a privacy failure for the picked session,
          // which stays intact on disk.
          if (isInPickerMode()) {
            store.dispatch({
              kind: "add_error",
              code: "CLEAR_AFTER_PICKER_LOAD",
              message:
                "/clear is disabled after loading a saved session via the picker — " +
                "the command would erase this process's original session, not the " +
                "one you are viewing. Quit and relaunch with " +
                "`koi tui --resume <id>` if you want to continue the loaded session " +
                "with full clear/rewind support.",
            });
            break;
          }
          rewindBoundaryActive = true;
          clearedThisProcess = true;
          postClearTurnCount = 0;
          resetConversation({ truncatePersistedTranscript: true });
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
            // Refuse rewind in picker mode. The checkpoint chain
            // is keyed on the startup session id and was built
            // from the original session's turns, so rewinding
            // would walk back into snapshots that belong to a
            // different conversation than the one the user is
            // currently viewing. See `isInPickerMode` above.
            if (isInPickerMode()) {
              store.dispatch({
                kind: "add_error",
                code: "REWIND_AFTER_PICKER_LOAD",
                message:
                  "Rewind is disabled after loading a saved session via the picker — " +
                  "the rewind chain belongs to this process's original session, not the " +
                  "loaded one. Quit and relaunch with `koi tui --resume <id>` to get a " +
                  "fresh rewind chain for the loaded session.",
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

            // Bound rewind to turns taken AFTER the most recent
            // boundary — either an explicit `/clear` / `/new` in
            // this process, OR the resume point itself when the
            // TUI was launched with `--resume`. The checkpoint
            // chain is still physically reachable via
            // `runtime.sessionId` and may contain pre-boundary
            // snapshots (from a prior process, or from before
            // `/clear`), so an unbounded rewind would restore
            // workspace state the user explicitly asked to drop.
            // Letting rewind walk back up to `postClearTurnCount`
            // keeps the rollback-safety affordance for mistakes
            // made in the current session while still enforcing
            // the privacy/context fence.
            if (rewindBoundaryActive && n > postClearTurnCount) {
              const boundaryLabel =
                flags.resume !== undefined && postClearTurnCount === 0
                  ? "resume point"
                  : "most recent /clear or /new boundary";
              store.dispatch({
                kind: "add_error",
                code: "REWIND_ACROSS_CLEAR_BOUNDARY",
                message:
                  `Rewind depth ${n} would cross the ${boundaryLabel} ` +
                  `(${postClearTurnCount} turn${postClearTurnCount === 1 ? "" : "s"} ` +
                  "since that boundary). Rewinding past it would restore file " +
                  "state from before the boundary, which may belong to a prior " +
                  "process or a cleared conversation. Rewind at most " +
                  `${postClearTurnCount} turn${postClearTurnCount === 1 ? "" : "s"}, or ` +
                  "start a fresh koi tui session to rewind earlier work.",
              });
              return;
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
            // Shrink the post-clear rewind budget to match the
            // number of turns actually rolled back. Without this,
            // chained rewinds would cumulatively cross the clear
            // boundary: `/clear`, 3 turns, `/rewind 2` (allowed),
            // `/rewind 2` again (previously allowed because the
            // counter still said 3 — but only 1 post-clear turn
            // remained, so the second rewind would walk back
            // through the clear boundary and restore pre-clear
            // state). Clamp to 0 so an over-rewind doesn't
            // accidentally permit negative-budget rewinds.
            if (rewindBoundaryActive) {
              postClearTurnCount = Math.max(0, postClearTurnCount - result.turnsRewound);
            }

            // After a successful rewind the restore protocol has already
            // truncated the JSONL transcript to the target turn's entry
            // count. Mirror the session-resume flow: call resetConversation
            // so the engine's internal state (task board, trajectory, abort
            // controller, batcher) is rebuilt, then await resetBarrier so
            // the async reset is complete before we push the retained
            // entries back in. Without the reset, the next user submit
            // runs against a stale engine state and produces no output.
            // `truncatePersistedTranscript: false` because the restore
            // protocol has already shrunk the JSONL to the target turn
            // count — an extra truncate would wipe the kept prefix.
            resetConversation({ truncatePersistedTranscript: false });
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
          // Same guard as agent:clear — see the comment there for
          // the data-loss rationale.
          if (isInPickerMode()) {
            store.dispatch({
              kind: "add_error",
              code: "NEW_AFTER_PICKER_LOAD",
              message:
                "/new is disabled after loading a saved session via the picker — " +
                "the command would erase this process's original session, not the " +
                "one you are viewing. Quit and relaunch with " +
                "`koi tui --resume <id>` if you want to continue the loaded session.",
            });
            break;
          }
          rewindBoundaryActive = true;
          clearedThisProcess = true;
          postClearTurnCount = 0;
          resetConversation({ truncatePersistedTranscript: true });
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
      // Atomic session-switch flow, in three phases:
      //   1. Abort + drain the current in-flight run IMMEDIATELY so
      //      no long-running tool or side-effecting turn can keep
      //      mutating workspace / remote / transcript state while
      //      we're loading the target session.
      //   2. Non-destructively validate/load the target session.
      //      If the target is missing or corrupt, surface an error
      //      without touching the live JSONL file.
      //   3. On success, non-destructively reset the UI/runtime
      //      memory and hydrate it from the validated target. The
      //      on-disk `<tuiSessionId>.jsonl` is intentionally left
      //      untouched — see the comment in phase 3 for rationale.
      //
      // Fast path: selecting the session the user is ALREADY
      // viewing is a no-op refresh — just close the picker and
      // leave everything alone. Comparing against
      // `viewedSessionId` (not `tuiSessionId`) is important: after
      // a picker load the two diverge, and selecting the
      // originally-viewed conversation from the picker should
      // still reload it so the user can get back to the startup
      // session after inspecting an archive. The earlier version
      // of this guard compared to `tuiSessionId`, which meant
      // picking the original session after an archive load was
      // silently ignored and stranded the user in the archive.
      if (selectedId === String(viewedSessionId)) {
        store.dispatch({ kind: "set_view", view: "conversation" });
        return;
      }
      store.dispatch({ kind: "set_view", view: "conversation" });

      // Latch `pendingSessionSwitch` BEFORE any await so every
      // picker-mode guard (submit/clear/new/rewind/fork) fires
      // during the async load window. Without this, a fast submit
      // in the window between click and hydration would hit the
      // startup session and silently mutate the wrong transcript.
      // Cleared in the finally below, regardless of whether the
      // load succeeded or failed.
      pendingSessionSwitch = true;

      void (async (): Promise<void> => {
        store.dispatch({ kind: "set_connection_status", status: "connected" });
        try {
          // Runtime must be ready so we have a handle to prime after
          // the reset. Any prior reset barrier must also settle first.
          if (runtimeHandle === null) {
            await runtimeReady;
          }
          await resetBarrier;

          // Phase 1: abort the active turn and wait for the drain
          // to settle before we even LOOK at the target file. This
          // prevents a long-running tool on the outgoing session
          // from continuing to mutate state while the user has
          // already moved on. Abort is a signal, so we also await
          // `activeRunPromise` to make sure the stream (and the
          // session-transcript middleware's finally-block append)
          // has fully unwound.
          activeController?.abort();
          activeController = null;
          const inflightRun = activeRunPromise;
          if (inflightRun !== null) {
            try {
              await inflightRun;
            } catch {
              /* already reported upstream via add_error */
            }
          }

          // Phase 2: non-destructive validate/load of the target.
          // resumeForSession wraps `jsonlTranscript.load()` internally,
          // so a load failure (missing file, parse error, repair
          // abort) surfaces here without having touched anything.
          const targetSid = sessionId(selectedId);
          const resumeResult = await resumeForSession(targetSid, jsonlTranscript);
          if (!resumeResult.ok) {
            store.dispatch({
              kind: "add_error",
              code: "SESSION_RESUME_ERROR",
              message: `Could not load session: ${resumeResult.error.message}`,
            });
            return;
          }

          // Phase 3: target is valid. Reset the live session NON-
          // DESTRUCTIVELY — clear the UI and rebuild in-memory
          // state — but LEAVE the on-disk `<tuiSessionId>.jsonl`
          // untouched. The live file belongs to the startup
          // session id and must survive the switch; overwriting it
          // destroys any work done before the pick and leaves the
          // post-quit resume hint pointing at a file whose
          // identity no longer matches that work. The abort in
          // phase 1 already took care of stopping the outgoing
          // stream, so resetConversation's internal abort is a
          // no-op here.
          resetConversation({ truncatePersistedTranscript: false });
          await resetBarrier;

          // Step 3: hydrate memory + UI from the validated target.
          // The picked session is loaded into the runtime's
          // in-memory transcript so the model sees the prior context
          // on the next turn, and into the TUI store so the user
          // sees it rendered. The picked session's JSONL file is
          // NOT copied anywhere on disk — it remains the
          // authoritative archive under its own id. If the user
          // wants to durably continue the picked session rather than
          // the live one, they should quit and relaunch with
          // `koi tui --resume <pickedId>`.
          if (runtimeHandle !== null) {
            for (const msg of resumeResult.value.messages) {
              runtimeHandle.transcript.push(msg);
            }
          }
          store.dispatch({
            kind: "load_history",
            messages: resumeResult.value.messages,
          });
          // Lock the session into read-only picker mode. Subsequent
          // submissions and `/rewind` are refused because the runtime
          // still routes writes to the startup session id and the
          // checkpoint chain still belongs to that session — allowing
          // mutation would silently mix the picked conversation with
          // the startup archive and let `/rewind` walk across the
          // pick boundary. The user is pointed at
          // `koi tui --resume <pickedId>` as the correct way to
          // durably continue the picked session.
          //
          // Rotate the VIEWED session id so the status-bar chip,
          // the post-quit resume hint, and every picker-mode
          // guard all use the conversation on screen. The runtime
          // routing key stays `tuiSessionId`. Because
          // `isInPickerMode()` is derived from
          // `viewedSessionId !== tuiSessionId`, the read-only
          // guards auto-enable here AND auto-disable again the
          // moment the user picks the startup session back.
          viewedSessionId = targetSid;
          store.dispatch({
            kind: "set_session_info",
            modelName,
            provider,
            sessionName: "",
            sessionId: targetSid,
          });
        } finally {
          // Release the pre-await latch so picker-mode guards go
          // back to being derived purely from
          // `viewedSessionId !== tuiSessionId`. This runs on both
          // success (where viewedSessionId has been rotated) and
          // failure (where it has not), so the guards settle on
          // the correct post-flow state in either case.
          pendingSessionSwitch = false;
          store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        }
      })();
    },
    syntaxStyle: SyntaxStyle.create(),
    treeSitterClient,
    onSubmit: async (text: string): Promise<void> => {
      // Fail closed after a durable clear failure. If the last
      // `/clear` or `/new` could not truncate the JSONL, the
      // file still contains pre-clear content the user asked to
      // drop. Accepting new turns would mix them into that
      // unwanted history and a later `--resume` would replay the
      // combined conversation. Block submits until the user
      // resolves the underlying I/O issue and quits/relaunches.
      if (clearPersistFailed) {
        store.dispatch({
          kind: "add_error",
          code: "SUBMIT_AFTER_FAILED_CLEAR",
          message:
            "Submit is disabled because the most recent /clear or /new could not " +
            "durably truncate this session's transcript. New turns would append to " +
            "the pre-clear content and a later `--resume` would resurrect it. " +
            "Quit and relaunch, or resolve the underlying I/O issue and retry /clear.",
        });
        return;
      }
      // Picker-loaded sessions are read-only: the runtime is still
      // bound to the startup session id, so submitting would mix
      // the picked conversation into the startup archive. See
      // `isInPickerMode` above. The moment the user switches back
      // to the startup session via the picker this check fails
      // and submit re-enables.
      if (isInPickerMode()) {
        store.dispatch({
          kind: "add_error",
          code: "SUBMIT_AFTER_PICKER_LOAD",
          message:
            "This TUI process loaded a saved session via the picker, which is read-only. " +
            "Quit and relaunch with `koi tui --resume <id>` to durably continue the loaded session.",
        });
        return;
      }
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
        const drainPromise = drainEngineStream(stream, store, batcher, controller.signal);
        activeRunPromise = drainPromise;
        await drainPromise;

        // Count the turn for rewind boundary enforcement, but ONLY
        // when the turn completed uninterrupted. `drainEngineStream`
        // synthesizes a `done` event on abort and returns normally,
        // so a simple settle-check would count aborted turns as
        // rewindable — but checkpoint capture (which advances the
        // chain) only runs on real engine-complete turns. Counting
        // an interrupted turn would let `/rewind 1` walk past the
        // clear boundary and restore pre-clear state, silently
        // violating the privacy fence. Treat a signal that was
        // aborted at any point during the drain as "no new
        // checkpoint snapshot", which matches the chain's actual
        // state after the restore protocol settles.
        if (rewindBoundaryActive && !controller.signal.aborted) {
          postClearTurnCount += 1;
        }

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
          activeRunPromise = null;
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

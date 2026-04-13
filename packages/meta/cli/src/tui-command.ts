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
import type {
  AuditEntry,
  EngineEvent,
  JsonObject,
  RichTrajectoryStep,
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
import type {
  EventBatcher,
  LedgerAuditEntry,
  SessionSummary,
  TrajectoryStepSummary,
  TuiStore,
} from "@koi/tui";
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

/**
 * Detect turn index for each step.
 *
 * Turn 0 = session setup steps before the first user turn.
 * Turn 1+ = user turns (1-based).
 *
 * Signal priority (first match wins):
 *   1. `tui_turn_start` synthetic step — written by the TUI before each run().
 *      This is a reliable cross-run boundary marker.
 *   2. `metadata.turnIndex` from event-trace — 0-based ctx.turnIndex.
 *      Useful inside a single run() with multiple sub-turns (agent loops).
 *   3. `metadata.totalMessages` delta ≥ 2 — fallback for older ATIF fixtures.
 */
function computeTurnIndices(steps: readonly RichTrajectoryStep[]): readonly number[] {
  let currentTurnIdx = 0;
  let lastMsgCount: number | undefined;
  return steps.map((step) => {
    // Primary: synthetic tui_turn_start boundary injected before each run()
    if (step.metadata?.type === "tui_turn_start") {
      const rawTurn = step.metadata?.tuiTurnIndex;
      currentTurnIdx = (typeof rawTurn === "number" ? rawTurn : currentTurnIdx) + 1;
      return currentTurnIdx;
    }
    if (step.source === "agent" && step.kind === "model_call") {
      // Secondary: ctx.turnIndex from event-trace (sub-turns within a single run)
      const rawTurn = step.metadata?.turnIndex;
      if (typeof rawTurn === "number" && rawTurn > 0) {
        currentTurnIdx = currentTurnIdx + rawTurn;
      } else {
        // Fallback: totalMessages delta for ATIF fixtures
        const rawCount = step.metadata?.totalMessages;
        const count = typeof rawCount === "number" ? rawCount : undefined;
        if (lastMsgCount === undefined) {
          if (currentTurnIdx === 0) currentTurnIdx = 1;
        } else if (count !== undefined && count - lastMsgCount >= 2) {
          currentTurnIdx++;
        }
        if (count !== undefined) lastMsgCount = count;
      }
    }
    return currentTurnIdx;
  });
}

/** Map rich trajectory steps to TUI summaries with content for expandable detail. */
function mapTrajectorySteps(
  steps: readonly RichTrajectoryStep[],
): readonly TrajectoryStepSummary[] {
  const turnIndices = computeTurnIndices(steps);
  return steps.map((step, i) => ({
    stepIndex: step.stepIndex,
    turnIndex: turnIndices[i] ?? 0,
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
            decisions: Array.isArray(step.metadata.decisions)
              ? (step.metadata.decisions as readonly JsonObject[])
              : undefined,
          }
        : undefined,
  }));
}

/** Map an AuditEntry to a TUI-friendly summary. */
function mapAuditEntry(entry: AuditEntry): LedgerAuditEntry {
  const summary =
    entry.kind === "tool_call" && entry.request !== undefined
      ? `tool: ${JSON.stringify(entry.request).slice(0, 120)}`
      : entry.kind === "permission_decision" && entry.response !== undefined
        ? `perm: ${JSON.stringify(entry.response).slice(0, 120)}`
        : `${entry.agentId} turn:${entry.turnIndex} ${entry.durationMs}ms`;
  return { timestamp: entry.timestamp, kind: entry.kind, summary };
}

/** Map DecisionLedger SourceStatus to a simple string label. */
function mapSourceState(status: { readonly state: string }): string {
  return status.state;
}

/**
 * Build a compact run-report summary string for the TUI's `/trajectory` view
 * without serializing the full report tree. Avoids the avoidable
 * `JSON.stringify` of nested `childReports` on every refresh, which can
 * spike CPU/memory when a delegated run has a large nested report. (#1764)
 *
 * Picks: high-level summary text (truncated), action / artifact / issue /
 * recommendation counts, child-report count, and total token usage. Output
 * is deterministic and bounded by RUN_REPORT_SUMMARY_MAX_CHARS irrespective
 * of report depth.
 */
const RUN_REPORT_SUMMARY_MAX_CHARS = 300;
const RUN_REPORT_SUMMARY_TEXT_BUDGET = 180;
/** @internal — exported for unit tests only. */
export function summarizeRunReport(runReport: {
  readonly summary?: string;
  readonly actions?: { readonly length: number };
  readonly artifacts?: { readonly length: number };
  readonly issues?: { readonly length: number };
  readonly recommendations?: { readonly length: number };
  readonly childReports?: { readonly length: number } | undefined;
  readonly cost?: { readonly totalTokens?: number };
}): string {
  const summaryText =
    typeof runReport.summary === "string"
      ? runReport.summary.length > RUN_REPORT_SUMMARY_TEXT_BUDGET
        ? `${runReport.summary.slice(0, RUN_REPORT_SUMMARY_TEXT_BUDGET - 1)}…`
        : runReport.summary
      : "";
  const actions = runReport.actions?.length ?? 0;
  const artifacts = runReport.artifacts?.length ?? 0;
  const issues = runReport.issues?.length ?? 0;
  const recommendations = runReport.recommendations?.length ?? 0;
  const children = runReport.childReports?.length ?? 0;
  const totalTokens = runReport.cost?.totalTokens ?? 0;
  const counts = `actions=${actions} artifacts=${artifacts} issues=${issues} recs=${recommendations} children=${children} tokens=${totalTokens}`;
  const composed = summaryText !== "" ? `${summaryText} · ${counts}` : counts;
  return composed.length > RUN_REPORT_SUMMARY_MAX_CHARS
    ? composed.slice(0, RUN_REPORT_SUMMARY_MAX_CHARS - 1) + "…"
    : composed;
}

/**
 * Refresh trajectory + ledger data and dispatch to the TUI store.
 *
 * Uses the decision ledger as the single data source for all three lanes
 * (trajectory, audit, report). Falls back to raw getTrajectorySteps()
 * if the ledger query fails.
 *
 * Stale-refresh guard (#1764): callers schedule this fire-and-forget on a
 * 500 ms delay after the turn completes. If `resetConversation()` /
 * `session:new` runs in that window, `isStillCurrent()` flips and the
 * dispatch is skipped — otherwise the post-reset store would be
 * repopulated with the prior session's trajectory.
 */
async function refreshTrajectoryData(
  handle: TuiRuntimeHandle,
  store: TuiStore,
  currentSessionId: string,
  isStillCurrent: () => boolean,
): Promise<void> {
  const reader = handle.createDecisionLedger();
  const result = await reader.getLedger(currentSessionId);
  if (!isStillCurrent()) return;
  if (result.ok) {
    const ledger = result.value;
    store.dispatch({
      kind: "set_trajectory_data",
      steps: mapTrajectorySteps(ledger.trajectorySteps),
      auditEntries: ledger.auditEntries.map(mapAuditEntry),
      ledgerSources: {
        trajectory: mapSourceState(ledger.sources.trajectory),
        audit: mapSourceState(ledger.sources.audit),
        report: mapSourceState(ledger.sources.report),
      },
      runReportSummary:
        ledger.runReport !== undefined ? summarizeRunReport(ledger.runReport) : undefined,
    });
  } else {
    // Fallback: raw trajectory steps without ledger enrichment
    const steps = await handle.getTrajectorySteps();
    if (!isStillCurrent()) return;
    store.dispatch({ kind: "set_trajectory_data", steps: mapTrajectorySteps(steps) });
  }
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
 * Number of text/thinking deltas to accumulate before yielding to the render
 * loop. Lower values = smoother streaming; higher values = less overhead.
 * 3 is the sweet spot: ~12 chars per flush at typical token sizes.
 */
const STREAM_FLUSH_EVERY_N = 3;

/**
 * Minimum milliseconds between event-loop yields during text/thinking streaming.
 *
 * OpenTUI's CliRenderer runs in on-demand mode (not a continuous render loop).
 * After the first render frame, `requestRender()` schedules the next frame via
 * `setTimeout(~16ms)` (matching `minTargetFrameTime = 1000/maxFps`). If we
 * yield to the event loop sooner than 16ms, the render timer hasn't fired yet,
 * so the yield is wasted — the loop resumes and processes more deltas without
 * any visual update.
 *
 * By aligning yields with the render cadence (~16ms), each yield allows exactly
 * one render frame to paint, producing smooth progressive streaming at ~60fps.
 *
 * The old approach (count-based every 3 deltas, yield via setTimeout(0)) caused
 * all deltas to process within one render interval because setTimeout(0) only
 * pauses for ~1ms, far shorter than the 16ms render frame timer. The result:
 * "Thinking..." then the entire response appearing at once.
 */
const STREAM_YIELD_INTERVAL_MS = 16;

/**
 * Drain an async engine event stream into the store via the batcher.
 *
 * Streaming strategy (inspired by OpenCode's event bus architecture):
 *
 * 1. **Lifecycle events flush immediately and separately.** `turn_start`,
 *    `turn_end`, and `done` each get their own flush so the UI sees the
 *    streaming indicator BEFORE any text arrives and the finalization
 *    AFTER all text has rendered.
 *
 * 2. **Text/thinking deltas bypass the batcher.** They go directly to
 *    `store.streamDelta()` which uses a produce()-based O(1) path update
 *    instead of reconcile()'s O(state-tree) diff — enabling per-delta
 *    rendering without performance penalty. Every N deltas the loop
 *    yields to the event loop so the HTTP stream continues and OpenTUI
 *    can paint.
 *
 * 3. **Tool lifecycle events use the batcher** at the normal 16ms cadence.
 *
 * Sets connection status to "connected" before streaming, "disconnected" after.
 * On stream failure: dispatches add_error + disconnected.
 *
 * Exported for testing. Not part of the public @koi/tui API.
 */
/**
 * #1742 loop-3 round 8: dispatch a synthetic terminal `done` event
 * directly to the store when the batcher has been disposed mid-stream.
 *
 * Bypasses the dead batcher (which would otherwise drop the event)
 * by routing through `dispatchBatch` shape — `engine_event` action.
 * The reducer closes any active assistant turn and clears the
 * "processing" status. Safe in both reset paths: in the success
 * path the store was already cleared so this is a no-op; in the
 * failed-reset path it leaves the preserved transcript with a
 * coherent terminal state instead of stuck running.
 */
function finalizeAbandonedStream(
  store: TuiStore,
  partialInputTokens: number,
  partialOutputTokens: number,
): void {
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
  store.dispatch({ kind: "engine_event", event: syntheticDone });
}

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
    // `let` justified: tracks last yield time for frame-rate-aligned yielding
    let lastYieldAt = Date.now();
    // `let` justified: counts deltas since last yield for burst detection
    let deltasSinceYield = 0;

    for await (const event of stream) {
      // #1742: if resetConversation() disposed our batcher mid-stream, stop
      // feeding events into a dead sink — they would silently vanish and
      // leave the UI with a half-rendered or missing reply. The drain exits
      // cleanly; the caller's finally block handles connection-status reset.
      if (batcher.isDisposed) {
        finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
        return;
      }

      // --- Usage tracking (unchanged) ---
      if (event.kind === "custom" && event.type === "usage") {
        const usage = event.data as { inputTokens?: number; outputTokens?: number };
        if (typeof usage.inputTokens === "number") {
          partialInputTokens = usage.inputTokens;
        }
        if (typeof usage.outputTokens === "number") {
          partialOutputTokens = usage.outputTokens;
        }
      }

      // --- Lifecycle events: flush before AND after to isolate them ---
      // This ensures turn_start creates the streaming message before any
      // deltas arrive, and turn_end/done closes it only after all deltas
      // have been rendered. Without this, they can land in the same batch
      // and the UI never sees the intermediate streaming state.
      if (event.kind === "turn_start" || event.kind === "turn_end" || event.kind === "done") {
        batcher.flushSync();
        batcher.enqueue(event);
        batcher.flushSync();
        await yieldForRenderFrame();
        lastYieldAt = Date.now();
        deltasSinceYield = 0;
        continue;
      }

      // --- Text/thinking deltas: fast path via store.streamDelta() ---
      // Bypasses the batcher entirely. Each delta fires a surgical O(1)
      // store update (produce-based path setter), rendering immediately.
      //
      // Hybrid yielding: yield on EITHER count (N deltas) OR time (16ms),
      // whichever comes first. The count trigger catches burst-delivered
      // chunks that process faster than Date.now() resolution. The time
      // trigger aligns with OpenTUI's render cadence.
      //
      // Critically, yieldForRenderFrame() waits ~16ms (not 0ms) so the
      // OpenTUI render timer actually fires during the pause, producing
      // a visible paint before the loop resumes.
      if (event.kind === "text_delta" || event.kind === "thinking_delta") {
        const blockKind = event.kind === "text_delta" ? "text" : "thinking";
        store.streamDelta(event.delta, blockKind);
        deltasSinceYield++;

        const now = Date.now();
        if (
          deltasSinceYield >= STREAM_FLUSH_EVERY_N ||
          now - lastYieldAt >= STREAM_YIELD_INTERVAL_MS
        ) {
          await yieldForRenderFrame();
          lastYieldAt = Date.now();
          deltasSinceYield = 0;
        }
        continue;
      }

      // --- All other events: batcher at normal cadence ---
      batcher.enqueue(event);
      // #1742: batcher may have been disposed between the top-of-loop
      // check and this enqueue. enqueue is a no-op on disposed batcher.
      if (batcher.isDisposed) {
        finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
        return;
      }
      if (
        event.kind === "tool_call_start" ||
        event.kind === "tool_call_delta" ||
        event.kind === "tool_call_end" ||
        event.kind === "tool_result"
      ) {
        const now = Date.now();
        if (now - lastYieldAt >= STREAM_YIELD_INTERVAL_MS) {
          batcher.flushSync();
          await yieldForRenderFrame();
          lastYieldAt = Date.now();
          deltasSinceYield = 0;
        }
      }
    }
    // #1742 loop-3 round 10: cover the race where the batcher was
    // disposed AFTER the per-iteration check but BEFORE we got a
    // chance to enqueue the terminal event (or where the stream
    // ended normally on the same tick disposal happened). Without
    // this final check, the stream's terminal `done` is silently
    // dropped and finalizeAbandonedStream is never called — the
    // UI can stay stuck in "processing".
    if (batcher.isDisposed) {
      finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
      return;
    }
    batcher.flushSync();
  } catch (e: unknown) {
    // #1742: the batcher may have been disposed by resetConversation() while
    // the stream was still producing. Finalize the active turn before
    // returning so a failed-reset (history preserved) path still ends
    // with the reducer in idle/error state instead of stuck "processing".
    if (batcher.isDisposed) {
      finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
      return;
    }
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

/**
 * Yield for one render frame so OpenTUI actually paints to the terminal.
 *
 * OpenTUI's on-demand renderer schedules frames via `setTimeout(~16ms)`.
 * A `setTimeout(0)` yield only pauses for ~1ms — the render timer hasn't
 * fired yet, so no paint occurs. By waiting `STREAM_YIELD_INTERVAL_MS`
 * (16ms), the pending render timer fires during the pause, producing a
 * visible update before the stream loop resumes.
 *
 * This is the critical difference: `setTimeout(0)` = microtask-level yield
 * (no paint); `setTimeout(16)` = frame-aligned yield (paint happens).
 */
function yieldForRenderFrame(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, STREAM_YIELD_INTERVAL_MS));
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
    // #1759: interactive users get effectively unbounded decide-time on
    // permission prompts (60 minutes). Much longer than any reasonable
    // human decision window, but still finite so a wedged renderer /
    // stuck input / detached terminal eventually fails closed instead
    // of hanging forever. Aligned with the engine-side TUI_APPROVAL_TIMEOUT_MS
    // in tui-runtime.ts so both layers share the same deadline.
    timeoutMs: 60 * 60 * 1000,
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
    // Order matters here. The permissions middleware races the approval
    // handler against `ctx.signal` (see handleAskDecision). If
    // `cancelPending` runs first, the approval Promise settles with a
    // synthetic `{kind:"deny"}` BEFORE the abort signal fires — the
    // middleware then treats the turn as a normal permission denial
    // and emits the wrong stopReason. Aborting the controller first
    // means the signal is already raised when the deny resolves, so the
    // middleware's signal-race branch wins and the turn ends as
    // `stopReason: "interrupted"`. The cancelPending call still runs to
    // dismiss the modal and keep the bridge usable for the next turn.
    // (#1759 review round 5)
    activeController?.abort();
    permissionBridge.cancelPending("Turn cancelled by user");
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
  // #1742 loop-3 round 4: resolve to `true` when the reset committed,
  // `false` when it failed-closed (cycleSession TIMEOUT, onSessionEnd
  // poison, board pre-create error). Callers that depend on a clean
  // session boundary (onSessionSelect, /rewind hydration) MUST check
  // the value before loading history, otherwise they'd hydrate stale
  // transcript into a runtime whose engine session never rotated.
  // onSubmit can ignore the value — it just blocks until the reset
  // settles, then the run() guard catches whatever state the runtime
  // is actually in.
  let resetBarrier: Promise<boolean> = Promise.resolve(true);

  // Monotonically increasing TUI-session turn counter. Resets on session clear.
  // Injected as a synthetic ATIF step before each run() so /trajectory can
  // group steps by user turn regardless of engine-internal ctx.turnIndex resets.
  // let: justified — incremented per user submission
  let tuiTurnCounter = 0;

  // Generation token for asynchronous /trajectory refreshes (#1764). Each
  // call to `resetConversation()` increments this; in-flight refreshes
  // capture the value at scheduling time and skip their dispatch if the
  // generation has advanced. Without this, a delayed refresh from turn N
  // can repopulate the just-cleared store with that turn's stale data
  // after a session:new / resume / agent:clear runs.
  // let: justified — incremented per session reset
  let trajectoryRefreshGen = 0;

  const resetConversation = (): void => {
    // Abort the active controller first — C4-A ordering constraint requires
    // signal.aborted === true before calling resetSessionState().
    activeController?.abort();
    activeController = null;

    // Cancel any pending permission prompts and dismiss the modal so a
    // session reset (`agent:clear`, `session:new`, resume) doesn't leave
    // the user stuck behind a stale 60-minute approval window. The bridge
    // stays usable for the next turn. (#1759 review round 2)
    permissionBridge.cancelPending("Session reset");

    // dispose() drops the buffer without flushing — the in-flight drainEngineStream
    // still holds the old batcher ref, so its later enqueue/flushSync are no-ops.
    batcher.dispose();
    batcher = createEventBatcher<EngineEvent>(dispatchBatch);

    // Invalidate any in-flight refreshTrajectoryData() that was scheduled
    // before this reset — its captured gen will no longer match. The
    // destructive store clearing (clear_messages, set_trajectory_data,
    // tuiTurnCounter) is deferred to the resetSessionState success branch
    // per the #1742 fail-closed contract, but the generation bump must
    // fire IMMEDIATELY so a late refresh cannot race ahead of that branch
    // and repopulate stale lanes in the window between here and the
    // success callback. The counter is local state, not store state, so
    // it's safe to bump eagerly. (#1764)
    trajectoryRefreshGen += 1;

    // #1742 loop-2 round 5: do NOT clear the visible transcript or splice
    // runtimeHandle.transcript until resetSessionState() actually resolves.
    // resetSessionState fails closed on cycleSession TIMEOUT — if we wiped
    // the screen first, the user would lose all visible history while
    // approvals/memory/etc were still in the wedged old session. The user
    // is then debugging blind. Defer destructive cleanup to the success
    // branch; on failure leave the screen intact and surface an error
    // banner so the operator can inspect what wedged.
    if (runtimeHandle !== null) {
      const idleController = new AbortController();
      idleController.abort();
      resetBarrier = runtimeHandle
        .resetSessionState(idleController.signal)
        .then((): boolean => {
          // Only NOW that the engine confirmed the session was rotated
          // do we wipe visible state. Order: store messages, trajectory
          // + audit ledger, runtime transcript, TUI turn counter.
          store.dispatch({ kind: "clear_messages" });
          store.dispatch({ kind: "set_trajectory_data", steps: [], auditEntries: [] });
          runtimeHandle?.transcript.splice(0);
          tuiTurnCounter = 0;
          // /clear is silent on success — a freshly cleared conversation
          // is its own acknowledgement. If the user later hits the
          // cumulative runtime-wide spend cap (which survives /clear by
          // design — iteration budget resets, token accounting does not),
          // the budget-exceeded error itself surfaces the explanation.
          // Post-reset toast removed per #1764 review (was originally
          // added by #1742 as a RESET_NOTICE but mimicked an error).
          return true;
        })
        .catch((resetError: unknown): boolean => {
          const message = resetError instanceof Error ? resetError.message : String(resetError);
          store.dispatch({
            kind: "add_error",
            code: "RESET_FAILED",
            message: `Session reset failed: ${message}. Visible history preserved. Please restart koi tui to recover.`,
          });
          // Leave store messages, trajectory, and runtime transcript
          // intact so the operator still has the conversation context
          // to inspect / decide how to recover. Resolve the barrier
          // with `false` so callers (onSessionSelect, /rewind) know
          // not to hydrate history into a still-stale runtime.
          return false;
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
        // #1742 loop-2 round 10: dispose now fails closed on settle
        // timeout. Catch the throw so the rest of shutdown (approval
        // store close, process.exit) still runs. The hard-exit timer
        // is the ultimate failsafe if process.exit itself wedges.
        try {
          await runtimeHandle.runtime.dispose();
        } catch (disposeErr) {
          process.stderr.write(
            `[koi tui] runtime.dispose failed during shutdown: ${
              disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
            }\n`,
          );
        }
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
            // #1742 loop-3 round 4: do NOT hydrate history if the reset
            // failed-closed (cycleSession TIMEOUT, onSessionEnd poison,
            // pre-flight error). The engine session never rotated, so
            // loading the rewound transcript on top would mix old
            // approvals/memory/board state with the new history.
            const rewindResetOk = await resetBarrier;
            if (!rewindResetOk) {
              store.dispatch({
                kind: "add_error",
                code: "REWIND_ABORTED",
                message:
                  "Rewind aborted: session reset failed. Restart koi tui and retry the rewind on a fresh runtime.",
              });
              return;
            }
            // #1742 loop-3 round 5: load and validate the transcript
            // BEFORE rebinding the runtime. If the JSONL is missing or
            // corrupt, surface the error and leave the runtime on the
            // freshly-rotated post-reset session id rather than
            // adopting an id the host could not actually load.
            const resumeResult = await resumeForSession(engineSessionId, jsonlTranscript);
            if (resumeResult.ok) {
              // Rebind the engine sessionId BACK to the rewound
              // session id so future turns/checkpoints persist on
              // the same chain instead of orphaning to the rotated
              // post-reset uuid. Mirrors the round-4 fix in
              // onSessionSelect.
              if (runtimeHandle.runtime.rebindSessionId !== undefined) {
                try {
                  runtimeHandle.runtime.rebindSessionId(String(engineSessionId));
                } catch (rebindErr) {
                  store.dispatch({
                    kind: "add_error",
                    code: "REWIND_ABORTED",
                    message: `Rewind aborted: cannot rebind runtime to session ${String(engineSessionId)}: ${
                      rebindErr instanceof Error ? rebindErr.message : String(rebindErr)
                    }`,
                  });
                  return;
                }
              }
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
            // Refresh the trajectory + decision ledger view so the step
            // shows up without waiting for the next turn. Capture the
            // current generation so a subsequent reset invalidates this
            // refresh before it dispatches. (#1764)
            const rewindGen = trajectoryRefreshGen;
            void refreshTrajectoryData(
              runtimeHandle,
              store,
              runtimeHandle.runtime.sessionId,
              () => trajectoryRefreshGen === rewindGen,
            );

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
          // #1742 loop-3 round 4: abort the resume if the reset
          // failed-closed. Hydrating into a runtime whose engine
          // session never rotated would mix stale state with the
          // new history.
          const resumeResetOk = await resetBarrier;
          if (!resumeResetOk) {
            store.dispatch({
              kind: "add_error",
              code: "SESSION_RESUME_ABORTED",
              message:
                "Cannot resume session: reset failed. Restart koi tui and try again on a fresh runtime.",
            });
            return;
          }
          // #1742 loop-3 round 5: load and validate the session FIRST,
          // then rebind only after we know the transcript is good.
          // Round 4 had this in the wrong order — a missing/corrupt
          // session file would leave the runtime adopted to the
          // selected id even though no history was loaded, so the
          // next submit would write into the wrong chain.
          const resumeResult = await resumeForSession(sessionId(selectedId), jsonlTranscript);
          if (!resumeResult.ok) {
            store.dispatch({
              kind: "add_error",
              code: "SESSION_RESUME_ERROR",
              message: `Could not load session: ${resumeResult.error.message}`,
            });
            return;
          }
          // Transcript loaded successfully — now rebind the engine
          // sessionId to the user-selected one. cycleSession (called
          // via resetConversation above) rotated to a fresh UUID;
          // without rebinding, future turns persist under the new id
          // and orphan the resumed session — so checkpoints, /rewind,
          // and fork all break for the resumed conversation.
          if (runtimeHandle?.runtime.rebindSessionId !== undefined) {
            try {
              runtimeHandle.runtime.rebindSessionId(selectedId);
            } catch (rebindErr) {
              store.dispatch({
                kind: "add_error",
                code: "SESSION_RESUME_ABORTED",
                message: `Cannot rebind runtime to session ${selectedId}: ${
                  rebindErr instanceof Error ? rebindErr.message : String(rebindErr)
                }`,
              });
              return;
            }
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

      const controller = new AbortController();
      activeController = controller;

      // Inject a synthetic turn-boundary step so /trajectory can group steps
      // by user turn. The engine resets ctx.turnIndex to 0 on each run() call,
      // so we maintain our own counter here at the TUI session level.
      const thisTurnIndex = tuiTurnCounter++;
      await runtimeHandle.appendTrajectoryStep({
        stepIndex: 0,
        timestamp: Date.now(),
        source: "system",
        kind: "tool_call",
        identifier: "koi:tui_turn_start",
        outcome: "success",
        durationMs: 0,
        metadata: {
          type: "tui_turn_start",
          tuiTurnIndex: thisTurnIndex,
        } as import("@koi/core").JsonObject,
      });

      try {
        // A2-A: drive conversation via runtime.run() — the KoiRuntime handles
        // middleware composition, tool dispatch, and transcript management.
        //
        // Loop mode: each user turn becomes a runUntilPass invocation that
        // iterates the agent against --until-pass until convergence. The
        // multiplexing stream below surfaces all iterations' EngineEvents
        // into drainEngineStream so the TUI renders each iteration's model
        // output naturally.
        // run() can throw synchronously when the engine rejects the request
        // (poisoned runtime after a settle timeout, lifecycleInFlight during
        // cycleSession/dispose, disposed runtime, or already-running latch).
        // Catch those here so the user sees a recoverable error toast instead
        // of an unhandled rejection bubbling out of onSubmit.
        //
        // #1742 loop-3 round 3: construct the stream FIRST, dispatch the
        // user message only AFTER stream construction succeeds. Otherwise
        // a synchronous rejection leaves a phantom user message in the
        // visible UI even though no engine stream ever started — the
        // next successful turn would run without that prompt in model
        // context, so users could believe the agent saw a message it
        // never actually received.
        let stream: AsyncIterable<EngineEvent>;
        try {
          stream = isLoopMode
            ? runTuiLoopTurn(handle.runtime, text, controller.signal, flags, store)
            : handle.runtime.run({
                kind: "text",
                text,
                signal: controller.signal,
              });
        } catch (err) {
          store.dispatch({
            kind: "add_error",
            code: "RUNTIME_REJECTED",
            message: err instanceof Error ? err.message : String(err),
          });
          // Reset pendingImages — they were never sent, but they were
          // collected for THIS submit. Don't leak them into the next.
          pendingImages = [];
          return;
        }
        // Stream construction succeeded — now stage the visible user
        // message. The prompt will reach the engine through the stream
        // we just created (which already received the text in run()'s
        // input) so the visible UI and engine transcript stay in sync.
        pendingImages = [];
        store.dispatch({
          kind: "add_user_message",
          id: `user-${Date.now()}`,
          blocks: [{ kind: "text", text }, ...imageBlocks],
        });
        await drainEngineStream(stream, store, batcher, controller.signal);

        // Refresh trajectory + decision ledger data after each turn.
        // Delay 500ms to let fire-and-forget trace-wrapper appends settle —
        // wrapMiddlewareWithTrace records MW spans asynchronously via
        // void store.append(...). Without the delay, getLedger() reads
        // before all spans are written.
        //
        // Capture trajectoryRefreshGen at scheduling time so a session
        // reset that runs in the 500 ms window invalidates this refresh
        // before it dispatches. Otherwise the post-reset store would be
        // repopulated with this turn's stale trajectory. (#1764)
        const submitGen = trajectoryRefreshGen;
        void new Promise<void>((resolve) => setTimeout(resolve, 500)).then(() =>
          refreshTrajectoryData(
            handle,
            store,
            handle.runtime.sessionId,
            () => trajectoryRefreshGen === submitGen,
          ),
        );
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

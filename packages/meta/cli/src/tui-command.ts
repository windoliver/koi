/**
 * `koi tui` command handler.
 *
 * Wires the TUI application shell:
 *   store + permissionBridge + batcher → createTuiApp → handle.start()
 *
 * Runtime assembly is delegated to createKoiRuntime() (tui-runtime.ts) which
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
 * Tools wired (via createKoiRuntime):
 *   Glob, Grep, ToolSearch — codebase search (cwd-rooted)
 *   web_fetch              — HTTP fetch via @koi/tools-web
 *   Bash, bash_background  — shell execution via @koi/tools-bash
 *   fs_read/write/edit     — filesystem via @koi/fs-local
 *   task_*                 — background task management via @koi/task-tools
 *   agent_spawn — real spawning via createSpawnToolProvider (#1582 wired)
 */

import { writeSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { microcompact } from "@koi/context-manager";
import type {
  AuditEntry,
  EngineEvent,
  InboundMessage,
  JsonObject,
  RichTrajectoryStep,
  SessionId,
  SessionTranscript,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { formatCost, formatTokens } from "@koi/core/cost-tracker";
import type { DisplayableResumedMessage } from "@koi/core/message";
import { filterResumedMessagesForDisplay } from "@koi/core/message";
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
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
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
import { formatAtReferencesForModel, resolveAtReferences } from "./at-reference.js";
import { scrubSensitiveEnv } from "./commands/start.js";
import { type CostBridge, createCostBridge } from "./cost-bridge.js";
import { resolveApiConfig } from "./env.js";
import { createFileCompletionHandler } from "./file-completions.js";
import { loadManifestConfig } from "./manifest.js";
import { initOtelSdk } from "./otel-bootstrap.js";
import { formatPickerModeResumeHint, formatResumeHint } from "./resume-hint.js";
import type { KoiRuntimeHandle } from "./runtime-factory.js";
import { createKoiRuntime, TUI_APPROVAL_TIMEOUT_MS } from "./runtime-factory.js";
import { resumeSessionFromJsonl } from "./shared-wiring.js";
import { createUnrefTimer } from "./sigint-handler.js";
import { createTuiSigintHandler } from "./tui-graceful-sigint.js";

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
// Slash-command helpers (system:model, system:cost, session:export, etc.)
// ---------------------------------------------------------------------------

/**
 * Dispatch a system-generated notice as a synthetic user message.
 *
 * Used by /model, /cost, /tokens, /compact, /export, /zoom to surface
 * slash-command output in the conversation stream without polluting the
 * runtime.transcript (which feeds the next model call). Mirrors the fork
 * notice pattern (see the `add_user_message` dispatch in the fork flow).
 */
function dispatchNotice(store: TuiStore, tag: string, text: string): void {
  store.dispatch({
    kind: "add_user_message",
    id: `${tag}-${Date.now()}`,
    blocks: [{ kind: "text", text }],
  });
}

/** Render a displayable transcript as a Markdown document for /export. */
export function renderTranscriptMarkdown(
  messages: readonly DisplayableResumedMessage[],
  info: { readonly sessionId: string; readonly modelName: string; readonly provider: string },
): string {
  const lines: string[] = [];
  lines.push(`# Koi Session ${info.sessionId}`);
  lines.push("");
  lines.push(`- **Model**: ${info.modelName}`);
  lines.push(`- **Provider**: ${info.provider}`);
  lines.push(`- **Exported**: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const msg of messages) {
    lines.push(msg.role === "user" ? "## User" : "## Assistant");
    lines.push("");
    for (const block of msg.content) {
      if (block.kind === "text") {
        lines.push(block.text);
      } else {
        lines.push(`_[${block.kind} block]_`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

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
    ? `${composed.slice(0, RUN_REPORT_SUMMARY_MAX_CHARS - 1)}…`
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
  handle: KoiRuntimeHandle,
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

/**
 * Outcome of a drainEngineStream run.
 *
 * `settled` — the stream finalized into a checkpoint-producing
 * terminal state: happy path (real `done` event observed) or user
 * abort with a clean synthetic done. A snapshot is guaranteed to
 * have been written for this turn, so ALL post-turn bookkeeping is
 * safe, including rewind-budget increment. The happy path still
 * increments rewind; the abort path is filtered out by the existing
 * `!signal.aborted` guard.
 *
 * `engine_error` — a real ENGINE_ERROR was cleanly dispatched. Trace
 * data was captured up to the failure, so observability refresh
 * (trajectory, audit view) must still run — operators debugging a
 * provider failure need to see it. But no rewindable checkpoint was
 * produced, so `postClearTurnCount` MUST NOT advance on this outcome
 * or `/rewind` can step across a clear/resume boundary. (#1753
 * review round 9.)
 *
 * `abandoned` — `resetConversation()` (or another caller) disposed
 * the batcher mid-drain, so the turn was intentionally dropped and
 * the session has already advanced to a new trajectory generation.
 * Any post-turn bookkeeping at this point would write stale cost /
 * trajectory data into the freshly reset UI. Callers MUST skip all
 * bookkeeping on this outcome. (#1753 review round 7.)
 *
 * `failed` — the drain hit a fail-closed path: buffered flush threw
 * and lost events, the finalization handler crashed, or finally had
 * to fail-close itself. The reducer may be in an inconsistent state
 * and callers MUST skip post-turn bookkeeping on this outcome.
 */
export type DrainOutcome = "settled" | "engine_error" | "abandoned" | "failed";

export async function drainEngineStream(
  stream: AsyncIterable<EngineEvent>,
  store: TuiStore,
  batcher: EventBatcher<EngineEvent>,
  signal?: AbortSignal,
): Promise<DrainOutcome> {
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
  // #1753 review: track whether the function has reached one of its
  // intended terminal states (success, clean UI reset, user abort, or
  // real ENGINE_ERROR with its own dispatches). If the function exits
  // with this still false, a flush or dispatch threw somewhere we did
  // not anticipate — the finally block below must fail closed so
  // /doctor cannot report a healthy engine for a drain that crashed
  // during finalization.
  let terminalStateApplied = false;
  // #1753 review round 4: distinguish "drain produced a coherent
  // terminal state" from "finalization failed". Callers gate post-turn
  // bookkeeping (rewind count, cost delta, trajectory refresh) on
  // "settled" so a broken drain cannot advance the session.
  let outcome: DrainOutcome = "failed";
  try {
    // `let` justified: tracks last yield time for frame-rate-aligned yielding
    let lastYieldAt = Date.now();
    // `let` justified: true after the first yield in a delta burst.
    // Ensures at least one mid-stream paint per burst without sleeping
    // on every subsequent delta. Reset by non-delta events (lifecycle, tool).
    let burstYielded = false;

    for await (const event of stream) {
      // #1742: if resetConversation() disposed our batcher mid-stream, stop
      // feeding events into a dead sink — they would silently vanish and
      // leave the UI with a half-rendered or missing reply. The drain exits
      // cleanly; the caller's finally block handles connection-status reset.
      if (batcher.isDisposed) {
        finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
        // #1753 review round 10: a batcher disposed mid-drain
        // means the current turn was torn down. A subsequent
        // resetConversation() may fail closed and never publish
        // a replacement connection state, so the drain must not
        // leave the store asserting "connected" for a channel
        // it no longer owns.
        store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        terminalStateApplied = true;
        outcome = "abandoned";
        return outcome;
      }

      // Debug: log each event kind + timing to stderr when KOI_DEBUG_STREAM=1
      // stderr doesn't interfere with the TUI (alternate screen buffer).
      if (process.env.KOI_DEBUG_STREAM === "1") {
        const elapsed = Date.now() - lastYieldAt;
        const preview =
          event.kind === "text_delta"
            ? ` "${(event as { delta: string }).delta.slice(0, 30)}"`
            : event.kind === "thinking_delta"
              ? ` "${(event as { delta: string }).delta.slice(0, 30)}"`
              : "";
        process.stderr.write(`[stream] +${elapsed}ms ${event.kind}${preview}\n`);
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
        burstYielded = false;
        continue;
      }

      // --- Text/thinking deltas: fast path via store.streamDelta() ---
      // Flush any pending batcher events FIRST to preserve block ordering.
      // Without this, a `tool_call_start` sitting in the batcher would be
      // applied AFTER the text delta, corrupting assistant block order.
      // Then apply the delta via the O(1) produce()-based path setter.
      //
      // Flush pending batcher events first to preserve block ordering —
      // a tool_call_start in the batcher must land before a text_delta.
      //
      // Yield policy: on the first delta of a burst (!burstYielded), yield
      // once so buffered responses get at least one mid-stream paint. After
      // that, yield only when 16ms has elapsed (time-based). This avoids
      // the per-delta sleep that would throttle large replies by seconds.
      if (event.kind === "text_delta" || event.kind === "thinking_delta") {
        batcher.flushSync();
        const blockKind = event.kind === "text_delta" ? "text" : "thinking";
        store.streamDelta(event.delta, blockKind);

        const now = Date.now();
        if (!burstYielded || now - lastYieldAt >= STREAM_YIELD_INTERVAL_MS) {
          await yieldForRenderFrame();
          lastYieldAt = Date.now();
          burstYielded = true;
        }
        continue;
      }

      // --- All other events: batcher at normal cadence ---
      batcher.enqueue(event);
      // #1742: batcher may have been disposed between the top-of-loop
      // check and this enqueue. enqueue is a no-op on disposed batcher.
      if (batcher.isDisposed) {
        finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
        // #1753 review round 10: a batcher disposed mid-drain
        // means the current turn was torn down. A subsequent
        // resetConversation() may fail closed and never publish
        // a replacement connection state, so the drain must not
        // leave the store asserting "connected" for a channel
        // it no longer owns.
        store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        terminalStateApplied = true;
        outcome = "abandoned";
        return outcome;
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
      // #1753 review round 10: see the mid-loop abandoned branch.
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      terminalStateApplied = true;
      outcome = "abandoned";
      return outcome;
    }
    batcher.flushSync();
    // Happy path: the stream completed cleanly and the final flush
    // landed. The channel stays "connected" and the finally below is a
    // no-op.
    terminalStateApplied = true;
    outcome = "settled";
  } catch (e: unknown) {
    // #1742: the batcher may have been disposed by resetConversation() while
    // the stream was still producing. Finalize the active turn before
    // returning so a failed-reset (history preserved) path still ends
    // with the reducer in idle/error state instead of stuck "processing".
    if (batcher.isDisposed) {
      finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
      // #1753 review round 10: see the mid-loop abandoned branch.
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      terminalStateApplied = true;
      outcome = "abandoned";
      return outcome;
    }
    // Flush buffered pre-error events so the UI reflects what the
    // stream produced before it threw. If this flush itself throws,
    // the batcher has already dropped its buffer without applying
    // it — buffered events are lost permanently. That is exactly the
    // partial-failure state /doctor must surface, so fail closed here
    // instead of continuing into the clean-abort branch (#1753 review
    // round 3).
    try {
      batcher.flushSync();
    } catch (flushErr: unknown) {
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      store.dispatch({
        kind: "add_error",
        code: "ENGINE_ERROR",
        message: flushErr instanceof Error ? flushErr.message : String(flushErr),
      });
      terminalStateApplied = true;
      outcome = "failed";
      return outcome;
    }
    // #1753 review round 6: the batcher may have been disposed in the
    // window between the per-iteration check and this catch-time flush
    // (e.g. resetConversation() raced us). After dispose, `enqueue` and
    // `flushSync` are no-ops — if we still took the abort branch, the
    // synthetic `done` would be silently dropped and the caller would
    // see "settled" for a turn that never finalized. Fall back to the
    // same UI-reset path as the mid-stream dispose detector above.
    if (batcher.isDisposed) {
      finalizeAbandonedStream(store, partialInputTokens, partialOutputTokens);
      // #1753 review round 10: see the mid-loop abandoned branch.
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      terminalStateApplied = true;
      outcome = "abandoned";
      return outcome;
    }
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
      try {
        batcher.flushSync();
        // Synthetic `done` landed: user abort is a clean interrupt,
        // connection stays connected, finally is a no-op.
        terminalStateApplied = true;
        outcome = "settled";
      } catch (flushErr: unknown) {
        // #1753 review round 2: if the reducer/store crashes while
        // finalizing the aborted turn, do NOT let the outer finally
        // leave the drain looking "settled". Fail closed right here so
        // /doctor cannot report a healthy engine for an abort that
        // never actually finalized.
        store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        store.dispatch({
          kind: "add_error",
          code: "ENGINE_ERROR",
          message: flushErr instanceof Error ? flushErr.message : String(flushErr),
        });
        terminalStateApplied = true;
        outcome = "failed";
      }
      return outcome;
    }
    // Real engine failure — the model call errored out. Mark the channel
    // disconnected so /doctor reflects the true last-known state, and
    // surface the error toast. (#1753: previously a `finally` block set
    // disconnected unconditionally, including on the happy path, so
    // /doctor reported "disconnected" after every successful turn.)
    store.dispatch({ kind: "set_connection_status", status: "disconnected" });
    store.dispatch({
      kind: "add_error",
      code: "ENGINE_ERROR",
      message: e instanceof Error ? e.message : String(e),
    });
    terminalStateApplied = true;
    // #1753 review rounds 5 + 9: a cleanly dispatched ENGINE_ERROR is
    // a *coherent* terminal state — the error toast is in the store
    // and trace data was captured up to the failure, so trajectory /
    // audit refresh must still run. But no rewindable checkpoint was
    // produced for this turn, so callers gate `postClearTurnCount++`
    // on `outcome === "settled"` specifically and skip it here.
    outcome = "engine_error";
  } finally {
    // #1753 review: fail-closed cleanup. Reaching this with the flag
    // still false means a flush or dispatch threw from a path we did
    // not intercept above — force the channel to "disconnected" and
    // raise an error toast so /doctor cannot report a healthy engine
    // for a drain that crashed during finalization.
    if (!terminalStateApplied) {
      try {
        store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        store.dispatch({
          kind: "add_error",
          code: "ENGINE_ERROR",
          message: "drainEngineStream finalization failed",
        });
      } catch {
        // Store itself is unrecoverable — nothing left we can do
        // from this frame. The next turn will reinitialize state.
      }
      outcome = "failed";
    }
  }
  return outcome;
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
 * Runtime assembly (tools, middleware, providers) is delegated to createKoiRuntime().
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
  // 0. Manifest loading (optional — --manifest flag)
  // ---------------------------------------------------------------------------
  //
  // Loaded BEFORE API config so manifest.modelName can override the
  // KOI_MODEL env default. Mirrors `koi start --manifest` semantics:
  // manifest.instructions replaces DEFAULT_SYSTEM_PROMPT (skills still
  // prepend), and manifest.stacks / manifest.plugins flow into the
  // stack activation filter.
  let manifestModelName: string | undefined;
  let manifestInstructions: string | undefined;
  let manifestStacks: readonly string[] | undefined;
  let manifestPlugins: readonly string[] | undefined;
  let manifestBackgroundSubprocesses: boolean | undefined;
  // #1777: the manifest filesystem block is parsed+validated by
  // `loadManifestConfig` (see manifest.ts). `koi tui` supports
  // `backend: "local"` on the host-default local backend path.
  // `backend: "nexus"` is rejected here because the TUI permission
  // middleware and checkpoint stack both assume the filesystem
  // backend is rooted at `cwd`; approving or rewinding against a
  // non-cwd backend would break trust-boundary and rollback
  // invariants.
  let manifestFilesystemOps: readonly ("read" | "write" | "edit")[] | undefined;
  let manifestMiddleware: import("./manifest.js").ManifestMiddlewareEntry[] | undefined;
  if (flags.manifest !== undefined) {
    const manifestResult = await loadManifestConfig(flags.manifest);
    if (!manifestResult.ok) {
      process.stderr.write(`koi tui: invalid manifest — ${manifestResult.error}\n`);
      process.exit(1);
    }
    manifestModelName = manifestResult.value.modelName;
    manifestInstructions = manifestResult.value.instructions;
    manifestStacks = manifestResult.value.stacks;
    manifestPlugins = manifestResult.value.plugins;
    manifestBackgroundSubprocesses = manifestResult.value.backgroundSubprocesses;

    if (manifestResult.value.filesystem !== undefined) {
      if (manifestResult.value.filesystem.backend === "nexus") {
        process.stderr.write(
          "koi tui: manifest.filesystem.backend: nexus is not supported on this host yet.\n" +
            "  The TUI permission middleware and checkpoint stack both assume the\n" +
            "  filesystem backend is rooted at the session cwd, and approving or\n" +
            "  rewinding against a non-cwd backend would break trust-boundary and\n" +
            "  rollback invariants. Omit the `filesystem:` block or use\n" +
            "  `backend: local`.\n",
        );
        process.exit(1);
      }
      // Apply the `FileSystemConfig.operations` contract's `["read"]`
      // default at the host level. `buildCoreProviders` honors
      // `filesystemOperations` verbatim. NOTE: this gates only the
      // `fs_*` tools — the `execution` preset stack still contributes
      // Bash, so a model in a read-only manifest posture can still
      // mutate the workspace via shell commands. Manifest authors who
      // need a true read-only posture should also omit `execution`
      // from `manifest.stacks`.
      manifestFilesystemOps = manifestResult.value.filesystem.operations ?? (["read"] as const);
    }
    manifestMiddleware =
      manifestResult.value.middleware !== undefined
        ? [...manifestResult.value.middleware]
        : undefined;
  }

  // Previously this block auto-disabled the spawn preset stack
  // whenever manifest.middleware was non-empty, because children
  // inheriting the parent's mutable middleware instances would
  // corrupt per-session state. The spawn preset stack now reads
  // a per-child factory from the runtime factory's host bag
  // (`LATE_PHASE_HOST_KEYS.perChildManifestMiddlewareFactory`)
  // and re-resolves manifest middleware fresh per spawn, so
  // children get their own audit queue + lifecycle hooks without
  // sharing parent state. The auto-disable is no longer needed.

  // ---------------------------------------------------------------------------
  // 1. API configuration
  // ---------------------------------------------------------------------------

  const apiConfigResult = resolveApiConfig();
  if (!apiConfigResult.ok) {
    process.stderr.write(`error: koi tui requires an API key.\n  ${apiConfigResult.error}\n`);
    process.exit(1);
  }
  const { apiKey, baseUrl, model: envModelName, provider, fallbackModels } = apiConfigResult.value;
  // Manifest model name wins over the env default (same precedence
  // as `koi start --manifest`).
  const modelName = manifestModelName ?? envModelName;

  // Enable reasoning for OpenRouter — it silently ignores the field for
  // non-reasoning models. Other providers (OpenAI, custom proxies) may
  // reject it with HTTP 400, so only opt in when we know we're on OpenRouter.
  // Uses the resolved `provider` from env config, not baseUrl sniffing,
  // so the default OPENROUTER_API_KEY path (no explicit baseUrl) works.
  const reasoningCompat: { compat?: { readonly supportsReasoning: true } } =
    provider === "openrouter" ? { compat: { supportsReasoning: true } as const } : {};
  const modelAdapter = createOpenAICompatAdapter({
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    model: modelName,
    ...reasoningCompat,
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
                ...reasoningCompat,
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
  // placeholder "no session" label. Provider was destructured from
  // `resolveApiConfig` above (the canonical resolved value).
  store.dispatch({
    kind: "set_session_info",
    modelName,
    provider,
    sessionName: "",
    sessionId: tuiSessionId,
  });

  // ---------------------------------------------------------------------------
  // 3. Assemble runtime (A1-A: delegate to createKoiRuntime)
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
  // Manifest instructions replace DEFAULT_SYSTEM_PROMPT when supplied —
  // mirrors `koi start --manifest` behavior. Skills still prepend
  // because they're filesystem-discovered, not part of the manifest.
  const baseSystemPrompt = manifestInstructions ?? DEFAULT_SYSTEM_PROMPT;
  const systemPrompt =
    skillContent.length > 0 ? `${skillContent}\n\n${baseSystemPrompt}` : baseSystemPrompt;

  // Loop mode (--until-pass): each user turn becomes a runUntilPass
  // invocation that iterates the agent against the verifier until
  // convergence or budget exhaustion. Disables session transcript
  // persistence because intermediate loop iterations are not
  // resumable — matches koi start --until-pass semantics.
  const isLoopMode = flags.untilPass.length > 0;

  // OTel SDK bootstrap — must happen before createKoiRuntime so the global
  // TracerProvider is registered before middleware-otel calls trace.getTracer().
  const otelEnabled = process.env.KOI_OTEL_ENABLED === "true";
  const otelHandle = otelEnabled ? initOtelSdk("tui") : undefined;

  // Runtime assembly happens in parallel with TUI rendering (P2-A).
  // The runtimeReady promise resolves before the first submit.
  // let: set once when the promise resolves
  let runtimeHandle: KoiRuntimeHandle | null = null;
  // let: incremented on each /mcp navigation; stale background refreshes drop their dispatch
  let mcpViewGeneration = 0;
  // Per-server in-flight auth guard — prevents overlapping OAuth flows
  const mcpAuthInFlight = new Set<string>();
  const runtimeReady = createKoiRuntime({
    modelAdapter,
    modelName,
    approvalHandler: permissionBridge.handler,
    approvalTimeoutMs: TUI_APPROVAL_TIMEOUT_MS,
    cwd: process.cwd(),
    systemPrompt,
    ...(modelRouterMiddleware !== undefined ? { modelRouterMiddleware } : {}),
    // TUI opts out of engine loop detection explicitly: the
    // per-submit iteration budget reset + governance caps below
    // already bound spirals, and false-positive trips during an
    // interactive session are expensive (they abort mid-turn with a
    // confusing error). `koi start`'s auto-allow backend leaves
    // this at the engine default (enabled) — see `runtime-factory.ts`.
    loopDetection: false,
    // In loop mode, session persistence is intentionally omitted so
    // failed iterations don't pollute the resumable JSONL transcript.
    // Loop mode is a self-correcting execution, not a conversation.
    ...(isLoopMode ? {} : { session: { transcript: jsonlTranscript, sessionId: tuiSessionId } }),
    skillsRuntime: skillRuntime,
    ...(approvalStore !== undefined ? { persistentApprovals: approvalStore } : {}),
    ...(flags.goal.length > 0 ? { goals: flags.goal } : {}),
    // Manifest-driven opt-in for preset stacks + plugins. Omitted
    // when the user didn't pass --manifest, in which case the
    // factory defaults to activating every stack / every discovered
    // plugin (v1's "wire everything" posture).
    ...(manifestStacks !== undefined ? { stacks: manifestStacks } : {}),
    ...(manifestPlugins !== undefined ? { plugins: manifestPlugins } : {}),
    ...(manifestFilesystemOps !== undefined ? { filesystemOperations: manifestFilesystemOps } : {}),
    // Zone B — manifest-declared middleware. Resolved inside the
    // factory via the default built-in registry. Runs INSIDE the
    // security guard so repo-authored content cannot observe raw
    // traffic before `exfiltration-guard` redacts secrets.
    //
    // `allowManifestFileSinks` gates the built-in audit entry
    // (which opens a file at resolution time). Controlled by the
    // KOI_ALLOW_MANIFEST_FILE_SINKS env var rather than the
    // manifest so repo content cannot flip it.
    ...(manifestMiddleware !== undefined ? { manifestMiddleware } : {}),
    ...(process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1" ? { allowManifestFileSinks: true } : {}),
    // TUI defaults `backgroundSubprocesses` to `true` (the factory
    // default) because its interactive surface makes long-running
    // jobs observable. A manifest setting wins if provided.
    ...(manifestBackgroundSubprocesses !== undefined
      ? { backgroundSubprocesses: manifestBackgroundSubprocesses }
      : {}),
    // KOI_OTEL_ENABLED=true opts into OTel span emission for the TUI session.
    // initOtelSdk() registers a global TracerProvider so middleware-otel's
    // trace.getTracer() returns a real tracer. Must be called before createKoiRuntime.
    ...(otelEnabled ? { otel: true as const } : {}),
    // KOI_AUDIT_NDJSON=<absolute path> opts into security-grade audit
    // logging. Wires @koi/middleware-audit + @koi/audit-sink-ndjson so
    // every model/tool call is recorded as a hash-chained NDJSON entry.
    ...(process.env.KOI_AUDIT_NDJSON !== undefined && process.env.KOI_AUDIT_NDJSON !== ""
      ? { auditNdjsonPath: process.env.KOI_AUDIT_NDJSON }
      : {}),
    // KOI_AUDIT_SQLITE=<absolute path> opts into SQLite-backed audit
    // logging. Wires @koi/middleware-audit + @koi/audit-sink-sqlite so
    // every model/tool call is recorded in a WAL-mode SQLite database.
    ...(process.env.KOI_AUDIT_SQLITE !== undefined && process.env.KOI_AUDIT_SQLITE !== ""
      ? { auditSqlitePath: process.env.KOI_AUDIT_SQLITE }
      : {}),
    // Bridge spawn lifecycle events into the TUI store so /agents view and
    // inline spawn_call blocks reflect real spawn state. Each spawn call
    // produces one spawn_requested + one agent_status_changed event.
    onSpawnEvent: (event): void => {
      // Defense-in-depth: store.dispatch can throw if the reducer or
      // SolidJS reactivity hits an edge case. A throwing callback must
      // not crash the spawn flow — the engine wraps this in safeSpawnEvent
      // too, but belt-and-braces keeps the TUI safe even if the engine
      // guard is ever removed.
      try {
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
      } catch (e: unknown) {
        console.warn("[koi:tui] onSpawnEvent dispatch failed — spawn UI may be stale", e);
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
    // If /mcp was opened during startup, refresh its live status now
    // that the runtime is ready.
    if (store.getState().activeView === "mcp") {
      void (async () => {
        mcpViewGeneration += 1;
        const refreshGen = mcpViewGeneration;
        const live = await handle.getMcpStatus();
        if (mcpViewGeneration !== refreshGen) return;
        store.dispatch({
          kind: "set_mcp_status",
          servers: live.map((l) => ({
            name: l.name,
            status:
              l.failureCode === undefined
                ? ("connected" as const)
                : l.failureCode === "AUTH_REQUIRED"
                  ? ("needs-auth" as const)
                  : ("error" as const),
            toolCount: l.toolCount,
            detail: l.failureMessage,
          })),
        });
      })();
    }

    // Dispatch plugin summary to TUI store (#1728)
    store.dispatch({
      kind: "set_plugin_summary",
      summary: handle.pluginSummary,
    });

    // Surface plugin status as inline TUI notice (#1728).
    // UI-only — not injected into the model transcript to avoid a trust
    // boundary issue (plugin descriptions are untrusted metadata).
    // Agent awareness comes through the /plugins view and startup log.
    //
    // Plugin-derived strings are sanitized to strip ANSI escape sequences
    // and control characters before display.
    if (handle.pluginSummary.loaded.length > 0 || handle.pluginSummary.errors.length > 0) {
      // Strip ANSI escapes and control characters from untrusted plugin text.
      // Uses RegExp constructor to avoid Biome noControlCharactersInRegex lint.
      const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
      const CTRL_RE = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
      const sanitize = (s: string): string => s.replace(ANSI_RE, "").replace(CTRL_RE, "");

      const parts: string[] = [];
      if (handle.pluginSummary.loaded.length > 0) {
        const pluginLines = handle.pluginSummary.loaded
          .map((p) => `- ${sanitize(p.name)} v${sanitize(p.version)}`)
          .join("\n");
        parts.push(`[Loaded Plugins]\n${pluginLines}`);
      }
      if (handle.pluginSummary.errors.length > 0) {
        const errorLines = handle.pluginSummary.errors
          .map((e) => `- ${sanitize(e.plugin)}: ${sanitize(e.error)}`)
          .join("\n");
        parts.push(`[Plugin Load Errors]\n${errorLines}`);
      }
      store.dispatch({
        kind: "add_user_message",
        id: `plugin-status-${String(Date.now())}`,
        blocks: [{ kind: "text" as const, text: parts.join("\n\n") }],
      });
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
  let activeRunPromise: Promise<DrainOutcome> | null = null;

  // --- Cost bridge: wire @koi/cost-aggregator into TUI lifecycle ---
  // Async: fetches live pricing from models.dev (5s timeout, disk cached).
  const costBridge: CostBridge = await createCostBridge({
    store,
    sessionId: tuiSessionId as string,
    modelName,
    provider,
  });

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
  const TUI_DOUBLE_TAP_WINDOW_MS = 2000;
  // Wiring for the three-way graceful SIGINT action + the bg-wait
  // self-disarm timer is extracted into `createTuiSigintHandler`
  // (see tui-graceful-sigint.ts) so the state matrix — including the
  // #1772 idle-with-background case and its post-double-tap disarm —
  // can be unit-tested without spinning up a TUI or runtime.
  const sigintHandler = createTuiSigintHandler({
    hasActiveForegroundStream: () => activeController !== null,
    hasActiveBackgroundTasks: () => runtimeHandle?.hasActiveBackgroundTasks() ?? false,
    abortActiveStream,
    onShutdown: () => {
      void shutdown(130);
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
    doubleTapWindowMs: TUI_DOUBLE_TAP_WINDOW_MS,
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

  // Monotonic id for each `resetConversation()` invocation.
  // Bumped synchronously at the top of every call. Reset IIFEs
  // capture the value at start, and the catch / truncate-failure
  // paths consult `resetGeneration` before mutating the
  // `clearPersistFailed` / `lastResetFailed` latches — older
  // completions ignore their state and only the most recent
  // reset can publish results. Without this, a `/clear` followed
  // quickly by another reset path could let the older truncate
  // failure overwrite the newer reset's success state.
  // let: justified — incremented per reset attempt.
  let resetGeneration = 0;

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
  // Reset at the top of each truncating `resetConversation()` call
  // so a subsequent successful clear re-enables the hint. A sticky
  // process-wide flag would permanently strand the user if a
  // transient I/O blip during one clear happened to precede hours
  // of later work — the shutdown hint would be withheld even
  // though the final session state is perfectly resumable.
  // Non-truncating resets (picker / rewind) preserve the latch.
  // let: justified — toggled per truncating-clear attempt.
  let clearPersistFailed = false;

  // Reflects the most recent `resetConversation()` IIFE outcome.
  // Set to `true` whenever the reset body's `catch` runs (a
  // `resetSessionState()` throw, a runtime-handle disposal
  // failure, etc.). Used by picker hydration and rewind replay
  // to refuse to proceed onto contaminated runtime state — if
  // the task board / approval store / trajectory prune partially
  // failed, the next picker load or rewind would otherwise
  // hydrate fresh history onto stale middleware state. Reset at
  // the top of each `resetConversation()` call so each new reset
  // attempt can succeed independently.
  // let: justified — toggled per reset attempt.
  let lastResetFailed = false;

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

  // Monotonic id for each `onSessionSelect` invocation. Bumped
  // synchronously at the top of the handler, captured by the
  // async flow, and consulted at every state-publication point
  // (clearing `pendingSessionSwitch`, mutating `viewedSessionId`,
  // hydrating `runtimeHandle.transcript`, dispatching
  // `set_session_info` / `load_history`). Stale completions —
  // selections superseded by a later click — exit without side
  // effects. Without this, rapid A→B clicks let whichever load
  // finishes last "win" regardless of the user's intent, and
  // the first completion can flip `pendingSessionSwitch = false`
  // while the second is still in flight, briefly re-enabling
  // submit / clear / new / rewind on the wrong session.
  // let: justified — incremented per picker-select.
  let pickerGeneration = 0;

  // Shared reset primitive. Callers that represent a true privacy /
  // rollback boundary (agent:clear, session:new) must additionally
  // flip `rewindBoundaryActive` and `clearedThisProcess` themselves
  // — session-switch via the picker intentionally does NOT flip
  // them, because the post-switch turns establish a usable rewind
  // chain of their own.
  //
  // `truncatePersistedTranscript` controls whether the on-disk
  // `<tuiSessionId>.jsonl` is cleared alongside the in-memory
  // state. agent:clear passes `true` because the durable
  // transcript is exactly what the user wants erased.
  // session:new passes `false` — the old transcript is preserved
  // so it remains resumable via /sessions; the caller rotates
  // `tuiSessionId` after the reset so new turns write to a
  // separate file. Session switching also passes `false` — the
  // live JSONL belongs to the startup session id and must survive
  // the switch.
  const resetConversation = (options: { readonly truncatePersistedTranscript: boolean }): void => {
    // Bump the reset generation BEFORE any other state changes
    // so older async reset IIFEs can detect that they've been
    // superseded and abort their state-publication side effects.
    resetGeneration += 1;
    const myGeneration = resetGeneration;
    // Clear any stale flag from a PREVIOUS clear — if the current
    // reset is going to re-truncate the transcript, shutdown's
    // hint suppression should not fire on the basis of an earlier
    // transient failure. The new truncate path below will re-set
    // the flag if and only if THIS reset's durable clear fails.
    //
    // Critically, we only clear the flag when `truncatePersistedTranscript`
    // is true. Non-destructive resets (session picker load,
    // rewind post-restore) must NOT clear it — if a prior
    // `/clear` or `/new` failed to truncate, the pre-clear
    // content is still on disk, and a later picker/rewind
    // reset must not silently re-enable writes. The sticky-
    // across-non-truncating-resets semantics close the earlier
    // bypass where a failed clear followed by a picker switch
    // could silently resume writing to the old transcript.
    if (options.truncatePersistedTranscript) {
      clearPersistFailed = false;
    }
    // `lastResetFailed` IS reset on every attempt (including
    // non-truncating ones) because each reset attempt is an
    // independent operation: a transient failure during one
    // picker switch should not block a successful subsequent
    // reset. The flag latches if the IIFE body throws below,
    // and downstream callers (picker hydration, rewind replay,
    // submit) check it before proceeding.
    lastResetFailed = false;
    // Abort the active controller first — C4-A ordering constraint requires
    // signal.aborted === true before calling resetSessionState().
    activeController?.abort();
    activeController = null;

    // Cancel any pending permission prompts and dismiss the modal so a
    // session reset (`agent:clear`, `session:new`, resume) doesn't leave
    // the user stuck behind a stale 60-minute approval window. The bridge
    // stays usable for the next turn. (#1759 review round 2)
    permissionBridge.cancelPending("Session reset");

    // Cost aggregator clear is deferred to the success branch below —
    // same fail-closed contract as transcript/messages (#1742).

    // dispose() drops the buffer without flushing — the in-flight drainEngineStream
    // still holds the old batcher ref, so its later enqueue/flushSync are no-ops.
    batcher.dispose();
    batcher = createEventBatcher<EngineEvent>(dispatchBatch);

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
    // A `/clear` issued during the startup resume window
    // (before createKoiRuntime has resolved) still has to honor
    // the privacy boundary. Clearing the prime array is synchronous
    // and safe regardless of runtime readiness.
    resumedMessagesToPrime = [];
    // Invalidate any in-flight refreshTrajectoryData() scheduled before
    // this reset (#1764). Bump synchronously so a late refresh cannot
    // race ahead of the success branch below and repopulate stale lanes.
    trajectoryRefreshGen += 1;

    // #1742 loop-2 round 5: do NOT clear the visible transcript or splice
    // runtimeHandle.transcript until resetSessionState() actually resolves.
    // resetSessionState fails closed on cycleSession TIMEOUT — if we wiped
    // the screen first, the user would lose all visible history while
    // approvals/memory/etc were still in the wedged old session. Defer
    // destructive cleanup to the success branch; on failure leave the
    // screen intact and surface an error banner.
    if (runtimeHandle !== null) {
      const idleController = new AbortController();
      idleController.abort();
      resetBarrier = (async (): Promise<boolean> => {
        // Drain any in-flight run to its settled state so late
        // middleware-finally appends from the aborted turn cannot
        // land after the truncate below.
        if (inflightRun !== null) {
          try {
            await inflightRun;
          } catch {
            /* already reported upstream via add_error */
          }
        }
        try {
          await runtimeHandle?.resetSessionState(idleController.signal, {
            truncate: shouldTruncate,
          });
        } catch (resetError: unknown) {
          const message = resetError instanceof Error ? resetError.message : String(resetError);
          store.dispatch({
            kind: "add_error",
            code: "RESET_FAILED",
            message: `Session reset failed: ${message}. Visible history preserved. Please restart koi tui to recover.`,
          });
          if (myGeneration === resetGeneration) {
            lastResetFailed = true;
            // Only mark the persisted clear as failed when this
            // reset was actually trying to truncate durable state
            // (`shouldTruncate === true` means /clear or /new with
            // truncatePersistedTranscript). For non-truncating
            // resets — picker session switches and rewind reloads
            // — the JSONL file is intentionally left intact, so a
            // mid-flight failure has nothing to do with persisted-
            // clear semantics. Latching `clearPersistFailed` there
            // would strand a healthy session: subsequent shutdowns
            // would suppress the resume hint and downstream guards
            // would block normal submit/fork paths. `lastResetFailed`
            // above is the right latch for in-memory recovery; it
            // gates the next reset attempt without poisoning the
            // file-state contract.
            //
            // When this WAS a truncating reset, a hook failure
            // (AggregateError from the factory) means session-keyed
            // durable state may be partially intact — e.g. the
            // checkpoint stack's onResetSession failing to prune
            // the old chain means `/rewind` after quit+resume
            // could walk back into pre-clear snapshots. The flag
            // ensures the post-quit hint is suppressed and the
            // user is steered toward a fresh restart.
            if (shouldTruncate) {
              clearPersistFailed = true;
            }
          }
          return false;
        }
        // Only NOW that the engine confirmed the session was rotated
        // do we wipe visible state.
        store.dispatch({ kind: "clear_messages" });
        store.dispatch({ kind: "set_trajectory_data", steps: [], auditEntries: [] });
        // Clear cost aggregator only after successful reset — fail-closed contract.
        costBridge.aggregator.clearSession(tuiSessionId as string);
        costBridge.tokenRate.clear();
        runtimeHandle?.transcript.splice(0);
        tuiTurnCounter = 0;
        if (shouldTruncate) {
          // Truncate the on-disk JSONL so a subsequent `--resume`
          // cannot resurrect pre-clear conversation.
          const truncateResult = await jsonlTranscript.truncate(tuiSessionId, 0);
          if (!truncateResult.ok && myGeneration === resetGeneration) {
            clearPersistFailed = true;
            store.dispatch({
              kind: "add_error",
              code: "SESSION_CLEAR_PERSIST_FAILED",
              message: `Failed to clear persisted transcript — ${truncateResult.error.message}`,
            });
          }
        }
        // /clear is silent on success — a freshly cleared conversation
        // is its own acknowledgement. The cumulative runtime-wide spend
        // cap survives /clear by design (iteration budget resets, token
        // accounting does not); if the user later trips it, the
        // budget-exceeded error itself surfaces the explanation. Post-
        // reset toast removed per #1764 review (was originally added
        // by #1742 as a RESET_NOTICE but mimicked an error).
        return true;
      })();
    } else {
      // Pre-runtime-ready reset path — `resetConversation` was called
      // before `createKoiRuntime` resolved. Schedule the runtime-scoped
      // work behind `runtimeReady` so the same destructive cleanup
      // pipeline runs as in the post-ready branch above. Without this,
      // a `koi tui --resume <id>` startup-window `/clear` would
      // truncate the JSONL but leave the session-keyed checkpoint
      // chain intact — a later quit + resume could still `/rewind`
      // into pre-clear snapshots, defeating the isolation contract.
      resetBarrier = (async (): Promise<boolean> => {
        await runtimeReady.catch(() => {
          /* runtime init errors reported upstream */
        });
        const handleAfterReady = ((): KoiRuntimeHandle | null => runtimeHandle)();
        // Fail closed when the runtime never initialized, regardless
        // of `shouldTruncate`. A non-truncating reset (picker load
        // or post-rewind in-memory rebuild) on a dead runtime would
        // otherwise clear visible UI state and report success even
        // though there's no engine behind the reset — downstream
        // submits would land on a stale runtime handle, and the
        // shutdown hint would advertise a session id whose backing
        // state was never actually rebuilt.
        if (handleAfterReady === null) {
          store.dispatch({
            kind: "add_error",
            code: "RESET_FAILED",
            message:
              "Session reset failed: runtime did not initialize. " +
              "Visible history preserved. Please restart koi tui to recover.",
          });
          if (myGeneration === resetGeneration) {
            lastResetFailed = true;
            if (shouldTruncate) clearPersistFailed = true;
          }
          return false;
        }
        // Runtime is available — run the destructive stack cleanup
        // (checkpoint chain prune, etc.) for truncating resets.
        // Non-truncating resets still call resetSessionState so the
        // engine cycles cleanly; checkpoint hook gates internally
        // on `truncate: false` to skip pruning.
        {
          const idleController = new AbortController();
          idleController.abort();
          try {
            await handleAfterReady.resetSessionState(idleController.signal, {
              truncate: shouldTruncate,
            });
          } catch (resetError: unknown) {
            const message = resetError instanceof Error ? resetError.message : String(resetError);
            store.dispatch({
              kind: "add_error",
              code: "RESET_FAILED",
              message: `Session reset failed: ${message}. Visible history preserved. Please restart koi tui to recover.`,
            });
            if (myGeneration === resetGeneration) {
              lastResetFailed = true;
              if (shouldTruncate) clearPersistFailed = true;
            }
            return false;
          }
          handleAfterReady.transcript.splice(0);
        }
        store.dispatch({ kind: "clear_messages" });
        store.dispatch({ kind: "set_trajectory_data", steps: [], auditEntries: [] });
        tuiTurnCounter = 0;
        if (shouldTruncate) {
          const truncateResult = await jsonlTranscript.truncate(tuiSessionId, 0);
          if (!truncateResult.ok && myGeneration === resetGeneration) {
            clearPersistFailed = true;
            store.dispatch({
              kind: "add_error",
              code: "SESSION_CLEAR_PERSIST_FAILED",
              message: `Failed to clear persisted transcript — ${truncateResult.error.message}`,
            });
          }
        }
        return true;
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
  const shutdown = async (exitCode = 0, reason?: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (reason !== undefined) {
      try {
        process.stderr.write(`[koi tui] shutdown: ${reason}\n`);
      } catch {
        /* stderr unwritable after hangup — best effort */
      }
    }
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
    // Keep-alive for the shutdown phase. `appHandle.stop()` clears
    // OpenTUI's internal keepAliveTimer, and once the final await
    // (`resetBarrier`, `runtime.dispose()`) queues its continuation,
    // the event loop has no ref'd handles left — bun promptly
    // exits with no more work to do, SKIPPING everything after the
    // first await in this function (including the writeSync for
    // the resume hint and the explicit `process.exit(exitCode)`
    // in the finally block).
    //
    // A ref'd setInterval keeps the loop alive for the duration of
    // cooperative shutdown. It's cleared in the outer finally so
    // the hard-exit failsafe can still fire if something wedges,
    // and so the process exits cleanly via `process.exit` after
    // the hint + runtime.dispose paths complete.
    const shutdownKeepAlive = setInterval(() => {
      /* keep-alive only — no side effect */
    }, 1000);

    // Wait for any in-flight clear/reset barrier to land BEFORE
    // tearing down the renderer. Doing this BEFORE `appHandle.stop()`
    // is load-bearing: OpenTUI's stop() clears its internal
    // keepAliveTimer and the subsequent native destroyRenderer call
    // causes bun's event loop to exit on the next empty tick.
    // Anything awaited after stop() never resumes — even with our
    // own ref'd setInterval keepalive in place (bun drops pending
    // microtasks when the last "real" handle goes away). Awaiting
    // the reset barrier here, BEFORE stop(), keeps us inside the
    // renderer-live window where the event loop stays alive naturally.
    try {
      await resetBarrier;
    } catch {
      // Defensive: resetConversation now only resolves its barrier,
      // but if a future change accidentally reintroduces a rejection
      // path we still want shutdown to suppress the resume hint
      // rather than propagate an unhandled rejection.
      clearPersistFailed = true;
    }
    try {
      await appHandle?.stop();
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
      clearInterval(shutdownKeepAlive);
      // Flush OTel spans before process exit
      await otelHandle?.shutdown();
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
      // Block fork after a failed durable clear. The on-disk
      // transcript still contains the pre-clear conversation
      // the user explicitly asked to drop, and `handleFork`
      // clones THAT file into a new session id — duplicating
      // the sensitive data into a fresh resumable copy. This
      // mirrors the SUBMIT_AFTER_FAILED_CLEAR guard in
      // onSubmit; both paths must refuse to operate on the
      // stale transcript.
      if (clearPersistFailed) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_AFTER_FAILED_CLEAR",
          message:
            "Fork is disabled because the most recent /clear or /new could not " +
            "durably truncate this session's transcript. The current file still " +
            "contains pre-clear content that the fork would copy into a new " +
            "session id. Quit and relaunch, or resolve the underlying I/O " +
            "issue and retry /clear before forking.",
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

      // Wait for any in-flight clear/reset barrier to settle
      // before reading the source transcript. Without this,
      // `/clear` followed immediately by `/fork` has a race
      // window where `clearPersistFailed` is still `false`
      // (the reset IIFE only sets it inside the async truncate
      // path) but the truncate is in progress — handleFork
      // would happily load the pre-clear content and clone it
      // into a new session id, duplicating data the user just
      // asked to drop. After the await, re-check both latches:
      // if the clear actually failed, `clearPersistFailed` is
      // now true and we block; if an unrelated reset step
      // threw, `lastResetFailed` is true and we also block so
      // fork can't operate on contaminated in-memory state.
      await resetBarrier;
      if (clearPersistFailed) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_AFTER_FAILED_CLEAR",
          message:
            "Fork is disabled because the most recent /clear or /new could not " +
            "durably truncate this session's transcript. The current file still " +
            "contains pre-clear content that the fork would copy into a new " +
            "session id. Quit and relaunch, or resolve the underlying I/O " +
            "issue and retry /clear before forking.",
        });
        return;
      }
      if (lastResetFailed) {
        store.dispatch({
          kind: "add_error",
          code: "FORK_AFTER_FAILED_RESET",
          message:
            "Fork is disabled because the most recent session reset failed. " +
            "The runtime may still hold stale state. Quit and relaunch with " +
            "`koi tui --resume <id>` to fork from a clean runtime.",
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

  // #10: @-mention file completion handler — scans cwd via git ls-files,
  // caches file list with 5s TTL, fuzzy-filters, and dispatches results.
  const handleAtQuery = createFileCompletionHandler(process.cwd(), (results) =>
    store.dispatch({ kind: "set_at_results", results }),
  );

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
            if (runtimeHandle.checkpoint === undefined) {
              store.dispatch({
                kind: "add_error",
                code: "REWIND_DISABLED",
                message:
                  "Rewind is unavailable: the checkpoint preset stack is disabled in this runtime.",
              });
              return;
            }
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
            // #1742 loop-3 round 4: do NOT hydrate history if the reset
            // failed-closed. The engine session never rotated, so
            // loading the rewound transcript on top would mix old
            // approvals/memory/board state with new history.
            const rewindResetOk = await resetBarrier;
            if (!rewindResetOk || lastResetFailed) {
              store.dispatch({
                kind: "add_error",
                code: "REWIND_ABORTED",
                message:
                  "Rewind aborted: session reset failed. Restart koi tui and retry the rewind on a fresh runtime.",
              });
              return;
            }
            // Load and validate transcript BEFORE rebinding runtime.
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
            } else {
              // Replay of the kept transcript prefix failed after a
              // successful file-state restore. The workspace is at the
              // rewound snapshot, but the runtime's in-memory transcript
              // has been spliced to empty and the UI is blank. Surface
              // this loudly — silently proceeding would let the next
              // submit run as if the session had no prior context, which
              // is a hard-to-detect correctness regression. The user
              // should quit and relaunch with `--resume <id>` to reload
              // from disk under a clean path.
              store.dispatch({
                kind: "add_error",
                code: "REWIND_REPLAY_FAILED",
                message:
                  "Rewind restored the workspace to the target snapshot, but " +
                  "replaying the kept transcript prefix failed: " +
                  `${resumeResult.error.message}. The file state is at the target, ` +
                  "but the in-memory conversation is now empty. Quit and relaunch " +
                  "with `koi tui --resume <id>` to reload the session cleanly.",
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
        case "nav:mcp": {
          // Instant — reads config + checks Keychain. No network, no runtime needed.
          // Increment the generation so background refreshes from prior
          // opens can't clobber this one's output.
          mcpViewGeneration += 1;
          const navGen = mcpViewGeneration;
          void (async (): Promise<void> => {
            const { loadMcpJsonFile, computeServerKey } = await import("@koi/mcp");
            const { createSecureStorage } = await import("@koi/secure-storage");
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");

            // Same precedence as runtime: only fall back to home config
            // when project file is truly absent, not invalid.
            const projectResult = await loadMcpJsonFile(join(process.cwd(), ".mcp.json"));
            let config: typeof projectResult | undefined;
            if (projectResult.ok) {
              // Valid config (including empty {mcpServers:{}}) takes priority.
              // Empty project config is an explicit opt-out — do not fall
              // back to home config.
              config = projectResult;
            } else if (projectResult.error.code === "NOT_FOUND") {
              const homeResult = await loadMcpJsonFile(join(homedir(), ".koi", ".mcp.json"));
              if (homeResult.ok) config = homeResult;
            }

            if (config === undefined || !config.ok || config.value.servers.length === 0) {
              // No file servers — render empty view immediately, then do
              // live plugin discovery in the background (may block on
              // unhealthy plugin servers; must not stall navigation).
              store.dispatch({ kind: "set_mcp_status", servers: [] });
              store.dispatch({ kind: "set_view", view: "mcp" });
              if (runtimeHandle !== null) {
                void (async () => {
                  const live = await runtimeHandle?.getMcpStatus();
                  if (live === undefined) return;
                  if (mcpViewGeneration !== navGen) return;
                  store.dispatch({
                    kind: "set_mcp_status",
                    servers: live.map((l) => ({
                      name: l.name,
                      status:
                        l.failureCode === undefined
                          ? ("connected" as const)
                          : l.failureCode === "AUTH_REQUIRED"
                            ? ("needs-auth" as const)
                            : ("error" as const),
                      toolCount: l.toolCount,
                      detail: l.failureMessage ?? "plugin",
                    })),
                  });
                })();
              }
              return;
            }

            // Check token storage for each OAuth server — fast Keychain lookup, no network
            const storage = createSecureStorage();
            const servers: import("@koi/tui").McpServerInfo[] = await Promise.all(
              config.value.servers.map(async (s) => {
                const hasOAuth = s.kind === "http" && s.oauth !== undefined;
                if (!hasOAuth) {
                  // Non-OAuth server — assume configured/ready
                  return {
                    name: s.name,
                    status: "connected" as const,
                    toolCount: 0,
                    detail: `${s.kind} transport`,
                  };
                }
                // Check Keychain for stored tokens
                const key = computeServerKey(s.name, s.kind === "http" ? s.url : "");
                const raw = await storage.get(key);
                const hasTokens = raw !== undefined;
                return {
                  name: s.name,
                  status: hasTokens ? ("connected" as const) : ("needs-auth" as const),
                  toolCount: 0,
                  detail: hasTokens ? "Authenticated (tokens stored)" : undefined,
                };
              }),
            );

            // Show immediately from Keychain state — no blocking.
            store.dispatch({ kind: "set_mcp_status", servers });
            store.dispatch({ kind: "set_view", view: "mcp" });

            // Background: enrich with live tool counts if runtime is ready.
            // Does NOT block the view — user sees instant status, then
            // tool counts update asynchronously.
            if (runtimeHandle !== null) {
              void (async () => {
                const live = await runtimeHandle?.getMcpStatus();
                if (live === undefined) return;
                // Live entries may be source-keyed ("user:jira") when both
                // user and plugin resolvers exist. Strip the "user:" prefix
                // when matching against config-backed server names.
                const stripUserPrefix = (n: string): string =>
                  n.startsWith("user:") ? n.slice(5) : n;
                const liveUserMap = new Map<string, (typeof live)[number]>();
                const liveOther: (typeof live)[number][] = [];
                for (const l of live) {
                  if (l.name.startsWith("user:")) {
                    liveUserMap.set(stripUserPrefix(l.name), l);
                  } else if (!l.name.includes(":")) {
                    liveUserMap.set(l.name, l);
                  } else {
                    liveOther.push(l);
                  }
                }
                // Enrich config-based entries with live data (match by bare name)
                const enriched: import("@koi/tui").McpServerInfo[] = servers.map((entry) => {
                  const l = liveUserMap.get(entry.name);
                  if (l === undefined) return entry;
                  const liveStatus: "connected" | "needs-auth" | "error" =
                    l.failureCode === undefined
                      ? "connected"
                      : l.failureCode === "AUTH_REQUIRED"
                        ? "needs-auth"
                        : "error";
                  return {
                    name: entry.name,
                    status: liveStatus,
                    toolCount: l.toolCount,
                    detail: l.failureMessage ?? entry.detail,
                  };
                });
                // Append plugin-provided servers (source-prefixed) not in .mcp.json
                for (const l of liveOther) {
                  enriched.push({
                    name: l.name,
                    status:
                      l.failureCode === undefined
                        ? "connected"
                        : l.failureCode === "AUTH_REQUIRED"
                          ? "needs-auth"
                          : "error",
                    toolCount: l.toolCount,
                    detail: l.failureMessage ?? "plugin",
                  });
                }
                if (mcpViewGeneration !== navGen) return;
                store.dispatch({ kind: "set_mcp_status", servers: enriched });
              })();
            }
          })();
          break;
        }
        case "nav:mcp-auth":
          // Triggered by pressing Enter on a needs-auth server in /mcp view.
          // args = server name. Runs `koi mcp auth <name>` inline.
          void (async (): Promise<void> => {
            const rawName = args.trim();
            if (rawName === "") return;
            // Strip source prefix. Plugin-backed servers can't auth here.
            if (rawName.startsWith("plugin:")) {
              store.dispatch({
                kind: "add_error",
                code: "MCP_AUTH",
                message:
                  `Cannot authenticate "${rawName}" from /mcp — plugin-provided ` +
                  `servers must be authenticated through the plugin's own flow.`,
              });
              return;
            }
            const serverName = rawName.startsWith("user:") ? rawName.slice(5) : rawName;
            // Per-server guard — prevent overlapping OAuth flows from
            // double-pressing Enter (callback port conflict, timeout race).
            if (mcpAuthInFlight.has(serverName)) return;
            mcpAuthInFlight.add(serverName);
            try {
              const { loadMcpJsonFile } = await import("@koi/mcp");
              const { join } = await import("node:path");
              const { homedir } = await import("node:os");
              const { createSecureStorage } = await import("@koi/secure-storage");
              const { createCliOAuthRuntime } = await import("./commands/mcp-oauth-runtime.js");
              const { createOAuthAuthProvider } = await import("@koi/mcp");

              // Find the server config — same precedence as runtime
              const authProjectResult = await loadMcpJsonFile(join(process.cwd(), ".mcp.json"));
              const authConfigs: Awaited<ReturnType<typeof loadMcpJsonFile>>[] = [];
              if (authProjectResult.ok) {
                authConfigs.push(authProjectResult);
              } else if (authProjectResult.error.code === "NOT_FOUND") {
                const authHomeResult = await loadMcpJsonFile(join(homedir(), ".koi", ".mcp.json"));
                if (authHomeResult.ok) authConfigs.push(authHomeResult);
              }
              let authMatched = false;
              for (const r of authConfigs) {
                if (!r.ok) continue;
                const server = r.value.servers.find((s) => s.name === serverName);
                if (server === undefined || server.kind !== "http" || server.oauth === undefined)
                  continue;
                authMatched = true;

                const storage = createSecureStorage();
                const runtime = createCliOAuthRuntime();
                const provider = createOAuthAuthProvider({
                  serverName: server.name,
                  serverUrl: server.url,
                  oauthConfig: server.oauth,
                  runtime,
                  storage,
                });

                const success = await provider.startAuthFlow();
                if (success) {
                  // Refresh /mcp view with updated Keychain state
                  const { computeServerKey: computeKey } = await import("@koi/mcp");
                  const freshStorage = createSecureStorage();
                  const refreshed: import("@koi/tui").McpServerInfo[] = await Promise.all(
                    r.value.servers.map(async (s2) => {
                      const hasOAuth2 = s2.kind === "http" && s2.oauth !== undefined;
                      if (!hasOAuth2) {
                        return {
                          name: s2.name,
                          status: "connected" as const,
                          toolCount: 0,
                          detail: `${s2.kind} transport`,
                        };
                      }
                      const key2 = computeKey(s2.name, s2.kind === "http" ? s2.url : "");
                      const raw2 = await freshStorage.get(key2);
                      // The server we just authed shows "auth-pending-restart"
                      // because the live runtime still has the pseudo-tool only
                      // — tools won't load until the next TUI launch.
                      if (s2.name === serverName && raw2 !== undefined) {
                        return {
                          name: s2.name,
                          status: "auth-pending-restart" as const,
                          toolCount: 0,
                          detail: "Tokens stored. Restart the TUI to load tools.",
                        };
                      }
                      return {
                        name: s2.name,
                        status: (raw2 !== undefined ? "connected" : "needs-auth") as
                          | "connected"
                          | "needs-auth",
                        toolCount: 0,
                        detail: raw2 !== undefined ? "Authenticated" : undefined,
                      };
                    }),
                  );
                  store.dispatch({ kind: "set_mcp_status", servers: refreshed });
                } else {
                  store.dispatch({
                    kind: "add_error",
                    code: "MCP_AUTH",
                    message: `Authentication failed for "${serverName}". Try: koi mcp auth ${serverName}`,
                  });
                }
                break;
              }
              if (!authMatched) {
                // Server is listed in /mcp (e.g. plugin-provided) but we
                // don't have a file-config entry to auth against. Fail
                // loudly instead of silently doing nothing.
                store.dispatch({
                  kind: "add_error",
                  code: "MCP_AUTH",
                  message:
                    `Cannot authenticate "${serverName}" from this view — ` +
                    `server is not in .mcp.json (likely plugin-provided). ` +
                    `Plugin-backed OAuth must be completed through the plugin's own flow.`,
                });
              }
            } catch (e: unknown) {
              store.dispatch({
                kind: "add_error",
                code: "MCP_AUTH",
                message: `Auth error: ${e instanceof Error ? e.message : String(e)}`,
              });
            } finally {
              mcpAuthInFlight.delete(serverName);
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
          // Unlike /clear, /new preserves the current transcript on disk
          // so it remains resumable via /sessions. After the reset barrier
          // resolves, rotate tuiSessionId and rebind the engine so new
          // turns write to a separate JSONL file.
          //
          // Cleared-session bookkeeping (rewindBoundaryActive, clearedThisProcess,
          // postClearTurnCount) is deferred to the success path so a failed
          // /new doesn't suppress the shutdown resume hint for the old session.
          void (async (): Promise<void> => {
            resetConversation({ truncatePersistedTranscript: false });
            const resetOk = await resetBarrier;
            if (!resetOk || lastResetFailed) {
              store.dispatch({
                kind: "add_error",
                code: "NEW_SESSION_FAILED",
                message:
                  "New session failed: session reset did not complete. " +
                  "Restart koi tui to recover.",
              });
              return;
            }
            // Rebind the engine BEFORE updating tuiSessionId so a
            // rebind failure never leaves the host pointing at a UUID
            // the runtime doesn't know about (fail-closed contract).
            const newSid = sessionId(crypto.randomUUID());
            if (runtimeHandle?.runtime.rebindSessionId !== undefined) {
              try {
                runtimeHandle.runtime.rebindSessionId(newSid as string);
              } catch (rebindErr: unknown) {
                // Latch submit-blocking flag so the next turn can't
                // append to the old session with stale context.
                lastResetFailed = true;
                store.dispatch({
                  kind: "add_error",
                  code: "NEW_SESSION_FAILED",
                  message: `New session failed: cannot rebind runtime: ${
                    rebindErr instanceof Error ? rebindErr.message : String(rebindErr)
                  }. Restart koi tui to recover.`,
                });
                return;
              }
            }
            // Rebind succeeded — safe to update host-side session ids
            // and mark the session boundary.
            rewindBoundaryActive = true;
            clearedThisProcess = true;
            postClearTurnCount = 0;
            // Clear stale failure latches: a prior /clear failure on
            // the OLD session must not poison the fresh session.
            clearPersistFailed = false;
            lastResetFailed = false;
            tuiSessionId = newSid;
            viewedSessionId = newSid;
            costBridge.setSession(newSid as string, modelName, provider);
            store.dispatch({
              kind: "set_session_info",
              modelName,
              provider,
              sessionName: "",
              sessionId: newSid,
            });
            // Refresh session list so the old session appears in /sessions.
            void loadSessionList(SESSIONS_DIR, jsonlTranscript).then((sessions) => {
              store.dispatch({ kind: "set_session_list", sessions });
            });
          })();
          break;
        case "session:sessions":
          // Refresh the session list every time the picker opens so
          // sessions saved by a recent Ctrl+N appear immediately.
          void loadSessionList(SESSIONS_DIR, jsonlTranscript).then((sessions) => {
            store.dispatch({ kind: "set_session_list", sessions });
          });
          break;
        case "system:model": {
          const lines = [`Model: ${modelName}`, `Provider: ${provider}`];
          if (fallbackModels.length > 0) {
            lines.push(`Fallback: ${fallbackModels.join(", ")}`);
          }
          dispatchNotice(store, "model-info", `[${lines.join(" · ")}]`);
          break;
        }
        case "system:cost": {
          // The cost aggregator is populated from live engine "done" events
          // in this TUI process only — resumed sessions do NOT backfill
          // historical spend. Scope the copy to "this process" so users
          // reading the notice do not mistake zero for whole-session total
          // after `koi tui --resume <id>`.
          const breakdown = costBridge.aggregator.breakdown(tuiSessionId as string);
          const totalIn = breakdown.byModel.reduce((s, m) => s + m.totalInputTokens, 0);
          const totalOut = breakdown.byModel.reduce((s, m) => s + m.totalOutputTokens, 0);
          if (totalIn === 0 && totalOut === 0) {
            dispatchNotice(store, "cost-info", "[Cost (this process): no model calls yet]");
          } else {
            dispatchNotice(
              store,
              "cost-info",
              `[Cost (this process): ${formatCost(breakdown.totalCostUsd)} — ` +
                `${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out tokens]`,
            );
          }
          break;
        }
        case "system:tokens": {
          // Process-local accounting — see the comment on system:cost above.
          const breakdown = costBridge.aggregator.breakdown(tuiSessionId as string);
          const lines: string[] = ["[Token usage (this process)]"];
          if (breakdown.byModel.length === 0) {
            lines.push("  (no model calls yet)");
          } else {
            for (const m of breakdown.byModel) {
              lines.push(
                `  ${m.model}: ${formatTokens(m.totalInputTokens)} in / ` +
                  `${formatTokens(m.totalOutputTokens)} out ` +
                  `(${m.callCount} call${m.callCount === 1 ? "" : "s"}, ` +
                  `${formatCost(m.totalCostUsd)})`,
              );
            }
          }
          const ips = costBridge.tokenRate.inputPerSecond();
          const ops = costBridge.tokenRate.outputPerSecond();
          if (ips > 0 || ops > 0) {
            lines.push(`  rate: ${ips.toFixed(1)} in/s · ${ops.toFixed(1)} out/s`);
          }
          dispatchNotice(store, "tokens-info", lines.join("\n"));
          break;
        }
        case "agent:compact":
          void (async (): Promise<void> => {
            if (runtimeHandle === null) {
              store.dispatch({
                kind: "add_error",
                code: "COMPACT_RUNTIME_NOT_READY",
                message: "Runtime is still initializing — try again in a moment.",
              });
              return;
            }
            // Snapshot current transcript. microcompact is pure — we splice the
            // result back into runtimeHandle.transcript below. /compact is a
            // user-initiated command between turns, so there are no concurrent
            // writers and the snapshot can't race with new appends.
            const snapshot: readonly InboundMessage[] = [...runtimeHandle.transcript];
            if (snapshot.length === 0) {
              dispatchNotice(store, "compact-info", "[Compact: conversation is empty]");
              return;
            }
            const originalTokens = await Promise.resolve(
              HEURISTIC_ESTIMATOR.estimateMessages(snapshot),
            );
            // Halve the current budget, or 4k, whichever is larger. Preserves
            // the 6 most recent messages so the active thread stays coherent.
            const targetTokens = Math.max(4000, Math.floor(originalTokens / 2));
            const preserveRecent = 6;
            const result = await microcompact(
              snapshot,
              targetTokens,
              preserveRecent,
              HEURISTIC_ESTIMATOR,
              modelName,
            );
            if (result.strategy === "noop") {
              dispatchNotice(
                store,
                "compact-info",
                `[Compact: already compact (${result.compactedTokens} tokens)]`,
              );
              return;
            }
            runtimeHandle.transcript.splice(0, runtimeHandle.transcript.length, ...result.messages);
            const dropped = snapshot.length - result.messages.length;
            const partial = result.strategy === "micro-truncate-partial";
            // UI-only notice: the dropped messages are gone from the model's
            // view. We deliberately do NOT insert a transcript marker —
            // pinned markers accumulate across repeat /compact calls (pair
            // rescue keeps them even when nothing else can be dropped), and
            // a `system:*` senderId would leak a hidden privileged prompt
            // into every subsequent turn while being filtered from /export
            // and resume surfaces. The user-facing notice below is the
            // durable record; /trajectory can surface compactions separately
            // if needed later.
            dispatchNotice(
              store,
              "compact-info",
              `[Compact: ${result.originalTokens} → ${result.compactedTokens} tokens, ` +
                `dropped ${dropped} message${dropped === 1 ? "" : "s"}` +
                `${partial ? " (partial — still above target)" : ""}]`,
            );
          })();
          break;
        case "session:export":
          void (async (): Promise<void> => {
            if (runtimeHandle === null) {
              store.dispatch({
                kind: "add_error",
                code: "EXPORT_RUNTIME_NOT_READY",
                message: "Runtime is still initializing — try again in a moment.",
              });
              return;
            }
            const displayable = filterResumedMessagesForDisplay(runtimeHandle.transcript);
            if (displayable.length === 0) {
              store.dispatch({
                kind: "add_error",
                code: "EXPORT_EMPTY",
                message: "Nothing to export — no user or assistant messages in this session.",
              });
              return;
            }
            const engineSid = String(runtimeHandle.runtime.sessionId);
            const md = renderTranscriptMarkdown(displayable, {
              sessionId: engineSid,
              modelName,
              provider,
            });
            const trimmed = args.trim();
            const defaultName = `koi-session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
            const target = trimmed.length > 0 ? trimmed : defaultName;
            const filePath = isAbsolute(target) ? target : join(process.cwd(), target);
            try {
              await writeFile(filePath, md, "utf8");
            } catch (err) {
              store.dispatch({
                kind: "add_error",
                code: "EXPORT_WRITE_FAILED",
                message: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
              });
              return;
            }
            dispatchNotice(store, "export-info", `[Exported session to ${filePath}]`);
          })();
          break;
        case "system:zoom": {
          const current = store.getState().zoomLevel;
          // let: justified — next level computed from one of two branches
          let next = current;
          const trimmed = args.trim();
          if (trimmed.length > 0) {
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              store.dispatch({
                kind: "add_error",
                code: "ZOOM_INVALID_ARGS",
                message: `Usage: /zoom [level] — level must be a positive number (got "${trimmed}").`,
              });
              break;
            }
            next = parsed;
          } else {
            // No arg: cycle 1 → 1.25 → 1.5 → 1.
            next = current >= 1.5 ? 1 : Math.round((current + 0.25) * 100) / 100;
          }
          store.dispatch({ kind: "set_zoom", level: next });
          dispatchNotice(store, "zoom-info", `[Zoom level: ${next}×]`);
          break;
        }
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
      store.dispatch({ kind: "set_view", view: "conversation" });

      // Always bump the picker generation, EVEN for the
      // same-session fast path below. An in-flight A→B load can
      // only be cancelled by a generation bump — without one,
      // the older async flow would still complete and force-
      // switch to B, ignoring the user's latest "stay on
      // current" click. Any stale async task checking
      // `myPickerGeneration !== pickerGeneration` exits
      // without publishing state.
      pickerGeneration += 1;
      const myPickerGeneration = pickerGeneration;

      // Fast path: selecting the session the user is ALREADY
      // viewing is a no-op refresh. Two sub-cases, both handled
      // here:
      //   1. No switch in flight — just close the picker.
      //   2. Switch IS in flight (user is cancelling an A→B
      //      load by re-clicking A). The generation bump above
      //      invalidated the older task, but its finally block
      //      is gated on `myPickerGeneration === pickerGeneration`
      //      and therefore won't clear `pendingSessionSwitch`
      //      when it finally returns. We must clear the latch
      //      here ourselves so the TUI guards re-enable after
      //      the user's "stay on current" click.
      // Comparing against `viewedSessionId` (not `tuiSessionId`)
      // is important: after a picker load the two diverge, and
      // selecting the originally-viewed conversation from the
      // picker should still be a valid "stay here" click.
      if (selectedId === String(viewedSessionId)) {
        if (pendingSessionSwitch) {
          pendingSessionSwitch = false;
          store.dispatch({ kind: "set_connection_status", status: "disconnected" });
        }
        return;
      }

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
          // #1742 loop-3 round 4: abort the resume if the reset
          // failed-closed.
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

          // Phase 1: abort the active turn and wait for the drain
          // to settle before we even LOOK at the target file.
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
          // `resumeSessionFromJsonl` probes filesystem existence and
          // tries both raw and decoded candidate paths, so legacy
          // `agent:<pid>:<uuid>` ids copied from `koi sessions list`
          // work alongside plain UUIDs minted by this branch.
          const targetSid = sessionId(selectedId);
          const resumeResult = await resumeSessionFromJsonl(
            selectedId,
            jsonlTranscript,
            SESSIONS_DIR,
          );
          if (!resumeResult.ok) {
            // Stale completions stay quiet — the newer click is
            // already in flight and will surface its own error.
            if (myPickerGeneration === pickerGeneration) {
              store.dispatch({
                kind: "add_error",
                code: "SESSION_RESUME_ERROR",
                message: `Could not load session: ${resumeResult.error}`,
              });
            }
            return;
          }

          // If a newer picker click superseded us during the
          // load, abort silently — the newer flow owns the
          // state-publication side effects.
          if (myPickerGeneration !== pickerGeneration) {
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

          // After awaiting the reset barrier, re-check that
          // we're still the authoritative selection — a newer
          // click could have arrived while the reset was
          // settling, and proceeding here would publish stale
          // hydration on top of the newer load.
          if (myPickerGeneration !== pickerGeneration) {
            return;
          }

          // Refuse to hydrate onto contaminated state if the
          // reset itself failed — the task board, approval
          // store, or trajectory store may be in a stale
          // half-state and replaying picker-loaded turns into
          // them would mask the failure with apparently-normal
          // operation. The reset error is already surfaced via
          // store.dispatch from the catch block above.
          if (lastResetFailed) {
            store.dispatch({
              kind: "add_error",
              code: "PICKER_LOAD_BLOCKED",
              message:
                "Cannot load the selected session because the in-memory reset " +
                "failed. Quit and relaunch with `koi tui --resume <id>` to load " +
                "the session into a clean runtime.",
            });
            return;
          }

          // Step 3: rebind BEFORE hydrating transcript so a rebind
          // failure never leaves stale messages in the runtime's
          // in-memory transcript (fail-closed contract).
          if (runtimeHandle !== null) {
            if (runtimeHandle.runtime.rebindSessionId !== undefined) {
              try {
                runtimeHandle.runtime.rebindSessionId(selectedId);
              } catch (rebindErr: unknown) {
                // Latch submit-blocking flag so the blank post-reset
                // runtime can't accept turns against the old session.
                lastResetFailed = true;
                store.dispatch({
                  kind: "add_error",
                  code: "SESSION_RESUME_ERROR",
                  message: `Cannot resume session: rebind failed: ${
                    rebindErr instanceof Error ? rebindErr.message : String(rebindErr)
                  }. Restart koi tui to recover.`,
                });
                return;
              }
            }
            // Rebind succeeded — safe to hydrate transcript.
            for (const msg of resumeResult.value.messages) {
              runtimeHandle.transcript.push(msg);
            }
          }
          store.dispatch({
            kind: "load_history",
            messages: resumeResult.value.messages,
          });
          // Fully switch to the selected session — update both
          // tuiSessionId and viewedSessionId so isInPickerMode()
          // returns false and the session is writable. New turns
          // append to the selected session's JSONL file via the
          // rebind above.
          tuiSessionId = targetSid;
          viewedSessionId = targetSid;
          rewindBoundaryActive = true;
          clearedThisProcess = false;
          postClearTurnCount = 0;
          // Only clear lastResetFailed — the picker reset succeeded.
          // Do NOT clear clearPersistFailed: if a prior /clear failed
          // on a different session, that session's JSONL is still
          // contaminated and the latch must stay sticky so switching
          // back to it blocks writes (pre-existing safety contract).
          lastResetFailed = false;
          costBridge.setSession(targetSid as string, modelName, provider);
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
          // `viewedSessionId !== tuiSessionId`. ONLY clear the
          // latch if we're still the authoritative selection —
          // a newer click is still in flight and needs the
          // latch held until ITS finally runs. Without this
          // guard, a stale completion finishing late could
          // briefly re-enable submit/clear/new/rewind on the
          // wrong session while the user's intended switch is
          // still loading.
          if (myPickerGeneration === pickerGeneration) {
            pendingSessionSwitch = false;
            store.dispatch({ kind: "set_connection_status", status: "disconnected" });
          }
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
      // First submit waits for createKoiRuntime to complete; subsequent
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

      // Re-check `clearPersistFailed` after the barrier settles.
      // The early guard above could pass even though a `/clear`
      // was in flight: the reset IIFE only flips the flag INSIDE
      // the async truncate path, so a submit dispatched before
      // `onCommand: agent:clear` scheduled its truncate would
      // see `clearPersistFailed === false`, await the barrier,
      // and then (without this second check) proceed to append
      // new turns onto an un-truncated transcript. Re-reading
      // the flag here is cheap and closes the race cleanly.
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
      // Also re-check `lastResetFailed` — the in-memory reset
      // (resetSessionState, transcript splice, batcher rotate)
      // can fail independently of the durable truncate. If it
      // threw before `runtimeHandle.transcript.splice(0)` ran,
      // the UI has been cleared but the runtime transcript still
      // contains pre-clear messages, and the next submit would
      // run against stale history while the operator believes
      // the session was wiped. Mirror the picker / rewind block
      // logic and refuse here.
      if (lastResetFailed) {
        store.dispatch({
          kind: "add_error",
          code: "SUBMIT_AFTER_FAILED_RESET",
          message:
            "Submit is disabled because the most recent session reset failed. " +
            "The runtime may still hold stale conversation context. " +
            "Quit and relaunch with `koi tui --resume <id>` to recover from a " +
            "clean state.",
        });
        return;
      }

      // #11: include any pending clipboard images as image ContentBlocks
      // alongside the text. Bridge clears pendingImages after dispatch so the
      // next submit starts with an empty list.
      const imageBlocks = pendingImages.map((img) => ({
        kind: "image" as const,
        url: img.url,
      }));

      const controller = new AbortController();
      activeController = controller;

      // Clear any stale SIGINT arm from a previous bg-wait hint (#1772
      // review r2). If the user tapped Ctrl+C while idle with background
      // work running, the handler was left armed for the duration of
      // the double-tap window — if they then submit a new prompt inside
      // that window, a single Ctrl+C to cancel the new turn would be
      // treated as the second tap of the stale sequence and force-exit
      // the TUI. `complete()` is a no-op when the handler is idle, so
      // this is safe to call unconditionally at every turn start.
      sigintHandler.complete();

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
        // #10: resolve @-mention file references before sending to the engine.
        // Parses @path and @path#L10-20, reads files, injects content so the
        // model sees the file directly without needing to call Glob/fs_read.
        const resolved = resolveAtReferences(text, process.cwd());
        const modelText =
          resolved.injections.length > 0 ? formatAtReferencesForModel(resolved) : text;

        let stream: AsyncIterable<EngineEvent>;
        try {
          stream = isLoopMode
            ? runTuiLoopTurn(handle.runtime, modelText, controller.signal, flags, store)
            : handle.runtime.run({
                kind: "text",
                text: modelText,
                signal: controller.signal,
              });
        } catch (err) {
          store.dispatch({
            kind: "add_error",
            code: "RUNTIME_REJECTED",
            message: err instanceof Error ? err.message : String(err),
          });
          pendingImages = [];
          return;
        }
        pendingImages = [];
        store.dispatch({
          kind: "add_user_message",
          id: `user-${Date.now()}`,
          blocks: [{ kind: "text", text }, ...imageBlocks],
        });
        // Snapshot cumulative metrics BEFORE the drain — must copy values since
        // store.getState() returns a SolidJS reactive proxy (reads reflect live state).
        const cm = store.getState().cumulativeMetrics;
        const inputBefore = cm.inputTokens;
        const outputBefore = cm.outputTokens;
        const costBefore = cm.costUsd;
        const drainPromise = drainEngineStream(stream, store, batcher, controller.signal);
        activeRunPromise = drainPromise;
        const drainOutcome = await drainPromise;

        // #1753 review rounds 4 + 7 + 9: post-turn bookkeeping is
        // layered. `abandoned` and `failed` drains cannot advance any
        // session state, so they return early. `engine_error` is a
        // coherent terminal state — the error is already in the store
        // and trace data was captured up to the failure — so cost
        // delta + trajectory refresh must still run so operators can
        // diagnose the failure, but the rewind budget must NOT be
        // advanced (no rewindable checkpoint was produced).
        if (drainOutcome === "abandoned" || drainOutcome === "failed") {
          return;
        }

        // Count the turn for rewind boundary enforcement, but ONLY
        // when the turn completed uninterrupted AND produced a
        // real checkpoint. Aborted turns are filtered by the signal
        // guard; engine-errored turns are filtered by `drainOutcome
        // === "settled"` because ENGINE_ERRORs return `"engine_error"`
        // (#1753 review round 9).
        if (drainOutcome === "settled" && rewindBoundaryActive && !controller.signal.aborted) {
          postClearTurnCount += 1;
        }

        // Feed the cost bridge with this turn's token delta.
        const cmAfter = store.getState().cumulativeMetrics;
        const deltaInput = cmAfter.inputTokens - inputBefore;
        const deltaOutput = cmAfter.outputTokens - outputBefore;
        if (deltaInput > 0 || deltaOutput > 0) {
          // Compute per-turn cost delta from engine-reported costUsd.
          // Handle null→number transition (first turn): costBefore is null,
          // costAfter is the full cumulative — use it directly as the delta.
          let deltaCost: number | undefined;
          if (cmAfter.costUsd !== null) {
            deltaCost = costBefore !== null ? cmAfter.costUsd - costBefore : cmAfter.costUsd;
            if (deltaCost <= 0) deltaCost = undefined; // negative = correction, skip
          }
          costBridge.recordEngineDone({
            inputTokens: deltaInput,
            outputTokens: deltaOutput,
            costUsd: deltaCost,
          });
        }

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
    // #10: @-mention file completion
    onAtQuery: handleAtQuery,
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
  // SIGHUP (#1750): tmux sends SIGHUP when a session is killed. Without
  // this handler the TUI survives as an orphan (PPID 1). 129 = 128 + 1.
  const onProcessSighup = (): void => {
    void shutdown(129, "SIGHUP received (terminal hangup)");
  };
  // Stdin close (#1750): belt-and-suspenders — when the PTY master closes,
  // the fd fires 'close'. Does NOT require resume() (avoids perturbing
  // OpenTUI's raw terminal input). Only installed when stdin is a TTY to
  // prevent false triggers in test/pipe contexts. Uses exit code 129
  // (same as SIGHUP) because PTY close IS a hangup — using a generic
  // error code would mask the real termination cause for supervisors.
  // let: justified — set to false when done() resolves, preventing the
  // stdin close handler from force-exiting during external/host teardown.
  let tuiRunning = false;
  const onStdinClose = (): void => {
    // Only treat stdin close as a hangup when the TUI is actively
    // running AND no orderly shutdown is in progress. In embedded/test
    // callers the host may close stdin during normal teardown — that
    // should not force process.exit(129).
    if (tuiRunning && !shutdownStarted) {
      void shutdown(129, "stdin closed (parent terminal gone)");
    }
  };
  process.on("SIGINT", onProcessSigint);
  process.once("SIGTERM", onProcessSigterm);
  process.once("SIGHUP", onProcessSighup);

  // Register stdin close listener and set tuiRunning BEFORE start() so
  // PTY teardown during startup is not missed. tuiRunning is cleared in
  // the finally block to prevent false positives during host teardown.
  tuiRunning = true;
  if (process.stdin.isTTY) {
    process.stdin.once("close", onStdinClose);
  }

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
    tuiRunning = false;
    sigintHandler.dispose();
    process.removeListener("SIGINT", onProcessSigint);
    process.removeListener("SIGTERM", onProcessSigterm);
    process.removeListener("SIGHUP", onProcessSighup);
    process.stdin.removeListener("close", onStdinClose);
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
  runtime: KoiRuntimeHandle["runtime"],
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

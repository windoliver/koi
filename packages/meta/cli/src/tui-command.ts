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
import type { SummaryOk } from "@koi/agent-summary";
import { createAgentSummary } from "@koi/agent-summary";
import { type ArtifactStore, createArtifactStore } from "@koi/artifacts";
import { microcompact } from "@koi/context-manager";
import type {
  Agent,
  AuditEntry,
  ComponentProvider,
  ContentBlock,
  EngineEvent,
  GovernanceController,
  InboundMessage,
  JsonObject,
  RichTrajectoryStep,
  SessionId,
  SessionTranscript,
  SkillComponent,
  SubsystemToken,
  TranscriptEntry,
  TranscriptEntryId,
} from "@koi/core";
import { GOVERNANCE, sessionId } from "@koi/core";
import { formatCost, formatTokens } from "@koi/core/cost-tracker";
import type { DisplayableResumedMessage } from "@koi/core/message";
import { filterResumedMessagesForDisplay } from "@koi/core/message";
import { createAuthNotificationHandler } from "@koi/fs-nexus";
import type { PatternRule } from "@koi/governance-defaults";
import { createArgvGate, type LoopRuntime, runUntilPass } from "@koi/loop";
import { createApprovalStore, createPatternPermissionBackend } from "@koi/middleware-permissions";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import {
  createModelRouter,
  createModelRouterMiddleware,
  validateRouterConfig,
} from "@koi/model-router";
import { createArtifactToolProvider, resolveFileSystemAsync } from "@koi/runtime";
import { createJsonlTranscript, resumeForSession } from "@koi/session";
import {
  createProgressiveSkillProvider,
  createSkillInjectorMiddleware,
  createSkillsRuntime,
} from "@koi/skills-runtime";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { createBrowserProvider, createMockDriver } from "@koi/tool-browser";
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
import { BLOCKED_HOST_SUFFIXES, BLOCKED_HOSTS, isBlockedIp } from "@koi/url-safety";
import { getTreeSitterClient, SyntaxStyle } from "@opentui/core";
import { mergeGovernanceFlags } from "./args/governance-flags.js";
import type { TuiFlags } from "./args.js";
import { formatAtReferencesForModel, resolveAtReferences } from "./at-reference.js";
import { createAuthInterceptor } from "./auth-interceptor.js";
import { scrubSensitiveEnv } from "./commands/start.js";
import { type CostBridge, createCostBridge } from "./cost-bridge.js";
import { createCurrentModelMiddleware } from "./current-model-middleware.js";
import { resolveApiConfig } from "./env.js";
import { createFileCompletionHandler } from "./file-completions.js";
import { createForegroundSubmitQueue } from "./foreground-submit-queue.js";
import { createGovernanceBridge, type GovernanceBridge } from "./governance-bridge.js";
import { loadManifestConfig, revalidateAuditPathContainment } from "./manifest.js";
import { type FetchModelsResult, fetchAvailableModels } from "./model-list-fetch.js";
import { createOAuthChannel } from "./oauth-channel.js";
import { initOtelSdk } from "./otel-bootstrap.js";
import { loadPolicyFile } from "./policy-file.js";
import { resolveManifestPath } from "./resolve-manifest-path.js";
import { decideResumeHint, formatPickerModeResumeHint, formatResumeHint } from "./resume-hint.js";
import type { KoiRuntimeHandle } from "./runtime-factory.js";
import { createKoiRuntime, TUI_APPROVAL_TIMEOUT_MS } from "./runtime-factory.js";
import { createSecurityBridge, type SecurityBridge } from "./security-bridge.js";
import { readSessionMeta, resumeSessionFromJsonl, writeSessionMeta } from "./shared-wiring.js";
import { createUnrefTimer } from "./sigint-handler.js";
import { createTuiSigintHandler } from "./tui-graceful-sigint.js";
import {
  createSigusr1Handler,
  generateTuiStartupHint,
  removeStoredEarlySigusr1Handler,
  SIGUSR1_EXIT_CODE,
  SIGUSR1_SUPPORTED,
} from "./tui-sigusr1.js";
import {
  type ManifestSupervisionHandle,
  wireManifestSupervision,
} from "./wire-manifest-supervision.js";

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
const ARTIFACTS_DIR = join(homedir(), ".koi", "artifacts");
/** Maximum characters for session name (first user message) in session picker. */
const SESSION_NAME_MAX = 60;
/** Maximum characters for session preview (last message) in session picker. */
const SESSION_PREVIEW_MAX = 80;

// ---------------------------------------------------------------------------
// Slash-command helpers (system:model, system:cost, session:export, etc.)
// ---------------------------------------------------------------------------

/**
 * Dispatch a system-generated notice as an info block.
 *
 * Used by /model, /cost, /tokens, /compact, /export, /zoom to surface
 * slash-command output in the conversation stream without polluting the
 * runtime.transcript (which feeds the next model call).
 *
 * Previously dispatched via `add_user_message`, which rendered notices
 * as synthetic `You:` turns and satisfied the rewind-hint heuristic
 * (`messages.some(m => m.kind === "user")`) even when no rewindable turn
 * existed. Now routes through `add_info` → `InfoBlock` (cyan neutral
 * styling), so notices no longer look like user input and don't
 * falsely enable the rewind hint. The `tag` parameter is retained at
 * the call site for traceability but unused (add_info ids are derived
 * from message index).
 */
function dispatchNotice(store: TuiStore, _tag: string, text: string): void {
  store.dispatch({ kind: "add_info", message: text });
}

/**
 * Defensive bounds on context-window values from provider `/models`.
 *
 * OpenRouter/OpenAI/Anthropic all report sane positive integers (8k..2M),
 * but a broken provider, a forged response, or a future schema drift could
 * send 0, negative, or pathological values. Both extremes break compaction:
 * a tiny window forces thrash-truncation of every message; a huge window
 * effectively disables compaction until the provider itself rejects the
 * call. Validate before trusting.
 *
 * MIN=2048: below this, even a single system prompt + user turn overflows
 * so the registry default is always safer. MAX=4_000_000: covers today's
 * largest public windows (Anthropic's 1M) with headroom; anything larger
 * is almost certainly a metadata bug.
 */
export function clampContextLength(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) return undefined;
  if (raw < 2048 || raw > 4_000_000) return undefined;
  return raw;
}

// ---------------------------------------------------------------------------
// /summarize helpers — map InboundMessage[] → TranscriptEntry[] + render envelope
// ---------------------------------------------------------------------------

function inferRole(senderId: string): TranscriptEntry["role"] {
  if (senderId === "user") return "user";
  if (senderId.startsWith("tool:")) return "tool_result";
  if (senderId.startsWith("system")) return "system";
  return "assistant";
}

function flattenContentBlocks(blocks: readonly ContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") out.push(b.text);
    else if (b.kind === "file") out.push(`[file: ${b.name ?? b.url}]`);
    else if (b.kind === "image") out.push(`[image: ${b.alt ?? b.url}]`);
    else if (b.kind === "button") out.push(`[button: ${b.label}]`);
    else out.push(`[${b.kind}]`);
  }
  return out.join(" ");
}

function renderSummaryEnvelope(env: SummaryOk): string {
  if (env.kind === "clean") {
    const s = env.summary;
    return [
      `[Summary (${s.meta.granularity}) — ${s.status}]`,
      `  Goal: ${s.goal}`,
      ...(s.outcomes.length > 0 ? [`  Outcomes: ${s.outcomes.join("; ")}`] : []),
      ...(s.errors.length > 0 ? [`  Errors: ${s.errors.join("; ")}`] : []),
      ...(s.learnings.length > 0 ? [`  Learnings: ${s.learnings.join("; ")}`] : []),
    ].join("\n");
  }
  if (env.kind === "degraded") {
    const s = env.partial;
    return [
      `[Summary — DEGRADED (dropped ${env.droppedTailTurns} turn${env.droppedTailTurns === 1 ? "" : "s"}, ${env.skipped.length} skipped rows)]`,
      `  Goal: ${s.goal}`,
      `  Status: ${s.status}`,
    ].join("\n");
  }
  const s = env.derived;
  return [
    `[Summary — COMPACTED (${env.compactionEntryCount} compaction prefix${env.compactionEntryCount === 1 ? "" : "es"}, range origin post-compaction)]`,
    `  Goal: ${s.goal}`,
    `  Status: ${s.status}`,
  ].join("\n");
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
 * Compute the `/mcp` view status label for an MCP server from the resolver
 * failure code, the server's configured transport kind, and whether it has a
 * usable OAuth config.
 *
 * `needs-auth` is an actionable state — the TUI binds Enter to `nav:mcp-auth`
 * which launches the OAuth PKCE flow. It is only valid when:
 *   1. The failure is `AUTH_REQUIRED`
 *   2. Transport is HTTP (stdio/SSE have no OAuth flow)
 *   3. The server has an `oauth` config block (non-OAuth HTTP servers like
 *      static-token / basic-auth / API-key cannot be fixed via the TUI)
 *
 * Everything else surfaces as `error` so users see a clear failure state
 * rather than an Enter-to-auth prompt that will immediately fail.
 *
 * @internal — exported for unit tests only.
 */
export function computeLiveMcpStatus(
  failureCode: string | undefined,
  transport: "http" | "stdio" | "sse" | undefined,
  hasOAuth: boolean,
): "connected" | "needs-auth" | "error" {
  if (failureCode === undefined) return "connected";
  if (failureCode !== "AUTH_REQUIRED") return "error";
  if (transport !== "http") return "error";
  if (!hasOAuth) return "error";
  return "needs-auth";
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
  // `loadManifestConfig` (see manifest.ts). `koi tui` supports both
  // `backend: "local"` and `backend: "nexus"` (with or without scope).
  // For nexus with local-bridge transport, the TUI wires the OAuth auth
  // loop: createAuthNotificationHandler (outbound) + createAuthInterceptor
  // (inbound) so the user can complete OAuth flows inline.
  let manifestFilesystemOps: readonly ("read" | "write" | "edit")[] | undefined;
  // Full filesystem config for nexus async resolution — stored here so the
  // async resolve can run just before createKoiRuntime (after TUI setup).
  let manifestFilesystemConfig: import("@koi/core").FileSystemConfig | undefined;
  let manifestMiddleware: import("./manifest.js").ManifestMiddlewareEntry[] | undefined;
  let manifestGovernance: import("./manifest.js").ManifestGovernanceConfig | undefined;
  let manifestSupervision: import("@koi/core").SupervisionConfig | undefined;
  let manifestAudit: import("./manifest.js").ManifestAuditConfig | undefined;
  let manifestLoadPath: string | undefined; // tracks which path was loaded, for TOCTOU revalidation
  // Mirror start.ts: when resuming without an explicit --manifest, bypass
  // auto-discovery so the cwd manifest cannot silently override the model,
  // stacks, plugins, filesystem scope, or governance of the original session.
  const skipManifestDiscovery =
    flags.noManifest || (flags.resume !== undefined && flags.manifest === undefined);
  const resolvedManifestResult = resolveManifestPath(
    process.cwd(),
    flags.manifest,
    skipManifestDiscovery,
  );
  if (!resolvedManifestResult.ok) {
    process.stderr.write(`koi tui: ${resolvedManifestResult.error}\n`);
    process.exit(1);
  }
  // Distinguish auto-discovery miss from explicit --no-manifest opt-out.
  // When discovery was attempted and found nothing, warn so operators are not
  // surprised that manifest-controlled stacks/plugins/governance are inactive.
  if (resolvedManifestResult.path === undefined && !skipManifestDiscovery) {
    const searched = resolvedManifestResult.searched.length;
    const hint = searched > 0 ? ` (searched ${searched} location${searched === 1 ? "" : "s"})` : "";
    process.stderr.write(
      `koi tui: no manifest found${hint} — running with built-in defaults. Pass --manifest <path> to load one or --no-manifest to suppress this warning.\n`,
    );
  }
  const resolvedManifestPath = resolvedManifestResult.path;
  if (resolvedManifestPath !== undefined) {
    // Pass allowOAuthSchemes so the manifest loader skips the local-only
    // scheme allowlist for this host — the TUI wires the auth loop below.
    // manifest.audit is a declarative intent marker — actual sink paths always
    // come from KOI_AUDIT_* env vars. Skip strict audit path validation when
    // the env var for a given sink is already set (the manifest path is never
    // opened, so stale paths must not block startup). Always skip for
    // --no-governance (violations sink disabled at runtime anyway).
    const manifestResult = await loadManifestConfig(resolvedManifestPath, {
      allowOAuthSchemes: true,
      skipAuditValidation: false,
      skipAuditValidationFor: {
        ndjson: process.env.KOI_AUDIT_NDJSON !== undefined,
        sqlite: process.env.KOI_AUDIT_SQLITE !== undefined,
        violations: !flags.governance.enabled || process.env.KOI_AUDIT_VIOLATIONS !== undefined,
      },
    });
    if (!manifestResult.ok) {
      process.stderr.write(`koi tui: invalid manifest — ${manifestResult.error}\n`);
      process.exit(1);
    }
    manifestModelName = manifestResult.value.modelName;
    manifestInstructions = manifestResult.value.instructions;
    manifestStacks = manifestResult.value.stacks;
    manifestPlugins = manifestResult.value.plugins;
    manifestBackgroundSubprocesses = manifestResult.value.backgroundSubprocesses;
    manifestGovernance = manifestResult.value.governance;
    manifestSupervision = manifestResult.value.supervision;
    manifestAudit = manifestResult.value.audit;
    manifestLoadPath = resolvedManifestPath;

    // Fail-closed audit intent enforcement — applies regardless of KOI_ALLOW_MANIFEST_FILE_SINKS.
    // manifest.audit paths are never used as actual file paths (atomic containment
    // requires openat-style APIs unavailable in Node.js/Bun). The manifest block
    // is a declarative intent marker: its presence requires matching KOI_AUDIT_*
    // env vars so the operator explicitly controls every declared sink.
    // KOI_AUDIT_NDJSON="" / KOI_AUDIT_SQLITE="" / KOI_AUDIT_VIOLATIONS="" are
    // authoritative overrides that satisfy the intent check — undefined is the failure
    // case. For violations, empty string is passed through to the runtime which treats
    // length===0 as explicit disable (no fallback to ~/.koi/violations.db).
    //
    // Two cases based on block shape:
    //   Malformed — require all three env vars (can't infer per-sink intent)
    //   Well-formed — per-sink check; violations skipped when governance disabled
    if (manifestAudit !== undefined) {
      if (manifestAudit.malformed === true) {
        const allCoveredByEnv =
          process.env.KOI_AUDIT_NDJSON !== undefined &&
          process.env.KOI_AUDIT_SQLITE !== undefined &&
          (!flags.governance.enabled || process.env.KOI_AUDIT_VIOLATIONS !== undefined);
        if (!allCoveredByEnv) {
          const missingVars = [
            process.env.KOI_AUDIT_NDJSON === undefined ? "KOI_AUDIT_NDJSON" : "",
            process.env.KOI_AUDIT_SQLITE === undefined ? "KOI_AUDIT_SQLITE" : "",
            flags.governance.enabled && process.env.KOI_AUDIT_VIOLATIONS === undefined
              ? "KOI_AUDIT_VIOLATIONS"
              : "",
          ]
            .filter(Boolean)
            .join(" + ");
          process.stderr.write(
            "koi tui: manifest.audit has an unrecognized format (unknown fields or invalid value) — " +
              "refusing to start because audit intent cannot be determined. " +
              `Fix the manifest, or set ${missingVars} to control all active audit sinks, or remove the audit: block.\n`,
          );
          process.exit(1);
        }
      } else {
        const ndjsonExposed =
          manifestAudit.ndjson !== undefined && process.env.KOI_AUDIT_NDJSON === undefined;
        const sqliteExposed =
          manifestAudit.sqlite !== undefined && process.env.KOI_AUDIT_SQLITE === undefined;
        const violationsExposed =
          flags.governance.enabled &&
          manifestAudit.violations !== undefined &&
          process.env.KOI_AUDIT_VIOLATIONS === undefined;
        if (ndjsonExposed || sqliteExposed || violationsExposed) {
          process.stderr.write(
            "koi tui: manifest.audit declares audit sinks but the matching KOI_AUDIT_* env vars are absent — " +
              "refusing to start to prevent silently dropping declared audit logging. " +
              "Set each matching KOI_AUDIT_* env var (empty string disables that sink — for violations, empty string prevents the ~/.koi/violations.db fallback), " +
              "or remove the sink key from manifest.audit.\n",
          );
          process.exit(1);
        }
      }
    }

    if (manifestResult.value.filesystem !== undefined) {
      // Store the full config for async resolution before runtime assembly.
      // Apply the `FileSystemConfig.operations` contract's `["read"]`
      // default at the host level. `buildCoreProviders` honors
      // `filesystemOperations` verbatim. NOTE: this gates only the
      // `fs_*` tools — the `execution` preset stack still contributes
      // Bash, so a model in a read-only manifest posture can still
      // mutate the workspace via shell commands. Manifest authors who
      // need a true read-only posture should also omit `execution`
      // from `manifest.stacks`.
      manifestFilesystemConfig = manifestResult.value.filesystem;
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

  const store = createStore(createInitialState(modelName));

  // Current-model middleware: holds a mutable box that the model-picker
  // modal mutates via TuiRoot's `onModelSwitch` callback. Rewrites
  // `request.model` on every turn so the next model stream uses the
  // freshly picked model without rebuilding the runtime. Composed OUTER
  // of `modelRouterMiddleware` so any fallback chain sees the latest
  // host-picked model id.
  const { middleware: currentModelMiddleware, box: currentModelBox } =
    createCurrentModelMiddleware(modelName);

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

  // Persist manifest provenance so future resumes can enforce audit intent
  // against the original session's manifest, not the cwd at resume time.
  if (flags.resume === undefined && resolvedManifestPath !== undefined) {
    await writeSessionMeta(SESSIONS_DIR, String(tuiSessionId), {
      manifestPath: resolvedManifestPath,
    });
  }

  // Resume-path audit intent enforcement using stored session provenance.
  // The check mirrors the new-session path but is keyed on the manifest that
  // actually governed the original session, not a cwd rediscovery.
  if (flags.resume !== undefined) {
    const resumeMeta = await readSessionMeta(SESSIONS_DIR, String(tuiSessionId));
    if (resumeMeta.manifestPath !== undefined) {
      const resumeAuditResult = await loadManifestConfig(resumeMeta.manifestPath, {
        allowOAuthSchemes: true,
        skipAuditValidation: false,
        skipAuditValidationFor: {
          ndjson: process.env.KOI_AUDIT_NDJSON !== undefined,
          sqlite: process.env.KOI_AUDIT_SQLITE !== undefined,
          violations: !flags.governance.enabled || process.env.KOI_AUDIT_VIOLATIONS !== undefined,
        },
      });
      if (!resumeAuditResult.ok) {
        const allCoveredByEnv =
          process.env.KOI_AUDIT_NDJSON !== undefined &&
          process.env.KOI_AUDIT_SQLITE !== undefined &&
          (!flags.governance.enabled || process.env.KOI_AUDIT_VIOLATIONS !== undefined);
        if (!allCoveredByEnv) {
          process.stderr.write(
            "koi tui: original session manifest cannot be parsed — " +
              "refusing to resume because audit intent cannot be verified. " +
              "Set KOI_AUDIT_NDJSON + KOI_AUDIT_SQLITE + KOI_AUDIT_VIOLATIONS to cover all " +
              "audit sinks, or pass --manifest to re-specify the manifest explicitly.\n",
          );
          process.exit(1);
        }
      } else if (resumeAuditResult.value.audit !== undefined) {
        const resumeAudit = resumeAuditResult.value.audit;
        if (resumeAudit.malformed === true) {
          const allCoveredByEnv =
            process.env.KOI_AUDIT_NDJSON !== undefined &&
            process.env.KOI_AUDIT_SQLITE !== undefined &&
            (!flags.governance.enabled || process.env.KOI_AUDIT_VIOLATIONS !== undefined);
          if (!allCoveredByEnv) {
            const missingVars = [
              process.env.KOI_AUDIT_NDJSON === undefined ? "KOI_AUDIT_NDJSON" : "",
              process.env.KOI_AUDIT_SQLITE === undefined ? "KOI_AUDIT_SQLITE" : "",
              flags.governance.enabled && process.env.KOI_AUDIT_VIOLATIONS === undefined
                ? "KOI_AUDIT_VIOLATIONS"
                : "",
            ]
              .filter(Boolean)
              .join(" + ");
            process.stderr.write(
              "koi tui: original session manifest.audit has an unrecognized format — " +
                "refusing to resume because audit intent cannot be determined. " +
                `Fix the manifest, or set ${missingVars} to cover all active audit sinks.\n`,
            );
            process.exit(1);
          }
        } else {
          const ndjsonExposed =
            resumeAudit.ndjson !== undefined && process.env.KOI_AUDIT_NDJSON === undefined;
          const sqliteExposed =
            resumeAudit.sqlite !== undefined && process.env.KOI_AUDIT_SQLITE === undefined;
          const violationsExposed =
            flags.governance.enabled &&
            resumeAudit.violations !== undefined &&
            process.env.KOI_AUDIT_VIOLATIONS === undefined;
          if (ndjsonExposed || sqliteExposed || violationsExposed) {
            process.stderr.write(
              "koi tui: original session manifest.audit declares audit sinks but the matching " +
                "KOI_AUDIT_* env vars are absent — refusing to resume to prevent silently " +
                "dropping declared audit logging. Set each matching KOI_AUDIT_* env var " +
                "(empty string disables that sink), or pass --manifest and re-specify the manifest.\n",
            );
            process.exit(1);
          }
        }
      }
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

  // --- Skills: progressive mode ---
  // Phase 1: provider attaches skill components (metadata only, no bodies).
  // Phase 2: middleware injects <available_skills> XML per model call.
  // The Skill tool loads full bodies on-demand from the same runtime.
  // Startup I/O matches the old eager path (loadAll() still runs for
  // blocked-skill visibility); benefit is per-call token reduction.
  // createProgressiveSkillProvider bundles session-snapshot pinning: bodies
  // loaded at attach time are stored in a session-local Map that is not subject
  // to LRU eviction, ensuring the Skill tool always returns the body that was
  // valid at session start.
  const {
    provider: skillProvider,
    pinnedRuntime: skillRuntime,
    reload: reloadSkillComponents,
  } = createProgressiveSkillProvider(createSkillsRuntime());
  // Lazy agent ref — middleware created before createKoiRuntime assembles agent.
  const skillAgentRef: { current: Agent | undefined } = { current: undefined };
  // Mutable live skill component map — refreshed on session reset via reloadSkillComponents().
  // Initially populated from the agent ECS after createKoiRuntime wires skillAgentRef.current.
  // The middleware reads from this map (not the static ECS) so session resets can refresh
  // the advertised skill inventory without rebuilding the entire agent.
  // let: justified — replaced on each session reset
  let liveSkillComponents: ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent> = new Map();
  const skillInjectorMw = createSkillInjectorMiddleware({
    agent: (): Agent => {
      if (skillAgentRef.current === undefined) throw new Error("skill agent ref not yet wired");
      const real = skillAgentRef.current;
      // Return a wrapped agent that reads skills from the mutable liveSkillComponents
      // map instead of the static ECS. This allows session resets to refresh the
      // advertised skill inventory by updating liveSkillComponents.
      return {
        ...real,
        query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> =>
          prefix === "skill:"
            ? (liveSkillComponents as unknown as ReadonlyMap<SubsystemToken<T>, T>)
            : real.query<T>(prefix),
      } as Agent;
    },
    progressive: true,
  });
  // Child skill injector: same progressive XML block, but filtered to only
  // runtimeBacked skills — body-backed skills (browser, memory helpers) belong
  // to root-only providers whose tools are NOT inherited by spawned children.
  // Using the full liveSkillComponents would advertise tools children can't use.
  const childSkillInjectorMw = createSkillInjectorMiddleware({
    agent: (): Agent => {
      if (skillAgentRef.current === undefined) throw new Error("skill agent ref not yet wired");
      const real = skillAgentRef.current;
      return {
        ...real,
        query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> =>
          prefix === "skill:"
            ? (new Map(
                [...liveSkillComponents.entries()].filter(
                  ([, comp]) => (comp as { runtimeBacked?: boolean }).runtimeBacked === true,
                ),
              ) as unknown as ReadonlyMap<SubsystemToken<T>, T>)
            : real.query<T>(prefix),
      } as Agent;
    },
    progressive: true,
  });
  // Manifest instructions replace DEFAULT_SYSTEM_PROMPT when supplied —
  // mirrors `koi start --manifest` behavior. Skills are injected by
  // skillInjectorMw, not concatenated into systemPrompt.
  const baseSystemPrompt = manifestInstructions ?? DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = baseSystemPrompt;

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

  // ---------------------------------------------------------------------------
  // Auth loop wiring — nexus local-bridge transport (Tasks 11 + 14)
  // ---------------------------------------------------------------------------
  //
  // When the manifest declares a nexus backend with a local-bridge transport,
  // we resolve the filesystem async so the bridge subprocess starts before the
  // runtime is assembled. Two auth hooks are wired here:
  //
  //   Outbound: `createAuthNotificationHandler(channel)` is subscribed to
  //   transport notifications so `auth_required` / `auth_progress` /
  //   `auth_complete` events are forwarded to the TUI channel as chat
  //   messages.
  //
  //   Inbound: `createAuthInterceptor(transport)` is held in
  //   `tuiAuthInterceptor` and checked in `onSubmit` before the message
  //   is passed to the engine. When the user pastes a localhost redirect
  //   URL, the interceptor routes it to `transport.submitAuthCode(...)` and
  //   swallows the text so it never reaches the model.
  //
  // `tuiAuthCorrelationId` tracks the `correlationId` from the most-recent
  // `auth_required` notification with `mode: "remote"` — forwarded to
  // `submitAuthCode` so the bridge can correlate the pasted URL to the
  // pending OAuth flow.

  // Channel adapter for auth notifications — wraps the TUI store so
  // `createAuthNotificationHandler` can dispatch messages. Only `send` is
  // meaningful here; the other ChannelAdapter fields are no-ops because this
  // channel is used only for fire-and-forget auth notification delivery.
  const tuiChannelForAuth: import("@koi/core").ChannelAdapter = {
    name: "koi-tui-auth-notifications",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    },
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},
    send: async (message): Promise<void> => {
      const textBlock = message.content.find((b) => b.kind === "text");
      if (textBlock !== undefined && textBlock.kind === "text") {
        // Route OAuth notices through add_info (non-transcript) so auth URLs
        // and completion text never enter conversation state replayed to the model.
        store.dispatch({ kind: "add_info", message: textBlock.text });
      }
    },
    onMessage: () => () => {},
  };

  // let: set when nexus local-bridge transport is resolved; undefined otherwise
  let tuiAuthInterceptor:
    | ((message: string, correlationId: string | undefined) => { readonly intercepted: boolean })
    | undefined;
  // let: updated when auth_required fires with mode:"remote"
  let tuiAuthCorrelationId: string | undefined;

  // Resolved nexus backend (if any). Passed to `createKoiRuntime` via `filesystem`.
  // The `dispose()` on this backend closes the bridge subprocess and unsubscribes.
  let resolvedFilesystemBackend: import("@koi/core").FileSystemBackend | undefined;

  // Single OAuthChannel — shared by nexus and MCP. Created unconditionally so
  // nav:mcp-auth and MCP onAuthNeeded always have a renderer regardless of whether
  // a nexus filesystem is configured. submitAuthCode is forwarded to the nexus
  // transport once it resolves (no-op for non-nexus sessions).
  // let: nexusSubmitAuthCode populated after transport resolves
  let nexusSubmitAuthCode: ((url: string, correlationId?: string) => void) | undefined;
  const tuiOAuthChannel: import("@koi/core").OAuthChannel = createOAuthChannel({
    channel: tuiChannelForAuth,
    onSubmit: (url, correlationId) => nexusSubmitAuthCode?.(url, correlationId),
  });
  let tuiAuthNotificationHandler: ReturnType<typeof createAuthNotificationHandler> | undefined;
  if (manifestFilesystemConfig !== undefined) {
    tuiAuthNotificationHandler = createAuthNotificationHandler(tuiOAuthChannel, tuiChannelForAuth);
    const fsResolved = await resolveFileSystemAsync(
      manifestFilesystemConfig,
      process.cwd(),
      tuiAuthNotificationHandler,
    );
    resolvedFilesystemBackend = fsResolved.backend;
    // If `fsResolved.operations` is set, it overrides the manifest-derived ops
    // (the two should agree, but resolveFileSystemAsync is authoritative).
    if (fsResolved.operations !== undefined) {
      manifestFilesystemOps = fsResolved.operations;
    }
    // Wire inbound OAuth interceptor when a local-bridge transport is available.
    if (fsResolved.transport !== undefined) {
      const transport = fsResolved.transport;
      nexusSubmitAuthCode = (url, id) => transport.submitAuthCode(url, id);
      // Subscribe extra: track correlationId from auth_required (mode: "remote").
      transport.subscribe((n) => {
        if (n.method === "auth_required" && n.params.mode === "remote") {
          tuiAuthCorrelationId = n.params.correlation_id;
        } else if (n.method === "auth_complete") {
          tuiAuthCorrelationId = undefined;
        }
      });
      tuiAuthInterceptor = createAuthInterceptor(transport);
    }
  }

  // Runtime assembly happens in parallel with TUI rendering (P2-A).
  // The runtimeReady promise resolves before the first submit.
  // let: set once when the promise resolves
  let runtimeHandle: KoiRuntimeHandle | null = null;
  // Manifest-declared supervision (#1866). Populated only when the loaded
  // koi.yaml carries a `supervision:` block. Disposed in reverse-construction
  // order in the teardown chain below.
  let supervisionHandle: ManifestSupervisionHandle | undefined;
  // Declared ahead of interim teardown so a SIGUSR1 arriving during boot
  // can safely inspect it without tripping a TDZ error. Assigned below,
  // once the advisory lock has been acquired.
  // let: reassigned from undefined to the open store on successful construction.
  let artifactStore: ArtifactStore | undefined;
  // Task 13: when the backend is nexus, prefix fs_* tool approval reason
  // with "[nexus: <transport>]" so the user can tell at a glance that the
  // operation targets a remote filesystem, not a local path. The label is
  // derived from the resolved backend name (e.g. "nexus-local:gdrive://...").
  const FS_TOOL_NAMES = new Set<string>(["fs_read", "fs_write", "fs_edit"]);
  const nexusBackendLabel =
    resolvedFilesystemBackend !== undefined && resolvedFilesystemBackend.name !== "local"
      ? `[nexus: ${resolvedFilesystemBackend.name.startsWith("nexus-local:") ? "local" : resolvedFilesystemBackend.name}]`
      : undefined;
  const labeledApprovalHandler: import("@koi/core").ApprovalHandler =
    nexusBackendLabel !== undefined
      ? async (request) => {
          const labeled = FS_TOOL_NAMES.has(request.toolId)
            ? { ...request, reason: `${nexusBackendLabel} ${request.reason}` }
            : request;
          return permissionBridge.handler(labeled);
        }
      : permissionBridge.handler;

  // let: incremented on each /mcp navigation; stale background refreshes drop their dispatch
  let mcpViewGeneration = 0;
  // Per-server in-flight auth guard — prevents overlapping OAuth flows
  const mcpAuthInFlight = new Set<string>();
  const yoloPermissionBackend = flags.yolo
    ? createPatternPermissionBackend({ rules: { allow: ["*"], deny: [], ask: [] } })
    : undefined;

  // ---------------------------------------------------------------------------
  // Shutdown latch — declared here (hoisted from its original position at
  // line ~2274) so the interim SIGUSR1 teardown below and the full
  // `shutdown()` further down share ONE idempotence flag (#1906 R4 review).
  // Without a shared latch, SIGUSR1 during bootstrap kicks off interim
  // teardown but bootstrap continues forward; a subsequent SIGUSR1 or
  // graceful path would race the interim teardown. Consolidating to a
  // single sentinel means the first shutdown request wins and every later
  // signal — interim, full, or /quit — is a no-op.
  // ---------------------------------------------------------------------------
  // let: justified — set once on first shutdown request, shared across
  // interim teardown, full shutdown, and section 4b upgrade.
  let shutdownStarted = false;

  // ---------------------------------------------------------------------------
  // Interim SIGUSR1 handler (#1906 R1/R2/R4) — covers the window from this
  // point through section 4b where the full `shutdown()` handler installs.
  // SIGUSR1 during runtime/MCP bootstrap runs an ASYNC, ordered teardown
  // (matching the normal shutdown sequencing: SIGTERM background tasks
  // → await runtime.dispose → dispose filesystem backend → flush OTel →
  // close approvals → dispose batcher → process.exit) with a 6s hard-exit
  // failsafe so a wedged dispose cannot strand the user. Upgraded to the
  // full handler at section 4b once `shutdown` is defined.
  // ---------------------------------------------------------------------------
  // Interim hard-exit failsafe: shorter than the full shutdown's 8s because
  // there is strictly less to tear down this early in bootstrap.
  const INTERIM_SHUTDOWN_HARD_EXIT_MS = 6_000;
  // let: justified — set once, then cleared when the full handler takes over.
  let interimSigusr1Handler: (() => void) | null = null;
  if (SIGUSR1_SUPPORTED) {
    const interimTeardown = async (exitCode: number): Promise<void> => {
      // Use the shared `shutdownStarted` latch so a second SIGUSR1 during
      // interim teardown — or an accidental later call from the full
      // shutdown path — is a no-op. Flipping it before the first async step
      // also means bootstrap code that later checks `shutdownStarted` can
      // short-circuit instead of racing the teardown.
      if (shutdownStarted) return;
      shutdownStarted = true;
      // Arm the hard-exit failsafe FIRST so even if an awaited step wedges
      // we are not stranded. Unref'd so natural completion still lets
      // the explicit process.exit below run when everything finishes.
      const hardExit = setTimeout(() => {
        process.exit(exitCode);
      }, INTERIM_SHUTDOWN_HARD_EXIT_MS);
      if (typeof hardExit === "object" && hardExit !== null && "unref" in hardExit) {
        (hardExit as { unref: () => void }).unref();
      }
      // Ref'd keepalive — mirror the full `shutdown()` pattern (line ~2326).
      // Bun drops pending microtasks once the last real handle disappears,
      // so without this interval the first `await runtime.dispose()` can
      // let the event loop exit before the continuation resumes, skipping
      // every subsequent cleanup step and the final `process.exit`. The
      // hard-exit failsafe still guards against a wedged await.
      const keepAlive = setInterval(() => {
        /* ref'd keepalive only */
      }, 1000);
      try {
        // Kick background-task SIGTERM synchronously so stubborn subprocesses
        // start dying before we begin the async dispose chain.
        try {
          runtimeHandle?.shutdownBackgroundTasks();
        } catch {}
        try {
          await supervisionHandle?.dispose();
        } catch {}
        try {
          if (runtimeHandle !== null) {
            await runtimeHandle.runtime.dispose();
          }
        } catch {}
        // Dispose the auth notification handler synchronously first: the
        // filesystem dispose below unsubscribes then awaits, and that yield
        // can still run a pre-queued notification microtask. Handler dispose
        // races ahead of the yield so late callbacks short-circuit on the
        // `active` flag.
        try {
          tuiAuthNotificationHandler?.dispose();
        } catch {}
        try {
          await resolvedFilesystemBackend?.dispose?.();
        } catch {}
        try {
          await otelHandle?.shutdown();
        } catch {}
        try {
          approvalStore?.close();
        } catch {}
        try {
          batcher.dispose();
        } catch {}
        try {
          await artifactStore?.close();
        } catch {}
      } finally {
        clearInterval(keepAlive);
        process.exit(exitCode);
      }
    };
    interimSigusr1Handler = createSigusr1Handler({
      shutdown: (code) => {
        void interimTeardown(code);
      },
      write: (msg) => {
        try {
          process.stderr.write(msg);
        } catch {}
      },
    });
    removeStoredEarlySigusr1Handler();
    process.on("SIGUSR1", interimSigusr1Handler);
  }

  // Artifact store (@koi/artifacts) — one store per TUI process, rooted at
  // ~/.koi/artifacts. All saves/lists/deletes happen as `tuiSessionId`.
  // Opening fails loudly when another TUI already holds the advisory lock
  // — we surface the reason to stderr and continue without artifact tools
  // rather than hard-aborting the session.
  const artifactExtraProviders: ComponentProvider[] = [];
  try {
    artifactStore = await createArtifactStore({
      dbPath: join(ARTIFACTS_DIR, "store.db"),
      blobDir: join(ARTIFACTS_DIR, "blobs"),
    });
    artifactExtraProviders.push(
      createArtifactToolProvider({ store: artifactStore, sessionId: tuiSessionId }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`koi tui: artifact store disabled — ${msg}\n`);
  }

  // Merge manifest governance defaults under the CLI flags — CLI always
  // wins. `--no-governance` disables governance entirely regardless of
  // what the manifest declares.
  const governance = mergeGovernanceFlags(
    flags.governance,
    manifestGovernance !== undefined
      ? {
          maxSpendUsd: manifestGovernance.maxSpend,
          maxTurns: manifestGovernance.maxTurns,
          maxSpawnDepth: manifestGovernance.maxSpawnDepth,
          policyFilePath: manifestGovernance.policyFile,
          alertThresholds: manifestGovernance.alertThresholds,
        }
      : undefined,
  );

  // Load policy-file (if any) before runtime construction so a malformed
  // YAML/JSON surfaces at boot, not on the first tool call (gov-10).
  let governanceRules: readonly PatternRule[] | undefined;
  if (governance.enabled && governance.policyFilePath !== undefined) {
    try {
      governanceRules = await loadPolicyFile(governance.policyFilePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`koi tui: ${msg}\n`);
      process.exit(2);
    }
  }

  if (process.env.KOI_BROWSER_MOCK === "1") {
    // Require explicit confirmation to prevent accidental enablement via inherited env vars.
    // Both variables must be present together; KOI_BROWSER_MOCK alone is not enough.
    if (process.env.KOI_BROWSER_MOCK_CONFIRM !== "1") {
      process.stderr.write(
        "\nError: KOI_BROWSER_MOCK=1 requires KOI_BROWSER_MOCK_CONFIRM=1 to also be set.\n" +
          "  This prevents browser mock mode from being enabled by an inherited environment.\n" +
          "  To activate: set both KOI_BROWSER_MOCK=1 KOI_BROWSER_MOCK_CONFIRM=1\n\n",
      );
      process.exit(2);
    }
    process.stderr.write(
      "\n⚠️  KOI_BROWSER_MOCK=1 — browser tools use a SIMULATED (mock) driver.\n" +
        "   No real browser is launched. All browser_* results are canned test responses.\n" +
        "   Do NOT use this mode to verify real browser automation outcomes.\n\n",
    );
  }

  // Declared before runtimeReady to avoid Temporal Dead Zone: the .then()
  // callback registered on runtimeReady can fire during the `await
  // createCostBridge` below, before the original `let` at line 2055 is reached.
  let governanceBridge: GovernanceBridge | undefined;

  // Security bridge — always-on observe-phase middleware that feeds injection/PII
  // findings into the TUI store. Created unconditionally (unlike governance which
  // gates on --max-spend / GOVERNANCE component presence) because the analyzers are
  // stateless and cheap.
  const securityBridge: SecurityBridge = createSecurityBridge({
    store,
    sessionId: tuiSessionId as string,
  });

  // Re-validate manifest-derived audit paths immediately before use to close
  // the TOCTOU window between manifest load and sink creation. Without this
  // a symlink swap after parseManifestAudit() could redirect writes outside
  // the manifest tree despite the load-time containment checks.
  // Only manifest paths are re-checked here — env-var paths are operator-supplied
  // and already outside the repo-authored trust boundary.
  if (manifestAudit !== undefined && process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1") {
    // Skip violations revalidation when governance is disabled: runtime-factory
    // ignores violationSqlitePath entirely in that case, so a post-load FS
    // change to that path cannot cause a real security issue and must not abort
    // the incident-mitigation path that --no-governance enables.
    const governanceEnabledForRevalidation = flags.governance.enabled;
    const auditPathsToRevalidate: ReadonlyArray<readonly [string | undefined, string]> = [
      [
        (process.env.KOI_AUDIT_NDJSON ?? "").length === 0 ? manifestAudit.ndjson : undefined,
        "manifest.audit.ndjson",
      ],
      [
        (process.env.KOI_AUDIT_SQLITE ?? "").length === 0 ? manifestAudit.sqlite : undefined,
        "manifest.audit.sqlite",
      ],
      [
        governanceEnabledForRevalidation && (process.env.KOI_AUDIT_VIOLATIONS ?? "").length === 0
          ? manifestAudit.violations
          : undefined,
        "manifest.audit.violations",
      ],
    ];
    for (const [resolvedPath, label] of auditPathsToRevalidate) {
      if (resolvedPath === undefined) continue;
      // Re-validate using full canonical containment (realpathSync on parent +
      // lstat on file), not just a direct lstat on the terminal parent.
      // This catches ancestor symlink swaps (e.g. logs/ → /external) that a
      // plain lstatSync(dirname(path)) misses by following the intermediate link.
      // manifestLoadPath is always defined here because manifestAudit is only
      // set when resolvedManifestPath !== undefined (same code block above).
      const violation = revalidateAuditPathContainment(resolvedPath, manifestLoadPath ?? "");
      if (violation !== undefined) {
        process.stderr.write(
          `koi tui: ${label}: filesystem changed after manifest validation — aborting: ${violation}.\n`,
        );
        process.exit(1);
      }
    }
  }

  const runtimeReady = createKoiRuntime({
    modelAdapter,
    modelName,
    approvalHandler: labeledApprovalHandler,
    approvalTimeoutMs: TUI_APPROVAL_TIMEOUT_MS,
    cwd: process.cwd(),
    systemPrompt,
    ...(yoloPermissionBackend !== undefined
      ? {
          permissionBackend: yoloPermissionBackend,
          permissionsDescription: "koi tui --yolo (auto-allow all tools)",
          bashElicitAutoApprove: true,
        }
      : {}),
    currentModelMiddleware,
    // Resolve budgetConfig per turn so a mid-session model switch picks up
    // the new model's context window immediately.
    getCurrentModel: () => ({
      model: currentModelBox.current,
      ...(currentModelBox.contextLength !== undefined
        ? { contextLength: currentModelBox.contextLength }
        : {}),
    }),
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
    skillsProgressive: true,
    mcpOAuthChannel: tuiOAuthChannel,
    ...(approvalStore !== undefined ? { persistentApprovals: approvalStore } : {}),
    ...(governance.enabled && (governance.maxSpendUsd ?? 0) > 0
      ? { maxSpendUsd: governance.maxSpendUsd }
      : {}),
    ...(governance.enabled && governance.maxTurns !== undefined
      ? { maxTurns: governance.maxTurns }
      : {}),
    ...(governance.enabled && governance.maxSpawnDepth !== undefined
      ? { maxSpawnDepth: governance.maxSpawnDepth }
      : {}),
    ...(governance.enabled && governance.alertThresholds !== undefined
      ? { governanceAlertThresholds: governance.alertThresholds }
      : {}),
    ...(governance.enabled && governanceRules !== undefined ? { governanceRules } : {}),
    ...(governance.enabled ? {} : { governanceDisabled: true }),
    // Fallback model chain validation only runs when the router actually
    // wired up. If router config validation failed above (modelRouterMiddleware
    // === undefined), fallback models are unreachable — passing them to
    // resolveCostConfig would refuse startup over models the runtime can't
    // ever call.
    ...(fallbackModels.length > 0 && modelRouterMiddleware !== undefined
      ? { fallbackModelNames: fallbackModels }
      : {}),
    // Manifest-driven opt-in for preset stacks + plugins. Omitted
    // when the user didn't pass --manifest, in which case the
    // factory defaults to activating every stack / every discovered
    // plugin (v1's "wire everything" posture).
    ...(manifestStacks !== undefined ? { stacks: manifestStacks } : {}),
    ...(manifestPlugins !== undefined ? { plugins: manifestPlugins } : {}),
    ...(manifestFilesystemOps !== undefined ? { filesystemOperations: manifestFilesystemOps } : {}),
    // Nexus backend (when resolved above) is passed through so the checkpoint
    // stack stamps the correct backend name and the restore protocol dispatches
    // compensating ops through the right backend. Omitted when undefined —
    // factory falls back to the default local backend rooted at cwd.
    ...(resolvedFilesystemBackend !== undefined ? { filesystem: resolvedFilesystemBackend } : {}),
    // @koi/artifacts tools — wired when the advisory lock was acquired at
    // boot. When construction failed (concurrent TUI, FS issue) the array
    // is empty and the artifact_* tools are simply absent from the agent.
    //
    // The mock browser provider (KOI_BROWSER_MOCK) is single-agent by
    // design: createBrowserProvider throws if a second distinct agent
    // tries to attach. This is safe here because extraProviders are only
    // assembled onto the root TUI agent — create-agent-spawn-fn.ts does
    // NOT propagate extraProviders into childProviders for spawned agents.
    // Limitation: browser_* tools are therefore NOT available in spawned
    // sub-agents. Workflows that delegate browser work to a child agent
    // will lose those tools after the spawn. This is a known scope
    // restriction of the mock dev/test path, not a bug in production.
    // Post-permissions slot: runs inside the security layers so request.tools
    // is permissions-filtered when the injector checks for the Skill tool.
    skillInjector: skillInjectorMw,
    // Propagate skill injection into spawned children so they receive the
    // <available_skills> XML block in progressive mode. Uses a filtered injector
    // that only includes runtimeBacked skills — body-backed skills (browser,
    // memory) belong to root-only providers not available in children.
    childSkillInjector: childSkillInjectorMw,
    extraProviders: [
      skillProvider,
      ...artifactExtraProviders,
      ...(process.env.KOI_BROWSER_MOCK === "1"
        ? [
            createBrowserProvider({
              backend: createMockDriver(),
              // Mock driver never opens a real connection, so SSRF
              // protection only needs to block IP literals and known
              // metadata hostnames — no DNS resolution required.
              // Note: BLOCKED_HOST_SUFFIXES includes .local/.internal,
              // so mDNS/RFC6762 names are still rejected by design.
              isUrlAllowed: (url) => {
                try {
                  const { protocol, hostname } = new URL(url);
                  if (protocol !== "http:" && protocol !== "https:") return false;
                  // Strip IPv6 brackets then lower-case + strip trailing DNS root
                  // dot so `localhost.` / `metadata.google.internal.` can't
                  // bypass suffix/host checks (same canonicalization as isSafeUrl).
                  const h = hostname
                    .replace(/^\[|\]$/g, "")
                    .toLowerCase()
                    .replace(/\.$/, "");
                  if (isBlockedIp(h)) return false;
                  if (BLOCKED_HOSTS.includes(h)) return false;
                  // h === s.slice(1) blocks bare apex hosts: "internal" matches ".internal",
                  // "local" matches ".local" — endsWith alone misses these.
                  if (BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s) || h === s.slice(1)))
                    return false;
                  return true;
                } catch {
                  return false;
                }
              },
            }),
          ]
        : []),
    ],
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
    // KOI_AUDIT_NDJSON=<path> opts into security-grade audit logging.
    // Manifest audit.ndjson is the fallback when the env var is absent.
    // Gated behind KOI_ALLOW_MANIFEST_FILE_SINKS=1 (repo-authored path).
    // Precedence: env var (present, even "") → manifest (gate required) → off.
    // Setting the env var to "" is an explicit disable that wins over manifest.
    ...(process.env.KOI_AUDIT_NDJSON !== undefined
      ? process.env.KOI_AUDIT_NDJSON !== ""
        ? { auditNdjsonPath: process.env.KOI_AUDIT_NDJSON }
        : {}
      : manifestAudit?.ndjson !== undefined && process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1"
        ? { auditNdjsonPath: manifestAudit.ndjson }
        : {}),
    // KOI_AUDIT_SQLITE=<path> opts into SQLite-backed audit logging.
    // Same precedence/disable semantics as KOI_AUDIT_NDJSON above.
    ...(process.env.KOI_AUDIT_SQLITE !== undefined
      ? process.env.KOI_AUDIT_SQLITE !== ""
        ? { auditSqlitePath: process.env.KOI_AUDIT_SQLITE }
        : {}
      : manifestAudit?.sqlite !== undefined && process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1"
        ? { auditSqlitePath: manifestAudit.sqlite }
        : {}),
    // KOI_AUDIT_VIOLATIONS=<path> overrides the violations DB path.
    // Manifest audit.violations is the fallback when the env var is absent.
    // Gated behind KOI_ALLOW_MANIFEST_FILE_SINKS=1 for manifest paths.
    // Precedence: env var (present, even "") → manifest (gate required) → default (~/.koi/violations.db).
    // Setting the env var to "" passes the empty string through — runtime-factory treats
    // length===0 as an explicit disable (no violations DB), preventing the default fallback.
    ...(process.env.KOI_AUDIT_VIOLATIONS !== undefined
      ? { violationSqlitePath: process.env.KOI_AUDIT_VIOLATIONS }
      : manifestAudit?.violations !== undefined && process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1"
        ? { violationSqlitePath: manifestAudit.violations }
        : {}),
    // KOI_AUDIT_NDJSON_MAX_BYTES=<n> enables size-based NDJSON log rotation.
    // KOI_AUDIT_NDJSON_DAILY=1 enables daily UTC rotation.
    ...(() => {
      const rawBytes = process.env.KOI_AUDIT_NDJSON_MAX_BYTES;
      const maxBytes = rawBytes !== undefined ? Number(rawBytes) : undefined;
      if (
        rawBytes !== undefined &&
        (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes <= 0)
      ) {
        console.warn(
          `[koi] KOI_AUDIT_NDJSON_MAX_BYTES="${rawBytes}" is not a positive number — NDJSON size rotation disabled`,
        );
      }
      const daily = process.env.KOI_AUDIT_NDJSON_DAILY === "1";
      const validMaxBytes = maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes > 0;
      if (validMaxBytes || daily) {
        return {
          auditNdjsonRotation: {
            ...(validMaxBytes ? { maxSizeBytes: maxBytes } : {}),
            ...(daily ? { daily: true as const } : {}),
          },
        };
      }
      return {};
    })(),
    // KOI_AUDIT_SQLITE_RETENTION_DAYS=<n> enables age-based SQLite audit pruning.
    ...(() => {
      const rawDays = process.env.KOI_AUDIT_SQLITE_RETENTION_DAYS;
      const days = rawDays !== undefined ? Number(rawDays) : undefined;
      if (rawDays !== undefined && (days === undefined || !Number.isFinite(days) || days <= 0)) {
        console.warn(
          `[koi] KOI_AUDIT_SQLITE_RETENTION_DAYS="${rawDays}" is not a positive number — SQLite retention disabled`,
        );
      }
      if (days !== undefined && Number.isFinite(days) && days > 0) {
        return { auditSqliteRetention: { maxAgeDays: days } };
      }
      return {};
    })(),
    // Per-sink manifest provenance: only pass the source path for sinks that
    // actually came from the manifest (not from operator env vars). This lets
    // createKoiRuntime run a final containment check immediately before each
    // manifest-derived sink open, without incorrectly revalidating env-var
    // sourced paths against the manifest directory.
    ...(process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1" &&
    process.env.KOI_AUDIT_NDJSON === undefined &&
    manifestAudit?.ndjson !== undefined &&
    manifestLoadPath !== undefined
      ? { manifestNdjsonSourcePath: manifestLoadPath }
      : {}),
    ...(process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1" &&
    process.env.KOI_AUDIT_SQLITE === undefined &&
    manifestAudit?.sqlite !== undefined &&
    manifestLoadPath !== undefined
      ? { manifestSqliteSourcePath: manifestLoadPath }
      : {}),
    ...(process.env.KOI_ALLOW_MANIFEST_FILE_SINKS === "1" &&
    process.env.KOI_AUDIT_VIOLATIONS === undefined &&
    manifestAudit?.violations !== undefined &&
    manifestLoadPath !== undefined
      ? { manifestViolationsSourcePath: manifestLoadPath }
      : {}),
    // KOI_REPORT_ENABLED=true opts into run-report middleware.
    // Wires @koi/middleware-report so a RunReport is printed at session end.
    ...(process.env.KOI_REPORT_ENABLED === "true" ? { reportEnabled: true } : {}),
    // KOI_PLANNING_ENABLED=true opts into @koi/middleware-planning.
    // Default off because plan state is ephemeral across resume until
    // durable persistence (#1842) lands. Hosts that accept the
    // limitation can opt in today.
    ...(process.env.KOI_PLANNING_ENABLED === "true" ? { planningEnabled: true } : {}),
    // KOI_FEEDBACK_LOOP_ENABLED=true opts into @koi/middleware-feedback-loop.
    // Activates model-response validation + tool-health tracking with an
    // empty config (observe-only, no validators, no quarantine thresholds).
    ...(process.env.KOI_FEEDBACK_LOOP_ENABLED === "true" ? { feedbackLoop: {} } : {}),
    extraMiddleware: [securityBridge.middleware],
    // Bridge spawn lifecycle events into the TUI store so /agents view and
    // inline spawn_call blocks reflect real spawn state. Each spawn call
    // produces one spawn_requested + one agent_status_changed event.
    onSpawnEvent: (event): void => {
      // Delegate to the current drain's spawn tracker for SIGINT grace.
      // Null between drains so cross-drain survivors from earlier turns cannot
      // influence the grace policy of a later, unrelated turn (#1999 r14).
      currentDrainSpawnHandler?.(event);
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
            // Pass metadata so the reducer can synthesize a record when
            // spawn_requested dispatch was lost (#1855).
            agentName: event.agentName,
            description: event.description,
          });
        }
      } catch (e: unknown) {
        console.warn("[koi:tui] onSpawnEvent dispatch failed — spawn UI may be stale", e);
      }
    },
  }).then(async (handle) => {
    // If an interim SIGUSR1 teardown started while createKoiRuntime was
    // in flight (#1906 R10), the teardown couldn't dispose `handle`
    // because it wasn't assigned yet. Dispose it here directly and do
    // NOT assign `runtimeHandle` — otherwise the rest of bootstrap
    // (transcript priming, /mcp refresh) would run against an
    // already-disposed runtime.
    if (shutdownStarted) {
      handle.shutdownBackgroundTasks();
      void handle.runtime.dispose().catch(() => {
        /* best effort — hard-exit failsafe will still fire */
      });
      return;
    }
    runtimeHandle = handle;
    // Resolve lazy skill agent ref so the injector middleware can query
    // skill components on every subsequent model call.
    skillAgentRef.current = handle.runtime.agent;
    // Seed the mutable live skill map from the ECS components attached during
    // createKoiRuntime. Subsequent session resets update liveSkillComponents via
    // reloadSkillComponents() without touching the static ECS.
    liveSkillComponents = handle.runtime.agent.query<SkillComponent>("skill:");
    // Wire governance bridge when the agent has a GovernanceController
    // component attached. In default sessions (no --max-spend or equivalent
    // future flag), component() returns undefined and the bridge stays unset,
    // leaving all governanceBridge?.xxx() call sites as no-ops.
    try {
      const governanceController = handle.runtime.agent.component<GovernanceController>(GOVERNANCE);
      // `--no-governance` / manifest disable wins here: even though the
      // engine's bundled GOVERNANCE component is still attached for
      // guard-level safety, the host-level observer surface (bridge, alerts
      // JSONL, toast reducer) must stay inert so operator intent is
      // honored end-to-end. Without this gate, disabling governance would
      // still fire toasts, persist alerts, and poll snapshots — a
      // fail-open.
      if (governanceController !== undefined && handle.governanceEnabled) {
        governanceBridge = createGovernanceBridge({
          store,
          controller: governanceController,
          sessionId: tuiSessionId as string,
          alertsPath: join(homedir(), ".koi", "governance-alerts.jsonl"),
          // Static rule snapshot resolved by runtime-factory via
          // backend.describeRules() — falls back to a synthetic default-allow
          // entry until the manifest YAML loader (#1877) wires real rules.
          rules: handle.governanceRules,
          // Resolved `--alert-threshold` / manifest thresholds. When both are
          // unset the bridge falls back to its observational default
          // ([0.5, 0.8, 0.95]); passing the resolved set here is what makes
          // CLI/manifest precedence authoritative for TUI toast firing.
          ...(handle.governanceAlertThresholds !== undefined
            ? { alertThresholds: handle.governanceAlertThresholds }
            : {}),
          ...(handle.violationStore !== undefined ? { violationStore: handle.violationStore } : {}),
          // Static capability mirror — matches the createGovernanceMiddleware's
          // describeCapabilities() output. Hardcoded here to avoid plumbing the
          // middleware instance back from runtime-factory just for one string.
          capabilities: [
            { label: "governance", description: "Policy gate + setpoint enforcement active" },
          ],
        });
        // Seed up to 10 most-recent alerts from JSONL so /governance
        // shows context across sessions instead of starting empty.
        // TODO(gov-9): replace per-alert dispatch with a `replay_persisted_alerts`
        // bulk action once seed counts grow past ~10 to avoid N reducer runs.
        const recent = governanceBridge.loadRecentAlerts(10);
        for (const alert of recent) {
          store.dispatch({ kind: "add_governance_alert", alert });
        }
        // Seed up to 10 most-recent persisted violations for the current
        // session so /governance's "Recent violations" panel is populated
        // on restart / resume. Load is async (SQLite) — fire-and-forget
        // so startup isn't blocked on history backfill.
        void governanceBridge
          .loadRecentViolations(10)
          .then((violations) => {
            // Synthesize UI-shape fields: id is per-entry counter, ts
            // is load-time (the ViolationStore row timestamp is not
            // exposed in the Violation shape — it would need an L0
            // widening to surface). Order is preserved from the DB.
            for (const v of violations) {
              store.dispatch({
                kind: "add_governance_violation",
                violation: {
                  id: `backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  ts: Date.now(),
                  variable: v.rule,
                  reason: v.message,
                },
              });
            }
          })
          .catch((err: unknown) => {
            console.warn("[tui-command] violation backfill failed:", err);
          });
        // Initial snapshot push so the view has data before the first turn.
        governanceBridge.pollSnapshot();
      }
    } catch (err: unknown) {
      console.warn("[tui-command] governance bridge init failed:", err);
    }
    // Manifest-driven supervision wiring (#1866). When the loaded manifest
    // declares `supervision:`, activate the subsystem here so the declared
    // children appear in the runtime's AgentRegistry and in the /agents
    // view. The returned handle is retained so shutdown can dispose it in
    // reverse construction order (see the SIGINT / system:quit chain
    // below). The helper is safe to call with `undefined` supervision —
    // it's skipped at the call site.
    if (manifestSupervision !== undefined) {
      try {
        const supHandle = await wireManifestSupervision({
          runtime: handle.runtime,
          supervisorManifestName: flags.manifest ?? "supervisor",
          supervision: manifestSupervision,
          onChange: (children) => {
            store.dispatch({ kind: "set_supervised_children", children });
          },
        });
        supervisionHandle = supHandle;
      } catch (err: unknown) {
        console.warn("[tui-command] supervision wiring failed:", err);
      }
    }
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
            // transport is now threaded through McpServerStatus from getMcpStatus(),
            // so startup refresh uses the same authoritative source as nav:mcp enrichment.
            status: computeLiveMcpStatus(l.failureCode, l.transport, l.hasOAuth),
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

    // Surface plugin status as inline TUI notice (#1728, #1887).
    // UI-only — not injected into the model transcript to avoid a trust
    // boundary issue (plugin descriptions are untrusted metadata).
    // Agent awareness comes through the /plugins view and startup log.
    //
    // #1887: suppress the banner on the happy path (plugins loaded cleanly,
    // no errors) — users who configured those plugins already know they
    // loaded, and `/plugins` is the canonical way to inspect them. Only
    // render when there are errors to surface, so failures are never
    // silent. Include the loaded list alongside errors for context.
    //
    // Plugin-derived strings are sanitized to strip ANSI escape sequences
    // and control characters before display.
    if (handle.pluginSummary.errors.length > 0) {
      // Strip ANSI escapes and control characters from untrusted plugin text.
      // Constructor form avoids `noControlCharactersInRegex` (hex escapes in
      // literal regex still trip the rule). The `useRegexLiterals` warning on
      // the next two lines is a false positive in that case.
      // biome-ignore lint/complexity/useRegexLiterals: constructor avoids noControlCharactersInRegex
      const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
      // biome-ignore lint/complexity/useRegexLiterals: constructor avoids noControlCharactersInRegex
      const CTRL_RE = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", "g");
      const sanitize = (s: string): string => s.replace(ANSI_RE, "").replace(CTRL_RE, "");

      const parts: string[] = [];
      if (handle.pluginSummary.loaded.length > 0) {
        const pluginLines = handle.pluginSummary.loaded
          .map((p) => `- ${sanitize(p.name)} v${sanitize(p.version)}`)
          .join("\n");
        parts.push(`[Loaded Plugins]\n${pluginLines}`);
      }
      const errorLines = handle.pluginSummary.errors
        .map((e) => `- ${sanitize(e.plugin)}: ${sanitize(e.error)}`)
        .join("\n");
      parts.push(`[Plugin Load Errors]\n${errorLines}`);

      // Route through `add_info` so the notice renders as a system block
      // rather than being attributed to "You:", and stays out of the
      // JSONL transcript + next-submit model context.
      store.dispatch({
        kind: "add_info",
        message: parts.join("\n\n"),
      });
    }

    return handle;
  });

  // let: set once after createTuiApp resolves, read in shutdown
  let appHandle: { readonly stop: () => Promise<void> } | null = null;
  // let: per-submit abort controller, replaced on each new stream
  let activeController: AbortController | null = null;
  // Session-level live-spawn tracker: agentIds whose spawn_requested has fired
  // but whose terminal agent_status_changed has not yet arrived. Updated directly
  // by onSpawnEvent (no per-drain delegate) so cross-drain children — a child
  // spawned by drain A that outlives the drain — remain visible to the
  // onWindowElapse grace probe. The engine's pre-start abort guard in
  // createSpawnExecutor prevents stale spawn_requested events from cancelled
  // turns from entering this set, so no per-drain scoping is needed (#1999 r12).
  // Per-drain live-spawn tracking for the SIGINT grace probe. A fresh Set is
  // created at each drain start and both references point to it. The delegate is
  // cleared to null at drain end so events that arrive BETWEEN drains are no-ops
  // — cross-drain survivors from earlier turns must NOT influence grace policy of
  // a later, unrelated turn (#1999 r14). The engine's pre-start abort guard
  // (createSpawnExecutor) prevents stale spawn_requested from polluting the set.
  let currentDrainSpawnIds: Set<string> = new Set<string>();
  let currentDrainSpawnHandler:
    | ((event: { readonly kind: string; readonly agentId: string }) => void)
    | null = null;
  // let: one-shot flag — true after the first double-tap window elapses with an
  // active spawn. Provides exactly one grace reset-to-idle to protect against the
  // accidental second Ctrl+C (#1999). Once used, stays true so subsequent windows
  // revert to stay-armed and the force-exit path remains reachable. Reset each drain.
  let spawnGraceUsed = false;
  // let: preflight latch — set synchronously at onSubmit entry before the
  // first await (runtimeReady / resetBarrier), cleared in finally. Closes
  // the submit-then-switch race where `activeController` is still null
  // during init waits, letting `onModelSwitch` observe the in-flight submit
  // before the stream controller exists.
  let submitInProgress = false;
  // let: compaction latch — `/compact` snapshots and splices the live
  // runtime transcript across `await` boundaries (token estimation +
  // microcompact). Must block `onSubmit` (and vice versa) for the full
  // compact duration, not just the entry check, otherwise a submit can
  // start after the initial guard and append messages that the splice
  // then silently drops or duplicates.
  let compactInProgress = false;
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

  // --- Governance bridge: wire @koi/governance-core controller into TUI ---
  // Conditional: only created when the host has a GovernanceController
  // attached to the agent. In default sessions (no governance flags), the
  // bridge is undefined and all governanceBridge?.xxx() call sites no-op.
  // Future work (e.g. --max-spend CLI flag) will instantiate a controller
  // and the bridge will start surfacing alerts in /governance.
  // (Declaration moved before runtimeReady — see comment there for why.)

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
  // let: justified — one-shot latch so repeated Ctrl+C during in-flight
  // force teardown doesn't spawn overlapping dispose/shutdown sequences.
  let forceStarted = false;
  const sigintHandler = createTuiSigintHandler({
    hasActiveForegroundStream: () => activeController !== null,
    hasActiveBackgroundTasks: () => runtimeHandle?.hasActiveBackgroundTasks() ?? false,
    abortActiveStream,
    onShutdown: () => {
      void shutdown(130);
    },
    onForce: () => {
      // One-shot: subsequent force signals during in-flight teardown
      // are no-ops. The first force call has its own hard-exit timer
      // and SIGKILL escalation wait — re-entering would spawn
      // overlapping dispose sequences. We do NOT process.exit()
      // immediately here because that would cancel the SIGKILL
      // escalation window and orphan SIGTERM-resistant subprocesses.
      if (forceStarted) return;
      forceStarted = true;
      // Force path: abort the active foreground stream FIRST so no
      // further model/tool work can execute during the exit window,
      // then kick background-task SIGTERM so subprocesses start dying.
      // Without the foreground abort, side-effecting tools could keep
      // running for the full SIGKILL-escalation wait below.
      abortActiveStream();
      // Commit exit code immediately so even a natural event-loop drain
      // (e.g. all ref'd handles gone before dispose settles) reports an
      // interrupt exit status to the shell / parent process.
      process.exitCode = 130;
      // SIGTERM background subprocesses BEFORE dispose so the SIGKILL
      // escalation timers start early. If dispose wedges and the hard-
      // exit timer fires, subprocesses have already received SIGTERM
      // (and possibly SIGKILL). Without this ordering, a wedged dispose
      // would let the hard-exit fire before subprocesses are ever
      // signalled — orphaning them.
      const liveTasks = runtimeHandle?.shutdownBackgroundTasks() ?? false;
      // #1862: call runtime.dispose() so onSessionEnd fires on ALL
      // middleware (report, audit, etc.) before the process exits.
      // Best-effort only — force-quit must always terminate, so a
      // ref'd hard-exit failsafe caps the dispose window at 4s (enough
      // for onSessionEnd hooks but short enough to feel responsive).
      // The timer stays ref'd to guarantee exit even if all other
      // handles are gone.
      // Total budget for the entire force-quit sequence. Worst case:
      // dispose internal timeout (5s) + SIGKILL wait (3.5s) + retry
      // dispose (5s) = ~13.5s. 15s gives the retry room to complete
      // while still guaranteeing termination. The timer stays ref'd
      // and is only cleared immediately before process.exit so there
      // is always a guaranteed escape path.
      const FORCE_HARD_EXIT_MS = 15_000;
      const forceDispose = async (): Promise<void> => {
        const hardExit = setTimeout(() => process.exit(130), FORCE_HARD_EXIT_MS);
        try {
          await supervisionHandle?.dispose();
        } catch {
          // Best-effort — must not block force-quit.
        }
        try {
          await runtimeHandle?.runtime.dispose();
        } catch (disposeErr: unknown) {
          // Log but don't block — force-quit must always terminate.
          try {
            process.stderr.write(
              `[koi tui] force-quit dispose failed: ${
                disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
              }\n`,
            );
          } catch {
            /* stderr unwritable — best effort */
          }
        }
        if (liveTasks) {
          // Wait long enough for the runtime's SIGKILL escalation window
          // (SIGKILL_ESCALATION_MS = 3000ms in tui-runtime / bash exec)
          // to fire before this process — and its in-process escalation
          // timer — dies. Exiting earlier orphans subprocesses that
          // ignore SIGTERM, exactly the failure mode "force" is supposed
          // to handle.
          await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
          // Retry dispose after SIGKILL escalation — the runtime contract
          // expects callers to retry after the wedged child has been killed.
          // If the first dispose failed (poisoned runtime), this retry can
          // succeed now that the subprocess is dead.
          try {
            await runtimeHandle?.runtime.dispose();
          } catch {
            // Best-effort — exit regardless.
          }
        }
        clearTimeout(hardExit);
        process.exit(130);
      };
      void forceDispose();
    },
    write: (msg: string) => {
      process.stderr.write(msg);
    },
    // #1912: route SIGINT hints through the toast surface (transient, keyed,
    // auto-dismiss) instead of raw stderr or add_info. Raw stderr writes during
    // an active OpenTUI frame cause row duplication and character-level overlay;
    // add_info would pollute conversation history with stale control-flow banners.
    onInterruptHint: (_msg: string) => {
      store.dispatch({
        kind: "add_toast",
        toast: {
          id: `sigint-interrupt-${Date.now()}`,
          kind: "info",
          key: "sigint:interrupt",
          title: "Interrupting…",
          body: "Ctrl+C again to force",
          ts: Date.now(),
          autoDismissMs: TUI_DOUBLE_TAP_WINDOW_MS,
        },
      });
    },
    onBgExitHint: (_msg: string) => {
      store.dispatch({
        kind: "add_toast",
        toast: {
          id: `sigint-bg-exit-${Date.now()}`,
          kind: "warn",
          key: "sigint:bg-exit",
          title: "Background tasks still running",
          body: "Press Ctrl+C again to exit (background tasks will be terminated).",
          ts: Date.now(),
          autoDismissMs: TUI_DOUBLE_TAP_WINDOW_MS,
        },
      });
    },
    doubleTapWindowMs: TUI_DOUBLE_TAP_WINDOW_MS,
    coalesceWindowMs: TUI_COALESCE_WINDOW_MS,
    setTimer: createUnrefTimer,
    // #1999: one-shot grace period for spawns that outlive the double-tap window.
    // When the CURRENT drain's child is still running 2s after Ctrl+C, a second
    // tap is likely not intentional — reset to idle so it becomes a fresh cancel
    // instead of a force-exit. Only children from THIS drain's set are consulted
    // (currentDrainSpawnIds), so survivors from unrelated earlier turns cannot
    // grant grace for the current interrupted turn. Grace is one-shot per drain
    // (spawnGraceUsed): once used, subsequent windows revert to stay-armed so
    // the force-exit path remains reachable for truly stuck spawns.
    onWindowElapse: (): "stay-armed" | "reset-to-idle" => {
      if (currentDrainSpawnIds.size > 0 && !spawnGraceUsed) {
        spawnGraceUsed = true;
        return "reset-to-idle";
      }
      return "stay-armed";
    },
  });
  // Shared entry point: in-app Ctrl+C (via createTuiApp's `onInterrupt`
  // prop) and the `agent:interrupt` command both route through here.
  const onInterrupt = (): void => {
    if (activeController !== null || store.getState().queuedSubmits.length > 0) {
      submitQueue.clear();
    }
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

  // #1884: separate from `postClearTurnCount` which is gated on
  // `rewindBoundaryActive` (only armed on --resume, /clear, /new). A
  // fresh launch never arms it, so `postClearTurnCount` stays 0 even
  // after many successful turns — unsuitable for detecting "did any
  // turn produce a transcript this process". Track that explicitly
  // here so the post-quit resume hint only suppresses when truly
  // nothing was written to disk.
  // let: justified — set on the first settled (non-aborted) turn.
  let anyTurnPersistedThisProcess = false;

  // #1884: true once the in-app session picker (`onSessionSelect`) has
  // successfully rebound `tuiSessionId` to an already-persisted session.
  // That transcript exists on disk independent of startup `--resume` and
  // of any new turns — its id must still print as a resume hint even
  // when the user picks it and quits without submitting.
  // let: justified — set on successful picker rebind.
  let pickedExistingSession = false;

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

    // Drop the per-drain spawn delegate and reset the grace flag so the
    // new session starts with a clean SIGINT state (#1999).
    currentDrainSpawnHandler = null;
    currentDrainSpawnIds = new Set<string>();
    spawnGraceUsed = false;

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
        // Refresh the live skill component map for the new session.
        // reloadSkillComponents() clears pinned bodies (evicting base LRU entries),
        // re-runs loadAll() to pick up edits/deletions, and returns a map of all
        // skills-runtime entries (progressive file-based + currently-live MCP).
        // Non-fatal: if reload fails, liveSkillComponents retains previous state.
        try {
          const fresh = await reloadSkillComponents();
          const realSkills = skillAgentRef.current?.query<SkillComponent>("skill:") ?? new Map();
          // Seed from fresh (authoritative for progressive and MCP skills).
          // Then restore non-runtimeBacked, non-mcpBacked skills from realSkills —
          // those are body-backed root skills (e.g. browser, memory) from providers
          // that are unaffected by reset. They override any same-token entry in fresh
          // to preserve the original ECS assembly precedence (first-writer-wins:
          // root providers attach before skills-runtime). Removed MCP skills are
          // excluded by the mcpBacked marker that was set at attach time.
          const merged = new Map<SubsystemToken<SkillComponent>, SkillComponent>(fresh);
          for (const [token, comp] of realSkills) {
            const c = comp as { runtimeBacked?: boolean; mcpBacked?: boolean };
            if (!c.runtimeBacked && !c.mcpBacked) {
              merged.set(token, comp);
            }
          }
          liveSkillComponents = merged;
        } catch (skillReloadErr) {
          // reload() throws on discovery failure and restores the previous pinned snapshot.
          // Preserve the current liveSkillComponents — the catalog stays consistent with
          // what the Skill tool can serve. Surface a visible error so the user knows
          // their skill inventory may reflect the previous session.
          console.error(
            "[skills] Session reset: skill catalog refresh failed, retaining previous inventory.",
            skillReloadErr,
          );
          if (myGeneration === resetGeneration) {
            store.dispatch({
              kind: "add_error",
              code: "SKILL_RELOAD_FAILED",
              message: `Skill catalog refresh failed — ${skillReloadErr instanceof Error ? skillReloadErr.message : String(skillReloadErr)}. Skills from the previous session may still be shown.`,
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
  // `shutdownStarted` is hoisted to the pre-createKoiRuntime block so
  // interim SIGUSR1 teardown and this full shutdown share one latch
  // (#1906 R4 review).
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
    // #1862: dispose the runtime BEFORE appHandle.stop(). After stop(),
    // Bun's event loop drops pending microtasks when the last "real"
    // handle goes away — even with our ref'd setInterval keepalive.
    // Awaiting dispose() here, while the renderer is still alive,
    // ensures onSessionEnd hooks (report MW, audit MW) complete before
    // the event loop collapses. The resume hint prints after stop()
    // releases the alt screen, so it is not affected.
    if (runtimeHandle !== null) {
      // Only pay the SIGTERM→SIGKILL escalation wait when we actually
      // had live subprocesses to drain. Idle exits stay immediate.
      // SIGKILL_ESCALATION_MS = 3000 in the runtime.
      if (hadLiveTasks) {
        await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
      }
      // Dispose manifest-declared supervision before the runtime itself so
      // the reconcile runner/process tree can observe a live registry during
      // their own teardown.
      try {
        await supervisionHandle?.dispose();
      } catch (disposeErr) {
        process.stderr.write(
          `[koi tui] supervision dispose failed during shutdown: ${
            disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
          }\n`,
        );
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
    // Governance bridge dispose is a no-op (sync, no open handles), but
    // calling it here keeps the pattern symmetric with future bridges that
    // may hold timers or open file handles.
    governanceBridge?.dispose();
    securityBridge.dispose();
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
          const decision = decideResumeHint({
            clearPersistFailed,
            clearedThisProcess,
            resumedFromFlag: flags.resume !== undefined,
            pickedExistingSession,
            postClearTurnCount,
            anyTurnPersistedThisProcess,
            tuiSessionId,
            viewedSessionId,
          });
          switch (decision.kind) {
            case "clear-persist-failed":
              writeSync(
                2,
                "koi tui: session clear did not persist — NOT printing a resume hint.\n",
              );
              break;
            case "cleared-empty":
              writeSync(2, "koi tui: session was cleared — no resume hint to print.\n");
              break;
            case "never-persisted":
              // #1884: silent — no JSONL on disk, nothing to advertise.
              break;
            case "normal":
              writeSync(1, formatResumeHint(tuiSessionId));
              break;
            case "picker":
              writeSync(1, formatPickerModeResumeHint(tuiSessionId, viewedSessionId));
              break;
          }
        } catch {
          // stdout may be closed during abnormal teardown — swallow.
        }
      }
      // #1862: print the buffered run-report after the alt screen is
      // released so it is visible on the user's terminal. The report
      // was captured by onReport during runtime.dispose() → onSessionEnd
      // which runs before appHandle.stop().
      if (runtimeHandle !== null) {
        const reportText = runtimeHandle.getPendingReport();
        if (reportText !== undefined) {
          try {
            writeSync(2, `[run-report] ${reportText}\n`);
          } catch {
            /* stderr unwritable — best effort */
          }
        }
      }
      batcher.dispose();
      approvalStore?.close();
      // Dispose auth notification handler synchronously first so late
      // channel.send() callbacks queued before transport unsubscribe
      // short-circuit on the active flag.
      try {
        tuiAuthNotificationHandler?.dispose();
      } catch {
        /* best effort */
      }
      // Dispose nexus filesystem backend (closes bridge subprocess + unsubscribes).
      // Must run after runtimeHandle.runtime.dispose() so in-flight tool calls
      // complete before the transport is closed.
      await resolvedFilesystemBackend?.dispose?.();
      // Close the artifact store (release advisory lock, close SQLite handle).
      // dispose() is host-owned per @koi/runtime contract.
      if (artifactStore !== undefined) {
        try {
          await artifactStore.close();
        } catch (err) {
          process.stderr.write(
            `[koi tui] artifact store close failed: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      }
    } finally {
      clearInterval(shutdownKeepAlive);
      // Flush OTel spans before process exit
      await otelHandle?.shutdown();
      process.exit(exitCode);
    }
  };

  // ---------------------------------------------------------------------------
  // 4b. Upgrade SIGUSR1 to the FULL graceful-shutdown handler (#1906 R10/R11)
  // ---------------------------------------------------------------------------
  //
  // Progressive handler upgrade:
  //   1. bin.ts inline early handler: bare `process.exit()` (process-start → runTuiCommand entry).
  //   2. interim teardown handler: tears down what exists so far — runtime,
  //      filesystem backend, otel, approvals, batcher — but cannot touch
  //      appHandle, resetBarrier, abortActiveStream because they are not
  //      declared yet. Installed right before createKoiRuntime.
  //   3. Full handler (THIS section): routes into `shutdown()` which adds
  //      abortActiveStream, resetBarrier wait, appHandle.stop, run-report,
  //      resume hint, SIGKILL-escalation wait.
  //
  // Swap the interim handler out by reference so an embedding host's own
  // SIGUSR1 listeners (if any) are not trampled. The interim teardown is
  // no-longer reachable from here; the full handler supersedes it.
  const onProcessSigusr1 = createSigusr1Handler({
    shutdown: (code, reason) => {
      void shutdown(code, reason);
    },
    write: (msg) => {
      process.stderr.write(msg);
    },
  });
  if (SIGUSR1_SUPPORTED && !shutdownStarted) {
    // Skip the upgrade if the interim teardown is already in flight —
    // installing the full handler now would let a fresh SIGUSR1 enter
    // `shutdown()` concurrently with the interim teardown. The shared
    // `shutdownStarted` latch makes `shutdown()` a no-op in that case,
    // but there is no reason to wire up the listener at all.
    if (interimSigusr1Handler !== null) {
      process.removeListener("SIGUSR1", interimSigusr1Handler);
      interimSigusr1Handler = null;
    }
    process.on("SIGUSR1", onProcessSigusr1);
  }

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

  const processSubmit = async (text: string): Promise<void> => {
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
    // Guard against overlapping submits: reject while a stream is in flight
    // OR while a prior submit is still in its preflight (runtimeReady /
    // resetBarrier) window — activeController is null during that window,
    // so `submitInProgress` is the authoritative in-flight signal.
    // Also reject during `/compact` so the splice doesn't race with
    // session-transcript appends from this submit.
    // The user can Ctrl+C (agent:interrupt) to abort the active stream first.
    if (activeController !== null || submitInProgress) {
      store.dispatch({
        kind: "add_error",
        code: "SUBMIT_IN_PROGRESS",
        message: "A response is already streaming. Press Ctrl+C to interrupt it first.",
      });
      return;
    }
    if (compactInProgress) {
      store.dispatch({
        kind: "add_error",
        code: "SUBMIT_DURING_COMPACT",
        message: "Cannot submit while /compact is in progress. Try again in a moment.",
      });
      return;
    }
    // Take the preflight latch synchronously — before the first await — so
    // `onModelSwitch` (and any re-entrant submit) can observe the in-flight
    // state during runtime init / barrier waits. Cleared in the outer
    // finally so early-return guards below also release the latch.
    submitInProgress = true;
    // Capture the reset generation synchronously so we can detect a
    // `/clear` or `/new` (or any other `resetConversation()`) that lands
    // during the preflight window. If the generation advances before we
    // create the stream, abandon this submit — otherwise the captured
    // `text` would execute AFTER the user's reset intent. `resetBarrier`
    // alone is insufficient: a reset could complete between our await
    // and stream creation without us noticing.
    const submitResetGen = resetGeneration;
    try {
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
      // Bail if a reset (e.g. `/clear`, `/new`) landed during runtime
      // initialization. The submit was implicitly invalidated.
      if (resetGeneration !== submitResetGen) return;
      const handle = runtimeHandle;

      // Wait for any pending session reset to complete before submitting.
      // Prevents hitting stale task board or trajectory state.
      await resetBarrier;
      // Bail if a reset landed while we waited on the barrier (the barrier
      // itself only signals completion, not invalidation of queued prompts).
      if (resetGeneration !== submitResetGen) return;

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
        // Task 11: check OAuth redirect URL interceptor before passing to engine.
        // When a nexus local-bridge transport is wired and the user pastes a
        // localhost redirect URL (e.g. http://localhost:8080/callback?code=...),
        // the interceptor routes it to `transport.submitAuthCode(...)` and
        // returns `{ intercepted: true }` so the text never reaches the model.
        if (tuiAuthInterceptor !== undefined) {
          const interceptResult = tuiAuthInterceptor(text, tuiAuthCorrelationId);
          if (interceptResult.intercepted) {
            // Show a brief notice so the user knows the URL was consumed.
            store.dispatch({
              kind: "add_user_message",
              id: `auth-redirect-${Date.now()}`,
              blocks: [
                {
                  kind: "text",
                  text: "_OAuth redirect URL received — submitting to auth bridge..._",
                },
              ],
            });
            activeController = null;
            return;
          }
        }

        // #10: resolve @-mention file references before sending to the engine.
        // Parses @path and @path#L10-20, reads files, injects content so the
        // model sees the file directly without needing to call Glob/fs_read.
        const resolved = resolveAtReferences(text, process.cwd());

        // Warn for each binary @-reference. Do NOT strip the @-token from the
        // model prompt: keeping the original text lets the model recover via tools
        // (fs_read, glob) since multimodal block attachment is not yet wired.
        // Only text injections produce cleanText-based output.
        if (resolved.binaryInjections.length > 0) {
          for (const b of resolved.binaryInjections) {
            store.dispatch({
              kind: "add_info",
              message: `@${b.filePath} (${b.mimeType}) — binary file; multimodal attachment not yet supported. The model will see the reference and may use tools to read it.`,
            });
          }
        }

        // Use formatAtReferencesForModel (cleanText + injected content) only when
        // text refs were actually resolved. Otherwise send the original text so
        // the model sees @-references and can attempt its own resolution via tools.
        // When BOTH text and binary refs are present, formatAtReferencesForModel
        // uses cleanText which strips ALL @-tokens — append a note so the model
        // knows binary refs exist and can access them via tools.
        let modelText: string;
        if (resolved.injections.length > 0) {
          modelText = formatAtReferencesForModel(resolved);
          if (resolved.binaryInjections.length > 0) {
            const binaryRefs = resolved.binaryInjections
              .map((b) => (b.filePath.includes(" ") ? `@"${b.filePath}"` : `@${b.filePath}`))
              .join(", ");
            modelText += `\n\n[Binary files referenced but not attached — use tools to access: ${binaryRefs}]`;
          }
        } else {
          modelText = text;
        }

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
        // Snapshot the active model at turn-start for per-turn cost
        // attribution. If the user switches mid-turn via the picker, the
        // bridge's live `modelName` would race with the HTTP call that's
        // still in flight; pin to this value for this turn's recording.
        //
        // Under `KOI_FALLBACK_MODEL` routing, `request.model` is rewritten
        // per target inside the router middleware, so the actually-served
        // model may differ from `currentModelBox.current`. We don't yet
        // plumb the router's selected target back through the engine
        // events, so attribute fallback-routed turns to a distinct bucket
        // ("<fallback-chain>") for display. Price lookup, however, MUST
        // use a real model id — the synthetic bucket has no pricing entry
        // and would silently zero out the estimate. Use the primary
        // (startup) model id as the pricing proxy until true per-target
        // attribution is plumbed through.
        const fallbackActive = fallbackModels.length > 0;
        const modelAtTurnStart = fallbackActive ? "<fallback-chain>" : currentModelBox.current;
        const pricingModelAtTurnStart = fallbackActive ? currentModelBox.current : undefined;
        // Install per-drain spawn tracking for the SIGINT grace probe.
        // Fresh set each drain so only THIS turn's spawns are counted.
        // Grace is one-shot: reset here since each drain is a new turn.
        const drainSpawnIds = new Set<string>();
        currentDrainSpawnIds = drainSpawnIds;
        currentDrainSpawnHandler = (event): void => {
          if (event.kind === "spawn_requested") {
            drainSpawnIds.add(event.agentId);
          } else {
            drainSpawnIds.delete(event.agentId);
          }
        };
        spawnGraceUsed = false;
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
        // #1884: unconditional "this process wrote something" marker.
        // Set on every settled, uninterrupted turn — not gated on the
        // rewind boundary — so the post-quit hint suppression knows
        // whether a JSONL transcript was actually produced.
        if (drainOutcome === "settled" && !controller.signal.aborted) {
          anyTurnPersistedThisProcess = true;
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
            modelName: modelAtTurnStart,
            ...(pricingModelAtTurnStart !== undefined
              ? { pricingModel: pricingModelAtTurnStart }
              : {}),
          });
        }
        // Refresh governance snapshot on EVERY settled turn — not only
        // on token-producing turns. Early policy rejections, adapter
        // usage gaps, and tool-only/degraded paths all close turns
        // with zero token delta; the governance variables (turn_count,
        // error_rate, duration_ms, spawn_count) still advance, and
        // `/governance` + the status chip must not show stale values
        // exactly when an operator needs them.
        governanceBridge?.pollSnapshot();
        securityBridge.nextTurn();

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
        // The active run has settled. Clear the interrupt-time spawn snapshot
        // so the next turn starts fresh (no stale snapshot from a completed
        // interrupt sequence). Then reset the double-tap window so a later
        // Ctrl+C is treated as a fresh first tap rather than a late-arriving
        // second tap of a cancellation that already completed.
        // Both guarded: stale finally from a reset-and-replaced run must not
        // disarm SIGINT state belonging to a newer turn.
        if (isStillActive) {
          // Drop the per-drain spawn delegate so events arriving between drains
          // (after this finally and before the next drain's start) are no-ops.
          currentDrainSpawnHandler = null;
          currentDrainSpawnIds = new Set<string>(); // empty sentinel between drains
          sigintHandler.complete();
        }
      }
    } finally {
      // Always release the preflight latch so a subsequent submit is
      // accepted. Runs for both the happy-path stream completion and
      // every early-return guard (runtime init failure, clear/reset
      // failure, picker mode, etc.) between `submitInProgress = true`
      // and this finally.
      submitInProgress = false;
    }
  };

  const submitQueue = createForegroundSubmitQueue(
    {
      run: processSubmit,
      interrupt: async () => {
        if (activeController !== null || store.getState().queuedSubmits.length > 0) {
          submitQueue.clear();
        }
        abortActiveStream();
        const inflightRun = activeRunPromise;
        if (inflightRun !== null) {
          try {
            await inflightRun;
          } catch {
            /* already surfaced via store */
          }
        }
      },
    },
    {
      onEnqueue: (text) => {
        store.dispatch({ kind: "enqueue_submit", text });
      },
      onDequeue: () => {
        store.dispatch({ kind: "dequeue_submit" });
      },
      onClear: () => {
        store.dispatch({ kind: "clear_submit_queue" });
      },
    },
  );

  const submitText = async (text: string, mode: "queue" | "interrupt" = "queue"): Promise<void> => {
    if (mode === "interrupt") {
      await submitQueue.interruptAndSubmit(text);
      return;
    }
    await submitQueue.submit(text);
  };

  // If an interim SIGUSR1 teardown already flipped the shutdown latch
  // during bootstrap, do not create the TUI app or start the renderer
  // (#1906 R5). The interim teardown + hard-exit failsafe will terminate
  // the process shortly; creating the TUI would just allocate more state
  // for the teardown to race.
  if (shutdownStarted) {
    // Wait for the interim teardown's hard-exit failsafe (6s) to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, INTERIM_SHUTDOWN_HARD_EXIT_MS + 500));
    // If for some reason we're still alive (teardown wedged, failsafe
    // didn't fire), fall through to process.exit as a last resort.
    process.exit(SIGUSR1_EXIT_CODE);
  }

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
                      status: computeLiveMcpStatus(l.failureCode, l.transport, l.hasOAuth),
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
                // Derive transport/OAuth from the freshly-loaded config file so
                // that in-session edits (e.g. adding an oauth block) are reflected
                // immediately. nav:mcp-auth reads the same config.value, so the
                // status and the auth action stay consistent. Live data
                // (failureCode, toolCount) still comes from the runtime.
                const configTransportByName = new Map<string, "http" | "stdio" | "sse">(
                  config.value.servers.map((s) => [s.name, s.kind]),
                );
                const configOAuthByName = new Set<string>(
                  config.value.servers
                    .filter((s) => s.kind === "http" && s.oauth !== undefined)
                    .map((s) => s.name),
                );
                // Enrich config-based entries with live data (match by bare name).
                const enriched: import("@koi/tui").McpServerInfo[] = servers.map((entry) => {
                  const l = liveUserMap.get(entry.name);
                  if (l === undefined) return entry;
                  return {
                    name: entry.name,
                    status: computeLiveMcpStatus(
                      l.failureCode,
                      configTransportByName.get(entry.name),
                      configOAuthByName.has(entry.name),
                    ),
                    toolCount: l.toolCount,
                    detail: l.failureMessage ?? entry.detail,
                  };
                });
                // Append plugin-provided servers (source-prefixed) not in .mcp.json.
                for (const l of liveOther) {
                  enriched.push({
                    name: l.name,
                    status: computeLiveMcpStatus(l.failureCode, l.transport, l.hasOAuth),
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
          // Delegates to runtimeHandle.triggerMcpServerAuth which reuses the live
          // OAuthAuthProvider wired into the existing MCP connection, ensuring
          // in-memory token caches are cleared before startAuthFlow() is called.
          // Pass the raw qualified name (e.g. "plugin:foo") so triggerMcpServerAuth
          // can route to the correct source map and avoid cross-source collisions.
          void (async (): Promise<void> => {
            const rawName = args.trim();
            if (rawName === "") return;
            // Use the qualified name as the dedup key so user:foo and plugin:foo
            // can be authed concurrently without blocking each other.
            if (mcpAuthInFlight.has(rawName)) return;
            mcpAuthInFlight.add(rawName);
            try {
              if (runtimeHandle === null) return;
              const authOutcome = await runtimeHandle.triggerMcpServerAuth(
                rawName,
                tuiOAuthChannel,
              );
              if (authOutcome === "success-reload-required") {
                // Auth succeeded in storage but this session's resolver doesn't
                // know about the server — guide the user to reload rather than
                // showing a failure or a stale status refresh.
                store.dispatch({
                  kind: "add_info",
                  message: `Authorization for "${rawName}" succeeded. Reload the session to connect.`,
                });
              } else if (authOutcome === "success-live") {
                // Tokens are now stored. getMcpStatus() calls resolver.discover()
                // → listTools() → ensureConnected(): from auth-needed state,
                // ensureConnected() calls connect() which fetches fresh tokens
                // from storage — the live connection reconnects without restart.
                const live = await runtimeHandle.getMcpStatus();
                store.dispatch({
                  kind: "set_mcp_status",
                  servers: live.map((l) => ({
                    name: l.name,
                    status: computeLiveMcpStatus(l.failureCode, l.transport, l.hasOAuth),
                    toolCount: l.toolCount,
                    detail: l.failureMessage,
                  })),
                });
              } else {
                store.dispatch({
                  kind: "add_error",
                  code: "MCP_AUTH",
                  message: `Authentication failed for "${rawName}". Try: koi mcp auth ${rawName}`,
                });
              }
            } catch (e: unknown) {
              store.dispatch({
                kind: "add_error",
                code: "MCP_AUTH",
                message: `Auth error: ${e instanceof Error ? e.message : String(e)}`,
              });
            } finally {
              mcpAuthInFlight.delete(rawName);
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
            costBridge.setSession(newSid as string, currentModelBox.current, provider);
            governanceBridge?.setSession(newSid as string);
            securityBridge.setSession(newSid as string);
            store.dispatch({
              kind: "set_session_info",
              modelName: currentModelBox.current,
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
          const lines = [`Model: ${currentModelBox.current}`, `Provider: ${provider}`];
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
            // Refuse compaction while a submit is in flight or in its
            // preflight window. `microcompact` snapshots + splices the
            // runtime transcript, and the session-transcript middleware
            // may append the in-flight turn's messages concurrently —
            // running compact against that live buffer can drop or
            // duplicate messages and desync the next turn's context.
            // `submitInProgress` covers runtimeReady/resetBarrier;
            // `activeController` covers the stream itself.
            if (activeController !== null || submitInProgress || compactInProgress) {
              store.dispatch({
                kind: "add_error",
                code: "COMPACT_IN_FLIGHT_TURN",
                message:
                  "Cannot /compact while a turn is in flight. Press Ctrl+C to " +
                  "interrupt the active stream first, then try /compact again.",
              });
              return;
            }
            // Take the compact latch synchronously so a submit that
            // arrives during our `await` boundaries (token estimation +
            // microcompact) is rejected until we release it in `finally`.
            compactInProgress = true;
            // Capture the reset generation synchronously. If `/clear`,
            // `/new`, a session switch, or a rewind lands between the
            // snapshot below and the splice, the pre-reset messages we
            // snapshotted would be written back over the user's cleared
            // transcript, resurrecting context they explicitly dropped.
            // Re-check before splicing and bail on mismatch.
            const compactResetGen = resetGeneration;
            try {
              // Snapshot current transcript. microcompact is pure — we splice the
              // result back into runtimeHandle.transcript below. The guards above
              // plus the `compactInProgress` latch ensure no concurrent writer
              // runs for the full compact duration, so the snapshot is consistent.
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
                // Read live model from the middleware box so /compact after a
                // model switch estimates against the currently-active model.
                currentModelBox.current,
              );
              if (result.strategy === "noop") {
                dispatchNotice(
                  store,
                  "compact-info",
                  `[Compact: already compact (${result.compactedTokens} tokens)]`,
                );
                return;
              }
              // Re-check the in-flight guards immediately before mutating
              // the transcript. `compactInProgress` blocks new submits, but
              // belt-and-suspenders: if somehow the state changed, bail
              // without splicing rather than corrupt the live buffer.
              if (activeController !== null || submitInProgress) {
                dispatchNotice(
                  store,
                  "compact-info",
                  "[Compact: aborted — a turn started mid-compaction]",
                );
                return;
              }
              // Reset-generation check: if `/clear`, `/new`, a session
              // switch, or a rewind landed between our snapshot and this
              // splice, writing `result.messages` back would resurrect
              // pre-reset content the user explicitly cleared. Bail.
              if (resetGeneration !== compactResetGen) {
                dispatchNotice(
                  store,
                  "compact-info",
                  "[Compact: aborted — session was reset mid-compaction]",
                );
                return;
              }
              runtimeHandle.transcript.splice(
                0,
                runtimeHandle.transcript.length,
                ...result.messages,
              );
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
            } finally {
              compactInProgress = false;
            }
          })();
          break;
        case "agent:summarize":
          void (async (): Promise<void> => {
            if (runtimeHandle === null) {
              store.dispatch({
                kind: "add_error",
                code: "SUMMARIZE_RUNTIME_NOT_READY",
                message: "Runtime is still initializing — try again in a moment.",
              });
              return;
            }
            const snapshot: readonly InboundMessage[] = [...runtimeHandle.transcript];
            if (snapshot.length === 0) {
              dispatchNotice(store, "summarize-info", "[Summarize: conversation is empty]");
              return;
            }
            const entries = snapshot.map((m, i) => ({
              id: `t${i}` as TranscriptEntryId,
              role: inferRole(m.senderId),
              content: flattenContentBlocks(m.content),
              timestamp: m.timestamp,
            }));
            const activeSessionId = sessionId(runtimeHandle.runtime.sessionId);
            // Read-only adapter over the in-memory transcript. summarizeSession
            // only calls load(); the other methods are stubs required by the
            // SessionTranscript contract but never invoked on this path.
            const transcript = {
              load: () => ({ ok: true, value: { entries, skipped: [] } }),
              loadPage: () => ({
                ok: true,
                value: { entries: [], total: 0, hasMore: false },
              }),
            } as unknown as SessionTranscript;
            const summarizer = createAgentSummary({
              transcript,
              modelCall: async (req) => {
                const resp = await modelAdapter.complete({
                  messages: req.messages.map(
                    (msg): InboundMessage => ({
                      content: [{ kind: "text", text: msg.content }],
                      senderId: msg.role === "system" ? "system:summarize" : "user",
                      timestamp: Date.now(),
                    }),
                  ),
                  model: modelName,
                  maxTokens: req.maxTokens,
                });
                return { text: resp.content };
              },
            });
            dispatchNotice(store, "summarize-info", "[Summarize: generating…]");
            const r = await summarizer.summarizeSession(activeSessionId, {
              granularity: "medium",
              modelHint: "cheap",
            });
            if (!r.ok) {
              store.dispatch({
                kind: "add_error",
                code: "SUMMARIZE_FAILED",
                message: `Summarize failed: ${r.error.code} ${r.error.message}`,
              });
              return;
            }
            dispatchNotice(store, "summarize-info", renderSummaryEnvelope(r.value));
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
              modelName: currentModelBox.current,
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
        case "system:governance-reset":
          // The TUI side already cleared its in-memory alerts via the
          // optimistic dispatch from executeGovernanceReset() in tui-root.tsx.
          // Here we reset the bridge's alert-tracker dedup so subsequent
          // re-crossings of the same threshold re-fire toasts.
          governanceBridge?.resetAlerts();
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
          // #1884: the picked session's JSONL exists on disk — keep its
          // id resumable via the post-quit hint even if the user quits
          // without submitting a new turn in this process.
          pickedExistingSession = true;
          rewindBoundaryActive = true;
          clearedThisProcess = false;
          postClearTurnCount = 0;
          // Only clear lastResetFailed — the picker reset succeeded.
          // Do NOT clear clearPersistFailed: if a prior /clear failed
          // on a different session, that session's JSONL is still
          // contaminated and the latch must stay sticky so switching
          // back to it blocks writes (pre-existing safety contract).
          lastResetFailed = false;
          costBridge.setSession(targetSid as string, currentModelBox.current, provider);
          governanceBridge?.setSession(targetSid as string);
          securityBridge.setSession(targetSid as string);
          store.dispatch({
            kind: "set_session_info",
            modelName: currentModelBox.current,
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
    onSubmit: submitText,
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
    // Model picker — host-side /models fetch (L2 TUI has no network code).
    //
    // Refuse when KOI_FALLBACK_MODEL is set: the model-router's target list
    // is frozen at startup and its per-target `executeForTarget` overrides
    // request.model with the configured target id, so a mid-session switch
    // would succeed in the UI while the HTTP call still runs on the
    // startup/fallback chain. Fail loudly instead of silently routing the
    // wrong model. Unset KOI_FALLBACK_MODEL and restart to switch models.
    onFetchModels: (): Promise<FetchModelsResult> =>
      fallbackModels.length > 0
        ? Promise.resolve({
            ok: false,
            error:
              "Model switching is disabled while KOI_FALLBACK_MODEL is set. Unset the env var and restart koi tui to pick a different model.",
          })
        : fetchAvailableModels({
            provider,
            ...(baseUrl !== undefined ? { baseUrl } : {}),
            apiKey,
          }),
    // Model picker — mutate the current-model box so the next turn uses
    // the freshly picked model. The store's `modelName` is updated by
    // TuiRoot via the `model_switched` action; this callback updates the
    // middleware-side source of truth.
    //
    // No-op when the router is active — the fetcher above already
    // short-circuited with an error, but guard here too so a stale
    // selection from an earlier fetch cannot mutate the box.
    onModelSwitch: (model): boolean => {
      if (fallbackModels.length > 0) return false;
      // Refuse mid-turn switches. Two signals cover the full lifecycle:
      //   - `submitInProgress`: set synchronously at onSubmit entry,
      //     covers the preflight window (runtimeReady + resetBarrier)
      //     before `activeController` is assigned.
      //   - `activeController`: set just before stream drain, covers the
      //     in-flight stream window until the finally clears it.
      // Together they close the submit-then-switch race without needing
      // to observe `agentStatus`, which only flips to "processing" after
      // the first engine event.
      if (activeController !== null || submitInProgress) return false;
      currentModelBox.current = model.id;
      currentModelBox.contextLength = clampContextLength(model.contextLength);
      costBridge.setModelName(model.id);
      return true;
    },
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
    // Once any shutdown path (SIGUSR1, SIGTERM, SIGHUP, /quit) has flipped
    // `shutdownStarted`, drop further SIGINTs. Without this, a Ctrl+C that
    // lands during the 8 s cooperative shutdown window can re-enter the
    // SIGINT state machine's `onForce`, kick a concurrent background-task
    // teardown, and overwrite the in-flight shutdown's exit code. The
    // SIGUSR1 handler relies on this invariant to preserve exit code 158
    // (#1906).
    if (shutdownStarted) return;
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
  // SIGUSR1 (#1906): the full handler was already installed in section 4b
  // so a signal during bootstrap (before this section runs) goes through
  // `shutdown` instead of a bare process.exit. See 4b for the rationale.
  // Stdin close (#1750): belt-and-suspenders — when the PTY master closes,
  // the fd fires 'close'. Does NOT require resume() (avoids perturbing
  // OpenTUI's raw terminal input). Only installed when stdin is a TTY to
  // prevent false triggers in test/pipe contexts. Uses exit code 129
  // (same as SIGHUP) because PTY close IS a hangup — using a generic
  // error code would mask the real termination cause for supervisors.
  //
  // Corroborate with stdout: tmux can transiently close stdin under load
  // (send-keys + capture-pane while a child like `bun test` spawns) while
  // the pane's stdout is still writable. A real terminal hangup tears down
  // both. Only shutdown if stdout is also broken — otherwise rely on
  // SIGHUP (which tmux sends on real session kill) as the primary signal.
  //
  // let: justified — set to false when done() resolves, preventing the
  // stdin close handler from force-exiting during external/host teardown.
  let tuiRunning = false;
  const onStdinClose = (): void => {
    if (!tuiRunning || shutdownStarted) return;
    // Probe stdout: if still writable, this is a transient tmux flicker —
    // SIGHUP will fire on real terminal loss. If stdout is already dead,
    // the terminal is truly gone and we should shut down immediately.
    if (process.stdout.writable && !process.stdout.destroyed) {
      return;
    }
    void shutdown(129, "stdin closed (parent terminal gone)");
  };
  process.on("SIGINT", onProcessSigint);
  process.once("SIGTERM", onProcessSigterm);
  process.once("SIGHUP", onProcessSighup);
  // SIGUSR1 is already armed from section 4b (#1906) — no install here.

  // Register stdin close listener and set tuiRunning BEFORE start() so
  // PTY teardown during startup is not missed. tuiRunning is cleared in
  // the finally block to prevent false positives during host teardown.
  tuiRunning = true;
  if (process.stdin.isTTY) {
    process.stdin.once("close", onStdinClose);
  }

  // Print the SIGUSR1 escape-hatch hint BEFORE start() takes over the
  // terminal. OpenTUI enters the alternate screen buffer on start and
  // restores the main buffer on exit, so the hint lands in the user's
  // scrollback and is visible from any other terminal session that runs
  // `ps` to recover the PID. See issue #1906. Skipped on Windows where
  // SIGUSR1 does not exist (the hint would advertise a non-functional
  // escape mechanism).
  //
  // Guarded: a stderr write failure (already-closed stream in an embedded
  // caller or a detached test process) must not propagate, because the
  // `try/finally` below is what removes the signal listeners installed
  // above. Without this catch, a throw here would leak SIGINT/SIGTERM/
  // SIGHUP/SIGUSR1 listeners into the host process.
  if (SIGUSR1_SUPPORTED) {
    try {
      process.stderr.write(generateTuiStartupHint(process.pid));
    } catch {
      /* stderr unwritable — best-effort hint, never leak signal handlers */
    }
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
    process.removeListener("SIGUSR1", onProcessSigusr1);
    process.stdin.removeListener("close", onStdinClose);
    // If `done()` resolved because `shutdown()` called `appHandle.stop()`,
    // shutdown() is still mid-flight — it has more awaits (runtime.dispose,
    // otel flush, resume hint) before reaching its final
    // `process.exit(exitCode)`. Returning here would let bin.ts's
    // `process.exit(0)` fire first, clobbering the intended SIGUSR1/SIGTERM
    // exit code. Await a never-resolving promise so bin.ts cannot reach
    // its own `process.exit` until shutdown completes (or the hard-exit
    // failsafe fires — 8 s for the full path, 6 s for the interim).
    if (shutdownStarted) {
      await new Promise<never>(() => {
        /* never resolves — shutdown() or its hard-exit failsafe owns the exit */
      });
    }
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

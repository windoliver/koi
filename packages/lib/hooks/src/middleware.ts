/**
 * Hook middleware — bridges @koi/hooks execution into the KoiMiddleware contract.
 *
 * Maps engine lifecycle events to hook dispatch:
 *   onSessionStart  → "session.started" (blocking — throws on block decision)
 *   onSessionEnd    → "session.ended"   (awaited — block/modify ignored)
 *   onBeforeTurn    → "turn.started"    (blocking — throws on block decision)
 *   onAfterTurn     → "turn.ended"      (fire-and-forget, drained on session end)
 *   wrapToolCall    → "tool.before" (blocking) + "tool.succeeded" (bounded-await for transform)
 *   wrapModelCall   → "compact.before" (blocking — throws on block) + "compact.after" (fire-and-forget, drained)
 *   wrapModelStream → "compact.before" (blocking — yields error chunk on block) + "compact.after" (fire-and-forget, drained)
 *
 * Pre-call hooks block and aggregate decisions (block > modify > continue).
 * Post-tool hooks are awaited with a bounded deadline for output mutation via
 * transform decisions. If the deadline expires, the original response is returned
 * to avoid blocking tool completion after the side effect has been committed.
 * Other post-call hooks are fire-and-forget during the turn but drained with a
 * bounded wait before session cleanup to prevent last-turn hooks from being aborted.
 *
 * Phase: "resolve" (priority 400). Hooks are business logic, not permissions.
 */

import type {
  CapabilityFragment,
  HookConfig,
  HookDecision,
  HookEnvPolicy,
  HookEvent,
  HookExecutionResult,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  SpawnFn,
  StopGateResult,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { PromptModelCaller } from "@koi/hook-prompt";
import { createAgentExecutor } from "./agent-executor.js";
import { matchesHookFilter } from "./filter.js";
import type { HookExecutor } from "./hook-executor.js";
import { PromptExecutorAdapter } from "./prompt-adapter.js";
import { createHookRegistry } from "./registry.js";
import type { DnsResolverFn } from "./ssrf.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Options for creating a hook middleware. */
export interface CreateHookMiddlewareOptions {
  /** Validated hook configs to dispatch. Typically from `loadHooks()`. */
  readonly hooks: readonly HookConfig[];
  /**
   * Spawn function for agent-type hooks. Required when any hook has `kind: "agent"`.
   * Provided by the L1 engine at middleware wiring time.
   */
  readonly spawnFn?: SpawnFn | undefined;
  /**
   * Model caller for prompt-type hooks. Required when any hook has `kind: "prompt"`.
   * Provided by the L1 engine at middleware wiring time.
   */
  readonly promptCallFn?: PromptModelCaller | undefined;
  /** System-wide env-var policy for allowlisting. */
  readonly envPolicy?: HookEnvPolicy | undefined;
  /**
   * Custom DNS resolver for SSRF validation. Defaults to Bun.dns.lookup.
   * Injectable for testing or environments with custom DNS infrastructure.
   */
  readonly dnsResolver?: DnsResolverFn | undefined;
  /**
   * Maximum time (ms) to wait for post-tool hooks before suppressing output.
   * Defaults to `POST_TOOL_HOOK_DEADLINE_MS` (5000ms).
   */
  readonly postToolHookDeadlineMs?: number | undefined;
  /**
   * Observer tap — called synchronously after every non-empty hook dispatch
   * with the execution results and trigger event. Threaded through to the
   * internal HookRegistry. Used for ATIF trajectory recording.
   */
  readonly onExecuted?:
    | ((results: readonly HookExecutionResult[], event: HookEvent) => void)
    | undefined;
}

// ---------------------------------------------------------------------------
// Decision reporting helpers
// ---------------------------------------------------------------------------

/** Safely serialize a value to a JSON preview string, truncated to maxLen. */
function safePreview(value: unknown, maxLen: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Build a per-hook record for decision reporting.
 * Captures the full decision shape — not just the `kind` but also the
 * reason (block), patch (modify), outputPatch (transform), and failure details.
 */
function buildHookRecord(r: HookExecutionResult): JsonObject {
  if (!r.ok) {
    return {
      name: r.hookName,
      decision: "error",
      durationMs: r.durationMs,
      error: r.error,
      failClosed: r.failClosed !== false,
      ...(r.aborted === true ? { aborted: true } : {}),
    } as JsonObject;
  }
  const d = r.decision;
  return {
    name: r.hookName,
    decision: d.kind,
    durationMs: r.durationMs,
    ...(r.executionFailed === true ? { executionFailed: true } : {}),
    ...(d.kind === "block" ? { reason: d.reason } : {}),
    ...(d.kind === "modify" ? { patch: safePreview(d.patch, 300) } : {}),
    ...(d.kind === "transform"
      ? {
          outputPatch: safePreview(d.outputPatch, 300),
          ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        }
      : {}),
  } as JsonObject;
}

// ---------------------------------------------------------------------------
// Decision aggregation
// ---------------------------------------------------------------------------

/** Result of aggregating hook decisions — includes the winning hook's identity. */
export interface AggregatedDecision {
  readonly decision: HookDecision;
  /** Name of the hook that produced the winning decision (set for block). */
  readonly hookName?: string;
}

/**
 * Aggregate **pre-call** hook decisions with most-restrictive-wins precedence:
 *   block > modify > continue
 *
 * - First `block` wins immediately (short-circuits).
 * - Multiple `modify` patches are merged (later patches override earlier keys).
 * - `transform` decisions are ignored — they are post-call only.
 * - Failed hooks with failClosed !== false → block (deny on failure).
 * - Failed hooks with failClosed: false → skip (fail-open).
 *
 * Returns the decision plus the winning hook's name (for block decisions).
 */
export function aggregateDecisions(results: readonly HookExecutionResult[]): AggregatedDecision {
  let hasModify = false;
  let mergedPatch: JsonObject = {};

  for (const result of results) {
    if (!result.ok) {
      // Fail-closed hooks (failClosed !== false) block on execution failure.
      // Fail-open hooks (failClosed: false) are skipped — their failure is
      // no opinion (e.g., telemetry/observational hooks).
      if (result.failClosed !== false) {
        return {
          decision: {
            kind: "block",
            reason: `Hook ${result.hookName} failed: ${result.error}`,
          },
          hookName: result.hookName,
        };
      }
      continue;
    }

    switch (result.decision.kind) {
      case "block":
        return { decision: result.decision, hookName: result.hookName };
      case "transform":
        // Ignored in pre-call — transform is post-call only
        break;
      case "modify":
        hasModify = true;
        mergedPatch = { ...mergedPatch, ...result.decision.patch };
        break;
      case "continue":
        break;
    }
  }

  if (hasModify) {
    return { decision: { kind: "modify", patch: mergedPatch } };
  }

  return { decision: { kind: "continue" } };
}

// ---------------------------------------------------------------------------
// Block message formatting
// ---------------------------------------------------------------------------

/** Format a consistent block message across all hook block paths. */
function formatBlockMessage(context: string, reason: string): string {
  return `Hook blocked ${context}: ${reason}`;
}

/**
 * Aggregate post-execution hook decisions.
 *
 * Unlike pre-call aggregation, `block` decisions from hooks are ignored
 * because the operation has already completed — you cannot un-execute a
 * tool call.
 *
 * However, hook execution *failures* (ok: false) signal that post-processing
 * (e.g., redaction) could not run. These return `block` so the caller can
 * taint the response with a warning — but the caller must NOT suppress the
 * response or return an error, as that would cause retry/duplicate risk.
 *
 * Only `transform`, `continue`, and failure-`block` are meaningful after execution.
 */
export function aggregatePostDecisions(results: readonly HookExecutionResult[]): HookDecision {
  // Only fail-closed hooks (failClosed !== false) drive redaction. Fail-open
  // hooks (failClosed: false) explicitly opt out — their failure should NOT
  // suppress output (e.g., observational/telemetry hooks).
  const failedHooks = results.filter((r) => !r.ok && r.failClosed !== false).map((r) => r.hookName);

  let hasTransform = false;
  let mergedOutputPatch: JsonObject = {};
  let mergedTransformMeta: JsonObject | undefined;

  for (const result of results) {
    if (!result.ok) continue;

    if (result.decision.kind === "transform") {
      hasTransform = true;
      mergedOutputPatch = { ...mergedOutputPatch, ...result.decision.outputPatch };
      if (result.decision.metadata !== undefined) {
        mergedTransformMeta = { ...(mergedTransformMeta ?? {}), ...result.decision.metadata };
      }
    }
    // block, modify, continue are all no-ops post-execution
  }

  // Hook failures dominate transforms — partial redaction is worse than no
  // redaction because it gives a false sense of safety. When any hook failed,
  // signal block so the caller taints the response with a warning.
  if (failedHooks.length > 0) {
    return {
      kind: "block",
      reason: `Post-hook(s) failed: ${failedHooks.join(", ")}`,
    };
  }

  if (hasTransform) {
    return {
      kind: "transform",
      outputPatch: mergedOutputPatch,
      ...(mergedTransformMeta !== undefined ? { metadata: mergedTransformMeta } : {}),
    };
  }

  return { kind: "continue" };
}

// ---------------------------------------------------------------------------
// Model request patch safety
// ---------------------------------------------------------------------------

/**
 * Fields that hooks are allowed to patch on ModelRequest via modify decisions.
 * Core control fields (messages, tools, systemPrompt, signal) are immutable
 * to prevent hook bugs from corrupting request shape or disabling safeguards.
 */
const MODEL_PATCH_ALLOWLIST = new Set<string>(["model", "temperature", "maxTokens", "metadata"]);

/**
 * Filter a modify patch to only include allowed ModelRequest fields.
 * Returns the filtered patch, or undefined if nothing remains after filtering.
 */
function filterModelPatch(patch: JsonObject): JsonObject | undefined {
  const filtered: Record<string, unknown> = {};
  let hasKeys = false;
  for (const key of Object.keys(patch)) {
    if (MODEL_PATCH_ALLOWLIST.has(key)) {
      filtered[key] = patch[key];
      hasKeys = true;
    }
  }
  return hasKeys ? (filtered as JsonObject) : undefined;
}

// ---------------------------------------------------------------------------
// Post-hook drain timeout
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for pending post-hooks before session cleanup. */
const POST_HOOK_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Maximum time (ms) to wait for post-tool hooks before returning the original
 * response. Prevents slow/hung post-hooks from blocking tool completion after
 * the side effect has already been committed — avoiding duplicate-action paths
 * where callers retry because the response was delayed by a hook timeout.
 */
const POST_TOOL_HOOK_DEADLINE_MS = 5_000;

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates a KoiMiddleware that dispatches hook definitions to command/http
 * executors during the engine lifecycle.
 *
 * @param options - Hook configs to register per session.
 * @returns A KoiMiddleware at resolve phase, priority 400.
 */
export function createHookMiddleware(options: CreateHookMiddlewareOptions): KoiMiddleware {
  const {
    hooks,
    spawnFn,
    promptCallFn,
    envPolicy,
    postToolHookDeadlineMs = POST_TOOL_HOOK_DEADLINE_MS,
  } = options;

  // Fail-fast: agent hooks require spawnFn (Decision 12A)
  const hasAgentHooks = hooks.some((h) => h.kind === "agent");
  if (hasAgentHooks && spawnFn === undefined) {
    throw new Error(
      "Agent hooks require spawnFn — provide it via CreateHookMiddlewareOptions.spawnFn",
    );
  }

  // Fail-fast: prompt hooks require promptCallFn
  const hasPromptHooks = hooks.some((h) => h.kind === "prompt");
  if (hasPromptHooks && promptCallFn === undefined) {
    throw new Error(
      "Prompt hooks require promptCallFn — provide it via CreateHookMiddlewareOptions.promptCallFn",
    );
  }

  const agentExecutor: HookExecutor | undefined =
    spawnFn !== undefined ? createAgentExecutor({ spawnFn }) : undefined;
  const promptExecutor: HookExecutor | undefined =
    promptCallFn !== undefined ? new PromptExecutorAdapter({ caller: promptCallFn }) : undefined;
  const registry = createHookRegistry({
    agentExecutor,
    promptExecutor,
    onExecuted: options.onExecuted,
    dnsResolver: options.dnsResolver,
  });

  /**
   * Per-session set of pending post-hook promises. Drained in onSessionEnd
   * before registry.cleanup() to prevent last-turn hooks from being aborted.
   */
  const pendingPostHooks = new Map<string, Set<Promise<unknown>>>();

  function buildEvent(
    ctx: SessionContext,
    event: string,
    extra?: { readonly toolName?: string; readonly data?: JsonObject },
  ): HookEvent {
    return {
      event,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId as string,
      ...(extra?.toolName !== undefined ? { toolName: extra.toolName } : {}),
      ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
      ...(extra?.data !== undefined ? { data: extra.data } : {}),
    };
  }

  /**
   * Fire hooks without blocking the caller. The promise is tracked per-session
   * and drained before cleanup so last-turn hooks aren't silently aborted.
   */
  function fireAndForget(sessionId: string, event: HookEvent, signal?: AbortSignal): void {
    const promise = registry
      .execute(sessionId, event, signal)
      .catch(() => {
        /* post-call hooks are observational — errors silently swallowed */
      })
      .then(() => {
        // Self-remove from pending set once settled
        pendingPostHooks.get(sessionId)?.delete(promise);
      });

    let pending = pendingPostHooks.get(sessionId);
    if (pending === undefined) {
      pending = new Set();
      pendingPostHooks.set(sessionId, pending);
    }
    pending.add(promise);
  }

  /**
   * Wait for all pending post-hooks for a session with a bounded timeout.
   * After the timeout, remaining hooks are abandoned (cleanup will abort them).
   */
  async function drainPendingPostHooks(sessionId: string): Promise<void> {
    const pending = pendingPostHooks.get(sessionId);
    if (pending === undefined || pending.size === 0) {
      pendingPostHooks.delete(sessionId);
      return;
    }
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => setTimeout(resolve, POST_HOOK_DRAIN_TIMEOUT_MS)),
    ]);
    pendingPostHooks.delete(sessionId);
  }

  /** Build model.pre event data from a ModelRequest. */
  function buildModelPreData(request: ModelRequest): JsonObject {
    return {
      model: request.model ?? "default",
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      hasSystemPrompt: request.systemPrompt !== undefined,
    } as JsonObject;
  }

  /**
   * Run model.pre hooks and return the effective request.
   *
   * Note: registry.execute awaits ALL matching hooks before aggregateDecisions
   * can short-circuit on the first block. A slow hook delays the block decision
   * even if a faster hook already returned block. Flagged for future optimization.
   */
  async function dispatchModelPre(
    sessionId: string,
    ctx: TurnContext,
    request: ModelRequest,
  ): Promise<
    | { readonly blocked: true; readonly reason: string; readonly hookName?: string }
    | { readonly blocked: false; readonly request: ModelRequest }
  > {
    const preEvent = buildEvent(ctx.session, "compact.before", {
      data: buildModelPreData(request),
    });
    const preResults = await registry.execute(sessionId, preEvent);
    const aggregated = aggregateDecisions(preResults);
    // Report hook fire records + aggregated decision for trace recording
    if (preResults.length > 0) {
      ctx.reportDecision?.({
        event: "compact.before",
        aggregated: aggregated.decision.kind,
        ...(aggregated.decision.kind === "block"
          ? { reason: aggregated.decision.reason, hookName: aggregated.hookName }
          : {}),
        hooks: preResults.map((r) => buildHookRecord(r)),
      });
    }

    if (aggregated.decision.kind === "block") {
      return {
        blocked: true,
        reason: aggregated.decision.reason,
        ...(aggregated.hookName !== undefined ? { hookName: aggregated.hookName } : {}),
      };
    }

    if (aggregated.decision.kind === "modify") {
      const safePatch = filterModelPatch(aggregated.decision.patch);
      if (safePatch !== undefined) {
        return { blocked: false, request: { ...request, ...safePatch } };
      }
    }

    return { blocked: false, request };
  }

  return {
    name: "hooks",
    phase: "resolve",
    priority: 400,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      registry.register(sessionId, ctx.agentId, hooks, envPolicy);
      const event = buildEvent(ctx, "session.started");
      const results = await registry.execute(sessionId, event);
      const aggregated = aggregateDecisions(results);
      if (aggregated.decision.kind === "block") {
        registry.cleanup(sessionId);
        throw new Error(formatBlockMessage("session", aggregated.decision.reason));
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const sessionId = ctx.sessionId as string;
      const event = buildEvent(ctx, "session.ended");
      // Awaited but decisions ignored — can't meaningfully block session end
      await registry.execute(sessionId, event);
      // Drain pending post-hooks before cleanup to prevent last-turn hooks
      // from being aborted by the session controller
      await drainPendingPostHooks(sessionId);
      registry.cleanup(sessionId);
      // Reset executor per-session state (token budgets)
      agentExecutor?.cleanupSession?.(sessionId);
      promptExecutor?.cleanupSession?.(sessionId);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.started");
      const results = await registry.execute(sessionId, event);
      const aggregated = aggregateDecisions(results);
      if (aggregated.decision.kind === "block") {
        throw new Error(formatBlockMessage("turn", aggregated.decision.reason));
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Skip turn.ended for stop-gate vetoes — the turn was blocked, not completed.
      if (ctx.stopBlocked === true) return;
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.ended");
      // After-turn hooks are fire-and-forget but tracked for drain
      fireAndForget(sessionId, event);
    },

    async onBeforeStop(ctx: TurnContext): Promise<StopGateResult> {
      const sessionId = ctx.session.sessionId as string;
      const event = buildEvent(ctx.session, "turn.stop");
      const results = await registry.execute(sessionId, event);
      const aggregated = aggregateDecisions(results);
      if (aggregated.decision.kind === "block") {
        return {
          kind: "block",
          reason: aggregated.decision.reason,
          blockedBy: aggregated.hookName ?? "unknown",
        };
      }
      return { kind: "continue" };
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId as string;

      // Fail closed on cancellation: if the caller has already aborted,
      // don't dispatch hooks or run the tool. Throw AbortError so the
      // engine stack handles it with abort semantics (not as tool output).
      if (ctx.signal?.aborted === true) {
        throw new DOMException(
          `Tool call ${request.toolId} aborted before hook dispatch`,
          "AbortError",
        );
      }

      // Pre-call: blocking dispatch with decision aggregation
      const preEvent = buildEvent(ctx.session, "tool.before", {
        toolName: request.toolId,
        data: { input: request.input } as JsonObject,
      });
      const preResults = await registry.execute(sessionId, preEvent, ctx.signal);
      const aggregated = aggregateDecisions(preResults);

      // Report pre-call hook fire records + aggregated decision for trace recording
      if (preResults.length > 0) {
        ctx.reportDecision?.({
          event: "tool.before",
          toolId: request.toolId,
          toolInput: safePreview(request.input, 300),
          aggregated: aggregated.decision.kind,
          ...(aggregated.decision.kind === "block"
            ? { reason: aggregated.decision.reason, hookName: aggregated.hookName }
            : {}),
          ...(aggregated.decision.kind === "modify"
            ? { patch: safePreview(aggregated.decision.patch, 300) }
            : {}),
          hooks: preResults.map((r) => buildHookRecord(r)),
        });
      }

      if (aggregated.decision.kind === "block") {
        return {
          output: { error: formatBlockMessage("tool_call", aggregated.decision.reason) },
          metadata: { blockedByHook: true, hookName: aggregated.hookName },
        };
      }

      // Fail closed on mid-dispatch cancellation: if the signal aborted while
      // pre-hooks were running, registry returned [] and aggregating that as
      // "continue" would let the tool run under cancellation.
      // biome-ignore lint/complexity/useOptionalChain: narrowing workaround — signal can flip during await
      if (ctx.signal !== undefined && ctx.signal.aborted) {
        throw new DOMException(
          `Tool call ${request.toolId} aborted during pre-hook dispatch`,
          "AbortError",
        );
      }

      const effectiveRequest: ToolRequest =
        aggregated.decision.kind === "modify"
          ? { ...request, input: { ...request.input, ...aggregated.decision.patch } }
          : request;

      // let: mutable — set inside try, used in post-hook logic below
      let response: ToolResponse;
      try {
        response = await next(effectiveRequest);
      } catch (toolError: unknown) {
        // Fire tool.failed as fire-and-forget so hook observers (ATIF) see the
        // failure event. Re-throw to preserve original error propagation.
        const failEvent = buildEvent(ctx.session, "tool.failed", {
          toolName: request.toolId,
          data: { input: effectiveRequest.input, error: String(toolError) } as JsonObject,
        });
        fireAndForget(sessionId, failEvent, ctx.signal);
        throw toolError;
      }

      // Post-call: bounded-await for output mutation via transform decisions.
      // Uses effective input (not original) for audit consistency.
      // Raced against a deadline to prevent slow/hung hooks from blocking tool
      // completion after the side effect has already been committed.
      const postEvent = buildEvent(ctx.session, "tool.succeeded", {
        toolName: request.toolId,
        data: { input: effectiveRequest.input, output: response.output } as JsonObject,
      });

      const DEADLINE_SENTINEL = Symbol("deadline");
      const postResultsOrTimeout = await Promise.race([
        registry.execute(sessionId, postEvent, ctx.signal),
        new Promise<typeof DEADLINE_SENTINEL>((resolve) =>
          setTimeout(() => resolve(DEADLINE_SENTINEL), postToolHookDeadlineMs),
        ),
      ]);

      // Deadline expired — suppress raw output to prevent leaking unredacted
      // data. Use a plain string (not an error object) so callers preserve
      // committed-success semantics and don't retry the side effect.
      if (postResultsOrTimeout === DEADLINE_SENTINEL) {
        return {
          output: "[output redacted: post-tool hooks timed out]",
          metadata: { ...(response.metadata ?? {}), committedButRedacted: true },
        };
      }

      // Cancel-redaction: if the caller's signal aborted during post-hook
      // dispatch AND registry returned [] (hooks short-circuited on cancel)
      // AND a fail-closed hook could have matched this event, redact to
      // prevent leaking unredacted data past a skipped security hook.
      // Only fail-closed hooks (failClosed !== false) justify redaction —
      // fail-open hooks explicitly opt out of output suppression.
      // Re-read signal fresh — it can flip to aborted during the post-hook
      // await even though the pre-dispatch guard narrowed it earlier.
      // biome-ignore lint/complexity/useOptionalChain: narrowing workaround — signal can flip during await
      const postAborted = ctx.signal !== undefined && ctx.signal.aborted;
      if (
        Array.isArray(postResultsOrTimeout) &&
        postResultsOrTimeout.length === 0 &&
        postAborted &&
        hooks.some((h) => h.failClosed !== false && matchesHookFilter(h.filter, postEvent))
      ) {
        return {
          output: "[output redacted: post-hooks skipped due to cancellation]",
          metadata: { ...(response.metadata ?? {}), committedButRedacted: true },
        };
      }

      const postDecision = aggregatePostDecisions(postResultsOrTimeout);

      // Report post-call hook fire records + aggregated post-decision for trace recording
      if (Array.isArray(postResultsOrTimeout) && postResultsOrTimeout.length > 0) {
        ctx.reportDecision?.({
          event: "tool.succeeded",
          toolId: request.toolId,
          toolOutput: safePreview(response.output, 300),
          aggregated: postDecision.kind,
          ...(postDecision.kind === "block" ? { reason: postDecision.reason } : {}),
          hooks: (postResultsOrTimeout as readonly HookExecutionResult[]).map((r) =>
            buildHookRecord(r),
          ),
        });
      }

      if (postDecision.kind === "transform") {
        const isPlainObject =
          typeof response.output === "object" &&
          response.output !== null &&
          !Array.isArray(response.output);
        const transformedOutput = isPlainObject
          ? { ...(response.output as JsonObject), ...postDecision.outputPatch }
          : postDecision.outputPatch;
        const hasMetaPatch = postDecision.metadata !== undefined;
        const transformedMetadata = hasMetaPatch
          ? { ...(response.metadata ?? {}), ...postDecision.metadata }
          : response.metadata;
        return transformedMetadata !== undefined
          ? { output: transformedOutput, metadata: transformedMetadata }
          : { output: transformedOutput };
      }

      // Post-hooks failed (aggregatePostDecisions returns block). Suppress
      // raw output to prevent leaking unredacted data, but use a string so
      // callers don't interpret this as a tool failure and retry.
      if (postDecision.kind === "block") {
        return {
          output: `[output redacted: ${postDecision.reason}]`,
          metadata: { ...(response.metadata ?? {}), committedButRedacted: true },
        };
      }

      return response;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const sessionId = ctx.session.sessionId as string;
      const preEvent = buildEvent(ctx.session, "compact.before", {
        data: buildModelPreData(request),
      });
      const preResults = await registry.execute(sessionId, preEvent);
      const aggregated = aggregateDecisions(preResults);
      // Report model pre-call hook fire records + aggregated decision
      if (preResults.length > 0) {
        ctx.reportDecision?.({
          event: "compact.before",
          aggregated: aggregated.decision.kind,
          ...(aggregated.decision.kind === "block"
            ? { reason: aggregated.decision.reason, hookName: aggregated.hookName }
            : {}),
          hooks: preResults.map((r) => buildHookRecord(r)),
        });
      }
      const preResult =
        aggregated.decision.kind === "block"
          ? {
              blocked: true as const,
              reason: aggregated.decision.reason,
              hookName: aggregated.hookName,
            }
          : aggregated.decision.kind === "modify"
            ? (() => {
                const safePatch = filterModelPatch(aggregated.decision.patch);
                return safePatch !== undefined
                  ? { blocked: false as const, request: { ...request, ...safePatch } }
                  : { blocked: false as const, request };
              })()
            : { blocked: false as const, request };

      if (preResult.blocked) {
        // Observability: emit custom event for telemetry/audit (fire-and-forget)
        const blockEvent = buildEvent(ctx.session, "compact.blocked", {
          data: {
            reason: preResult.reason,
            hookName: preResult.hookName,
          } as JsonObject,
        });
        fireAndForget(sessionId, blockEvent);

        return {
          content: formatBlockMessage("model_call", preResult.reason),
          model: request.model ?? "unknown",
          stopReason: "hook_blocked",
          metadata: {
            blockedByHook: true,
            reason: preResult.reason,
            hookName: preResult.hookName,
          },
        };
      }

      const response = await next(preResult.request);

      // Post-call: fire-and-forget
      const postEvent = buildEvent(ctx.session, "compact.after", {
        data: { model: response.model } as JsonObject,
      });
      fireAndForget(sessionId, postEvent);

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sessionId = ctx.session.sessionId as string;
      const preResult = await dispatchModelPre(sessionId, ctx, request);

      if (preResult.blocked) {
        // Observability: emit custom event for telemetry/audit (fire-and-forget)
        const blockEvent = buildEvent(ctx.session, "compact.blocked", {
          data: {
            reason: preResult.reason,
            hookName: preResult.hookName,
          } as JsonObject,
        });
        fireAndForget(sessionId, blockEvent);

        yield {
          kind: "error",
          message: formatBlockMessage("model_stream", preResult.reason),
          code: "PERMISSION",
          retryable: false,
        };
        return;
      }

      try {
        yield* next(preResult.request);
      } finally {
        // Post-call: fire-and-forget after stream completes or errors
        // Use effective model (from preResult), not original request model
        const postEvent = buildEvent(ctx.session, "compact.after", {
          data: { model: preResult.request.model ?? "default" } as JsonObject,
        });
        fireAndForget(sessionId, postEvent);
      }
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (hooks.length === 0) return undefined;
      const names = hooks.map((h) => h.name).join(", ");
      return {
        label: "hooks",
        description: `Active hooks: ${names}`,
      };
    },
  };
}

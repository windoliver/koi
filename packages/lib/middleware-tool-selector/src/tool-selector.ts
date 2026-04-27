/**
 * Tool-selector middleware — pre-filters `request.tools` before the model call.
 *
 * Phase: `intercept` (mutates the request).
 * Priority: 200 — runs after permissions/budget guards but well before the
 * terminal model adapter, so inner middleware sees the reduced tool set.
 *
 * Fail-open on selection: if the strategy throws or `selectTools` rejects,
 * the unfiltered request passes through unchanged. The error is reported via
 * `onError` (if provided) and otherwise swallowed via `@koi/errors`.
 *
 * Fail-closed on execution (default): when `enforceFiltering` is `true`
 * (default), `wrapToolCall` rejects any tool whose name was filtered out for
 * the current turn — defending against model hallucinations / prompt
 * injection that emit a tool name the model was not actually shown.
 */

import type { InboundMessage, JsonObject, TurnId } from "@koi/core";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError, swallowError } from "@koi/errors";
import type { ToolSelectorConfig } from "./config.js";
import { DEFAULT_MAX_TOOLS, DEFAULT_MIN_TOOLS, validateToolSelectorConfig } from "./config.js";
import { extractLastUserText } from "./extract-query.js";

/** Priority slot — runs after guards (0–100) and before the model adapter. */
const TOOL_SELECTOR_PRIORITY = 200;

/**
 * Creates a `KoiMiddleware` that filters `ModelRequest.tools` per call using
 * the provided strategy. See `ToolSelectorConfig` for the option surface.
 */
export function createToolSelectorMiddleware(config: ToolSelectorConfig): KoiMiddleware {
  const validated = validateToolSelectorConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }

  const {
    selectTools,
    alwaysInclude = [],
    maxTools = DEFAULT_MAX_TOOLS,
    minTools = DEFAULT_MIN_TOOLS,
    extractQuery: configExtractQuery,
    isUserSender,
    onError,
    enforceFiltering = true,
  } = validated.value;
  // When the caller doesn't supply a full extractQuery override but does
  // pass a custom isUserSender predicate, weave the predicate into the
  // bundled extractor so deployments with non-default sender IDs still
  // get tool filtering instead of silently falling back to full tool
  // exposure (#review-round19-F1).
  const extractQuery: (messages: readonly InboundMessage[]) => string =
    configExtractQuery ??
    (isUserSender !== undefined
      ? (messages): string => extractLastUserText(messages, isUserSender)
      : extractLastUserText);

  // Each model invocation produces an immutable allowlist snapshot.
  // wrapModelStream binds incoming `tool_call_start` chunks' callIds
  // to the snapshot so wrapToolCall can validate each tool call against
  // the EXACT tool set the model saw when it generated that call —
  // even when the same turn issues multiple model requests with
  // different tool sets (retries, replanning, overlapping calls).
  // Falls back to the union of the turn's snapshots only when the
  // call wasn't bound to a specific snapshot (non-streaming path
  // without a callId, or stream wrappers that don't preserve callIds).
  // #review-round20-F1.
  const callAllowlists = new Map<string, ReadonlySet<string>>();
  const turnSnapshots = new Map<TurnId, ReadonlySet<string>[]>();
  // let justified: tracks the most recently captured snapshot per turn so
  // tool_call_start chunks emitted by the inner stream can bind to it.
  const lastSnapshotByTurn = new Map<TurnId, ReadonlySet<string>>();

  function recordSnapshot(turnId: TurnId, allowed: ReadonlySet<string>): void {
    const list = turnSnapshots.get(turnId);
    if (list === undefined) {
      turnSnapshots.set(turnId, [allowed]);
    } else {
      list.push(allowed);
    }
    lastSnapshotByTurn.set(turnId, allowed);
  }

  function reportError(e: unknown): void {
    if (onError !== undefined) {
      onError(e);
      return;
    }
    swallowError(e, { package: "middleware-tool-selector", operation: "selectTools" });
  }

  async function filterRequest(ctx: TurnContext, request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;
    if (tools === undefined || tools.length <= minTools) {
      // Fast path: no semantic filtering needed because the toolset is
      // already small enough (or absent). When enforceFiltering is on,
      // install an allowlist matching exactly what the model was shown
      // — including the EMPTY set for deny-all turns where tools is
      // undefined. wrapToolCall must still reject tool calls that were
      // not advertised, otherwise a caller omitting `tools` to disable
      // tools for a turn gets no enforcement at all and any native
      // tool_call_* the adapter emits still executes
      // (#review-round11-F1, #review-round16-F1).
      if (enforceFiltering) {
        const advertised = tools ?? [];
        recordSnapshot(ctx.turnId, new Set<string>(advertised.map((t) => t.name)));
      }
      return request;
    }

    const query = extractQuery(request.messages);
    if (query === "") {
      // No query to drive selection, but keep enforcement honest by
      // pinning the allowlist to what's currently advertised.
      if (enforceFiltering) {
        recordSnapshot(ctx.turnId, new Set<string>(tools.map((t) => t.name)));
      }
      return request;
    }

    // let: assigned in try, read after the catch — required by the fail-open path.
    let selectedNames: readonly string[];
    try {
      selectedNames = await selectTools(query, tools);
    } catch (e: unknown) {
      reportError(e);
      if (enforceFiltering) {
        // Fail closed: install an allowlist containing only `alwaysInclude`
        // so wrapToolCall still rejects every other tool for this turn.
        // Returning the original (unfiltered) request without an allowlist
        // would let the model both see and call every tool — defeating the
        // very trust boundary enforceFiltering exists to provide.
        recordSnapshot(ctx.turnId, new Set<string>(alwaysInclude));
        const fallbackTools = tools.filter((t) => alwaysInclude.includes(t.name));
        return { ...request, tools: fallbackTools };
      }
      return request;
    }

    const nameSet = new Set<string>([...selectedNames.slice(0, maxTools), ...alwaysInclude]);
    const filteredTools = tools.filter((t) => nameSet.has(t.name));

    if (enforceFiltering) {
      // Snapshot the allowed set so wrapToolCall can fail closed for any
      // tool the model emits that wasn't in this invocation's advertised
      // set. Per-invocation snapshot, not per-turn — multiple model
      // requests in the same turn each get their own snapshot.
      recordSnapshot(ctx.turnId, new Set<string>(filteredTools.map((t) => t.name)));
    }

    const metadata: JsonObject = {
      ...request.metadata,
      toolsBeforeFilter: tools.length,
      toolsAfterFilter: filteredTools.length,
    };

    return { ...request, tools: filteredTools, metadata };
  }

  const description =
    `Tool filtering: keeps up to ${String(maxTools)} per call (skips at <= ${String(minTools)})` +
    (alwaysInclude.length > 0 ? `, always: ${alwaysInclude.join(", ")}` : "") +
    (enforceFiltering ? "; enforces at execution" : "; advisory only");

  const capabilityFragment: CapabilityFragment = {
    label: "tool-selector",
    description,
  };

  return {
    name: "koi:tool-selector",
    priority: TOOL_SELECTOR_PRIORITY,
    phase: "intercept",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,
    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      return next(await filterRequest(ctx, request));
    },
    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const filtered = await filterRequest(ctx, request);
      // Snapshot the allowlist that was in force when THIS invocation
      // ran, so tool_call_start chunks emitted by the inner stream can
      // bind to it — even if a subsequent model call in the same turn
      // overwrites lastSnapshotByTurn. Captured here (not at chunk
      // time) so concurrent invocations don't race on the shared map.
      const snapshot = enforceFiltering ? lastSnapshotByTurn.get(ctx.turnId) : undefined;
      for await (const chunk of next(filtered)) {
        if (snapshot !== undefined && chunk.kind === "tool_call_start") {
          callAllowlists.set(chunk.callId, snapshot);
        }
        yield chunk;
      }
    },
    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!enforceFiltering) return next(request);
      // Prefer the per-call snapshot bound when this tool_call_start
      // was emitted by the model stream (#review-round20-F1).
      if (request.callId !== undefined) {
        const allowed = callAllowlists.get(request.callId);
        if (allowed !== undefined) {
          if (allowed.has(request.toolId)) return next(request);
          throw KoiRuntimeError.from(
            "PERMISSION",
            `Tool "${request.toolId}" was filtered out for this invocation by koi:tool-selector and cannot be invoked. Set enforceFiltering: false to disable execution-time enforcement.`,
          );
        }
      }
      // Fallback: non-streaming path or stream wrapper that didn't
      // preserve callIds. Allow if the tool appeared in ANY of the
      // turn's snapshots — strictly looser than per-call enforcement
      // but never looser than the historical per-turn semantics.
      const snapshots = turnSnapshots.get(_ctx.turnId);
      if (snapshots === undefined) return next(request);
      for (const allowed of snapshots) {
        if (allowed.has(request.toolId)) return next(request);
      }
      throw KoiRuntimeError.from(
        "PERMISSION",
        `Tool "${request.toolId}" was filtered out for this turn by koi:tool-selector and cannot be invoked. Set enforceFiltering: false to disable execution-time enforcement.`,
      );
    },
    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const snapshots = turnSnapshots.get(ctx.turnId);
      turnSnapshots.delete(ctx.turnId);
      lastSnapshotByTurn.delete(ctx.turnId);
      // Drop callId bindings recorded under this turn's snapshots so
      // long-lived sessions don't leak entries.
      if (snapshots !== undefined) {
        for (const [callId, snap] of callAllowlists) {
          if (snapshots.includes(snap)) callAllowlists.delete(callId);
        }
      }
    },
  };
}

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

  function recordSnapshot(turnId: TurnId, allowed: ReadonlySet<string>): void {
    const list = turnSnapshots.get(turnId);
    if (list === undefined) {
      turnSnapshots.set(turnId, [allowed]);
    } else {
      list.push(allowed);
    }
  }

  /**
   * Result of filtering one model invocation: the rewritten request and
   * the immutable allowlist snapshot that was recorded for it. Returned
   * as a pair (rather than via a shared `lastSnapshotByTurn` map) so
   * concurrent invocations on the same turn cannot read each other's
   * snapshot after an `await` boundary (#review-round21-F1).
   */
  interface FilterResult {
    readonly request: ModelRequest;
    readonly snapshot: ReadonlySet<string> | undefined;
  }

  function reportError(e: unknown): void {
    if (onError !== undefined) {
      onError(e);
      return;
    }
    swallowError(e, { package: "middleware-tool-selector", operation: "selectTools" });
  }

  function captureSnapshot(
    turnId: TurnId,
    allowed: ReadonlySet<string>,
  ): ReadonlySet<string> | undefined {
    if (!enforceFiltering) return undefined;
    recordSnapshot(turnId, allowed);
    return allowed;
  }

  async function filterRequest(ctx: TurnContext, request: ModelRequest): Promise<FilterResult> {
    const tools = request.tools;
    if (tools === undefined || tools.length <= minTools) {
      // Fast path: no semantic filtering needed because the toolset is
      // already small enough (or absent). Install an allowlist matching
      // exactly what the model was shown — including the EMPTY set for
      // deny-all turns where tools is undefined. wrapToolCall must
      // still reject tool calls that were not advertised, otherwise a
      // caller omitting `tools` to disable tools gets no enforcement
      // (#review-round11-F1, #review-round16-F1).
      const advertised = tools ?? [];
      const snapshot = captureSnapshot(ctx.turnId, new Set<string>(advertised.map((t) => t.name)));
      return { request, snapshot };
    }

    const query = extractQuery(request.messages);
    if (query === "") {
      // No query to drive selection, but keep enforcement honest by
      // pinning the allowlist to what's currently advertised.
      const snapshot = captureSnapshot(ctx.turnId, new Set<string>(tools.map((t) => t.name)));
      return { request, snapshot };
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
        const snapshot = captureSnapshot(ctx.turnId, new Set<string>(alwaysInclude));
        const fallbackTools = tools.filter((t) => alwaysInclude.includes(t.name));
        return { request: { ...request, tools: fallbackTools }, snapshot };
      }
      return { request, snapshot: undefined };
    }

    const nameSet = new Set<string>([...selectedNames.slice(0, maxTools), ...alwaysInclude]);
    const filteredTools = tools.filter((t) => nameSet.has(t.name));

    const snapshot = captureSnapshot(ctx.turnId, new Set<string>(filteredTools.map((t) => t.name)));

    const metadata: JsonObject = {
      ...request.metadata,
      toolsBeforeFilter: tools.length,
      toolsAfterFilter: filteredTools.length,
    };

    return { request: { ...request, tools: filteredTools, metadata }, snapshot };
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
      const { request: filtered } = await filterRequest(ctx, request);
      return next(filtered);
    },
    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // Capture this invocation's snapshot directly from filterRequest
      // — concurrent overlapping streams on the same turn cannot
      // race on a shared map after this point (#review-round21-F1).
      const { request: filtered, snapshot } = await filterRequest(ctx, request);
      for await (const chunk of next(filtered)) {
        if (snapshot !== undefined && chunk.kind === "tool_call_start") {
          callAllowlists.set(chunk.callId, snapshot);
        }
        yield chunk;
      }
    },
    async wrapToolCall(
      ctx: TurnContext,
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
      // No callId binding available. Two cases:
      //   1. The turn has snapshots — adapter executed a tool call
      //      that wasn't bound to any model invocation we filtered.
      //      Fail closed (#review-round21-F2): widening to "in any
      //      turn snapshot" let adapters bypass per-invocation
      //      enforcement by simply omitting callId.
      //   2. The turn has NO snapshots — selector never ran for this
      //      turn (e.g. no model call yet, or filter skipped). Pass
      //      through, since there is nothing to enforce against.
      const snapshots = turnSnapshots.get(ctx.turnId);
      if (snapshots === undefined) return next(request);
      throw KoiRuntimeError.from(
        "PERMISSION",
        `Tool "${request.toolId}" was invoked without a callId bound to a koi:tool-selector snapshot. With enforceFiltering: true, model-originated tool execution must carry the tool_call_start callId. Set enforceFiltering: false to disable execution-time enforcement.`,
      );
    },
    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const snapshots = turnSnapshots.get(ctx.turnId);
      turnSnapshots.delete(ctx.turnId);
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

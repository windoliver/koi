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
import { extractLastUserText, hasMultimodalUserMessage } from "./extract-query.js";

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
    multimodalPolicy = "fail-closed",
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
  // Multimodal detector: distinguishes "valid user turn with non-text
  // content" from "no recognized user message" AND from "user message
  // with text-only content (possibly empty)" — only the first case
  // takes the pass-through branch (#review-round34-F1). Never
  // overridden by configExtractQuery.
  const detectMultimodal: (messages: readonly InboundMessage[]) => boolean =
    isUserSender !== undefined
      ? (messages): boolean => hasMultimodalUserMessage(messages, isUserSender)
      : hasMultimodalUserMessage;

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
  // Per-turn map of callId → snapshot. Scoping by turnId means
  // providers that recycle short callIds ("call_0", "tc1") across
  // overlapping turns / sessions on the same middleware instance
  // cannot overwrite each other's bindings (#review-round22-F1).
  const callAllowlists = new Map<TurnId, Map<string, ReadonlySet<string>>>();
  const turnSnapshots = new Map<TurnId, ReadonlySet<string>[]>();

  function bindCall(turnId: TurnId, callId: string, snapshot: ReadonlySet<string>): void {
    let m = callAllowlists.get(turnId);
    if (m === undefined) {
      m = new Map<string, ReadonlySet<string>>();
      callAllowlists.set(turnId, m);
    }
    m.set(callId, snapshot);
  }

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
    // No tools to filter: install the empty allowlist so wrapToolCall
    // fails closed on the deny-all case (#review-round11-F1,
    // #review-round16-F1).
    if (tools === undefined) {
      const snapshot = captureSnapshot(ctx.turnId, new Set<string>());
      return { request, snapshot };
    }

    // minTools fast-path is an OPTIMIZATION (skip semantic filtering
    // for already-small toolsets). It must NOT weaken the trust
    // boundary: under enforceFiltering, run selectTools regardless of
    // tool count so the snapshot reflects what selectTools chose, not
    // the full advertised set. Pure advisory mode (enforceFiltering
    // false) keeps the optimization (#review-round23-F1).
    if (tools.length <= minTools && !enforceFiltering) {
      return { request, snapshot: undefined };
    }

    const query = extractQuery(request.messages);
    if (query === "") {
      // Empty query has two distinct causes — handle them separately.
      // (a) A valid user turn whose latest message has only non-text
      //     blocks (image-only, attachment-only, etc.). Failing closed
      //     here would make multimodal turns silently lose nearly all
      //     tools (#review-round31-F1). Pass through unchanged — the
      //     model gets the full advertised set as if filtering were
      //     skipped. ONLY applies when using the bundled extractor:
      //     a custom extractQuery returning "" is an explicit deny
      //     signal from the caller and must fail closed
      //     (#review-round33-F2).
      // (b) No recognized user message at all (untrusted provenance:
      //     unrecognized sender shape, assistant-only transcript). Under
      //     enforceFiltering, fail closed to alwaysInclude so a forged
      //     transcript can't authorize the full tool set
      //     (#review-round23-F2).
      if (
        configExtractQuery === undefined &&
        detectMultimodal(request.messages) &&
        multimodalPolicy === "pass-through"
      ) {
        // Caller explicitly opted into the round-31 multimodal pass-
        // through. Bind to the full advertised set under enforceFiltering
        // so tool_call_start callIds get an explicit snapshot.
        const snapshot = captureSnapshot(ctx.turnId, new Set<string>(tools.map((t) => t.name)));
        return { request, snapshot };
      }
      if (enforceFiltering) {
        const fallbackTools = tools.filter((t) => alwaysInclude.includes(t.name));
        const snapshot = captureSnapshot(
          ctx.turnId,
          new Set<string>(fallbackTools.map((t) => t.name)),
        );
        return { request: { ...request, tools: fallbackTools }, snapshot };
      }
      return { request, snapshot: undefined };
    }

    // let: assigned in try, read after the catch — required by the fail-open path.
    let selectedNames: readonly string[];
    try {
      selectedNames = await selectTools(query, tools);
    } catch (e: unknown) {
      reportError(e);
      if (enforceFiltering) {
        // Fail closed: install an allowlist matching ONLY the
        // alwaysInclude tools that were actually present in the
        // request — never raw alwaysInclude names. If a name is in
        // alwaysInclude but absent from request.tools, the model
        // never saw it; allowing it at execution would let a forged
        // tool_call_* invoke a tool that was intentionally omitted
        // from this turn's advertised set (#review-round22-F2).
        const fallbackTools = tools.filter((t) => alwaysInclude.includes(t.name));
        const snapshot = captureSnapshot(
          ctx.turnId,
          new Set<string>(fallbackTools.map((t) => t.name)),
        );
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
          bindCall(ctx.turnId, chunk.callId, snapshot);
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
      // was emitted by the model stream (#review-round20-F1). Lookup
      // is scoped by turn so recycled callIds across sessions /
      // overlapping turns never collide (#review-round22-F1).
      // Model-originated tool calls always carry a callId bound at
      // tool_call_start (see wrapModelStream above). Three cases:
      //   1. callId present AND bound to a snapshot → enforce against
      //      that snapshot. The snapshot is what the model "saw" when
      //      it chose this tool, so off-snapshot tools are forged.
      //   2. callId present but UNBOUND → suspicious: a callId without
      //      a matching tool_call_start did not come from the model
      //      stream this selector observed. Fail closed
      //      (#review-round21-F2).
      //   3. callId absent → trusted adapter / internal orchestration
      //      path (e.g. callHandlers.toolCall called directly). Models
      //      always supply a callId, so the absence indicates a
      //      non-model origin that the selector was never meant to
      //      gate (#review-round29-F2). Pass through.
      if (request.callId === undefined) return next(request);
      const allowed = callAllowlists.get(ctx.turnId)?.get(request.callId);
      if (allowed !== undefined) {
        if (allowed.has(request.toolId)) return next(request);
        throw KoiRuntimeError.from(
          "PERMISSION",
          `Tool "${request.toolId}" was filtered out for this invocation by koi:tool-selector and cannot be invoked. Set enforceFiltering: false to disable execution-time enforcement.`,
        );
      }
      // callId present but no binding — and there ARE snapshots for
      // this turn (i.e. selector observed at least one model call).
      // No snapshots: pass through (selector never ran for this turn).
      const snapshots = turnSnapshots.get(ctx.turnId);
      if (snapshots === undefined) return next(request);
      throw KoiRuntimeError.from(
        "PERMISSION",
        `Tool "${request.toolId}" was invoked with callId="${request.callId}" that does not match any koi:tool-selector snapshot binding for this turn. Set enforceFiltering: false to disable execution-time enforcement.`,
      );
    },
    async onAfterTurn(ctx: TurnContext): Promise<void> {
      turnSnapshots.delete(ctx.turnId);
      callAllowlists.delete(ctx.turnId);
    },
  };
}

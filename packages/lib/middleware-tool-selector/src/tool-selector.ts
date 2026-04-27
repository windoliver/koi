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

import type { JsonObject, TurnId } from "@koi/core";
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
    extractQuery = extractLastUserText,
    onError,
    enforceFiltering = true,
  } = validated.value;

  // Per-turn allowlist captured by the model-call hook and consulted by
  // wrapToolCall. Cleared by onAfterTurn to avoid unbounded growth across
  // long-lived sessions.
  const turnAllowlists = new Map<TurnId, ReadonlySet<string>>();

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
        turnAllowlists.set(ctx.turnId, new Set<string>(advertised.map((t) => t.name)));
      }
      return request;
    }

    const query = extractQuery(request.messages);
    if (query === "") {
      // No query to drive selection, but keep enforcement honest by
      // pinning the allowlist to what's currently advertised.
      if (enforceFiltering) {
        turnAllowlists.set(ctx.turnId, new Set<string>(tools.map((t) => t.name)));
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
        turnAllowlists.set(ctx.turnId, new Set<string>(alwaysInclude));
        const fallbackTools = tools.filter((t) => alwaysInclude.includes(t.name));
        return { ...request, tools: fallbackTools };
      }
      return request;
    }

    const nameSet = new Set<string>([...selectedNames.slice(0, maxTools), ...alwaysInclude]);
    const filteredTools = tools.filter((t) => nameSet.has(t.name));

    if (enforceFiltering) {
      // Snapshot the allowed set keyed by turnId so wrapToolCall can fail
      // closed for any tool the model emits that wasn't in this turn's
      // advertised set.
      turnAllowlists.set(ctx.turnId, new Set<string>(filteredTools.map((t) => t.name)));
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
      yield* next(await filterRequest(ctx, request));
    },
    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!enforceFiltering) return next(request);
      const allowed = turnAllowlists.get(ctx.turnId);
      if (allowed === undefined) return next(request);
      if (allowed.has(request.toolId)) return next(request);
      throw KoiRuntimeError.from(
        "PERMISSION",
        `Tool "${request.toolId}" was filtered out for this turn by koi:tool-selector and cannot be invoked. Set enforceFiltering: false to disable execution-time enforcement.`,
      );
    },
    async onAfterTurn(ctx: TurnContext): Promise<void> {
      turnAllowlists.delete(ctx.turnId);
    },
  };
}

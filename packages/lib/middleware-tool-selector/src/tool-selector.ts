/**
 * Tool-selector middleware — pre-filters `request.tools` before the model call.
 *
 * Phase: `intercept` (mutates the request).
 * Priority: 200 — runs after permissions/budget guards but well before the
 * terminal model adapter, so inner middleware sees the reduced tool set.
 *
 * Fail-open: if the strategy throws or `selectTools` rejects, the unfiltered
 * request passes through unchanged. The error is reported via `onError` (if
 * provided) and otherwise swallowed via `@koi/errors`.
 */

import type { JsonObject } from "@koi/core";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
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
  } = validated.value;

  function reportError(e: unknown): void {
    if (onError !== undefined) {
      onError(e);
      return;
    }
    swallowError(e, { package: "middleware-tool-selector", operation: "selectTools" });
  }

  async function filterRequest(request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;
    if (tools === undefined || tools.length <= minTools) {
      return request;
    }

    const query = extractQuery(request.messages);
    if (query === "") {
      return request;
    }

    // let: assigned in try, read after the catch — required by the fail-open path.
    let selectedNames: readonly string[];
    try {
      selectedNames = await selectTools(query, tools);
    } catch (e: unknown) {
      reportError(e);
      return request;
    }

    const nameSet = new Set<string>([...selectedNames.slice(0, maxTools), ...alwaysInclude]);
    const filteredTools = tools.filter((t) => nameSet.has(t.name));

    const metadata: JsonObject = {
      ...request.metadata,
      toolsBeforeFilter: tools.length,
      toolsAfterFilter: filteredTools.length,
    };

    return { ...request, tools: filteredTools, metadata };
  }

  const description =
    `Tool filtering: keeps up to ${String(maxTools)} per call (skips at <= ${String(minTools)})` +
    (alwaysInclude.length > 0 ? `, always: ${alwaysInclude.join(", ")}` : "");

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
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      return next(await filterRequest(request));
    },
    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      yield* next(await filterRequest(request));
    },
  };
}

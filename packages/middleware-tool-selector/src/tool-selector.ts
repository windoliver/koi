/**
 * Tool-selector middleware — pre-filters tools before each model call.
 */

import type {
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError, swallowError } from "@koi/errors";
import type { ToolSelectorConfig } from "./config.js";
import { validateToolSelectorConfig } from "./config.js";
import { extractLastUserText } from "./extract-query.js";

const DEFAULT_MAX_TOOLS = 10;
const DEFAULT_MIN_TOOLS = 5;

/**
 * Creates a middleware that filters tools before each model call using a
 * caller-provided selector function. When the agent has many tools (20+),
 * this reduces token usage and improves model selection accuracy.
 */
export function createToolSelectorMiddleware(config: ToolSelectorConfig): KoiMiddleware {
  const validResult = validateToolSelectorConfig(config);
  if (!validResult.ok) {
    throw KoiRuntimeError.from(validResult.error.code, validResult.error.message);
  }

  const {
    selectTools,
    alwaysInclude = [],
    maxTools = DEFAULT_MAX_TOOLS,
    minTools = DEFAULT_MIN_TOOLS,
    extractQuery = extractLastUserText,
  } = validResult.value;

  async function filterRequest(request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;

    // Skip if no tools or at/below threshold
    if (tools === undefined || tools.length <= minTools) {
      return request;
    }

    // Extract query from messages
    const query = extractQuery(request.messages);
    if (query === "") {
      return request;
    }

    // Call selector with graceful degradation
    // let: required by try/catch — assigned in try, read after catch
    let selectedNames: readonly string[];
    try {
      selectedNames = await selectTools(query, tools);
    } catch (e: unknown) {
      swallowError(e, { package: "middleware-tool-selector", operation: "selectTools" });
      return request;
    }

    // Build name set: selected (capped at maxTools) + alwaysInclude
    const nameSet = new Set<string>([...selectedNames.slice(0, maxTools), ...alwaysInclude]);

    // Filter tools (only keep tools whose name is in the set)
    const filteredTools = tools.filter((t) => nameSet.has(t.name));

    // Record counts in metadata for observability
    const metadata: JsonObject = {
      ...request.metadata,
      toolsBeforeFilter: tools.length,
      toolsAfterFilter: filteredTools.length,
    };

    return { ...request, tools: filteredTools, metadata };
  }

  return {
    name: "tool-selector",
    priority: 420,

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

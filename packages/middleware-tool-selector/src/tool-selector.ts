/**
 * Tool-selector middleware — pre-filters tools before each model call.
 *
 * Supports three modes:
 * - custom: dynamic selectTools function per call
 * - profile: static precomputed tool set from a named profile
 * - auto: profile + model-capability-aware scaling
 */

import type {
  CapabilityFragment,
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
import type { ToolSelectorConfig, ValidatedToolSelectorConfig } from "./config.js";
import { validateToolSelectorConfig } from "./config.js";
import { extractLastUserText } from "./extract-query.js";
import { resolveProfile } from "./resolve-profile.js";

const DEFAULT_MAX_TOOLS = 10;
const DEFAULT_MIN_TOOLS = 5;

/**
 * Creates a middleware that filters tools before each model call.
 *
 * - custom config: uses caller-provided selectTools per call
 * - profile/auto config: precomputes allowed tool Set at factory time
 * - full profile: short-circuits (no filtering)
 *
 * For profile/auto modes, the tool allowlist is resolved once at creation time.
 * If the model changes after middleware creation (e.g., fallback), the tier cap
 * will NOT be re-evaluated. Recreate the middleware to pick up model changes.
 */
export function createToolSelectorMiddleware(config: ToolSelectorConfig): KoiMiddleware {
  const validResult = validateToolSelectorConfig(config);
  if (!validResult.ok) {
    throw KoiRuntimeError.from(validResult.error.code, validResult.error.message);
  }

  return createFromValidated(validResult.value);
}

function createFromValidated(config: ValidatedToolSelectorConfig): KoiMiddleware {
  switch (config.kind) {
    case "custom":
      return createCustomMiddleware(config);
    case "profile":
    case "auto":
      return createProfileMiddleware(config);
  }
}

// ---------------------------------------------------------------------------
// Custom mode (backward compatible)
// ---------------------------------------------------------------------------

function createCustomMiddleware(
  config: Extract<ValidatedToolSelectorConfig, { readonly kind: "custom" }>,
): KoiMiddleware {
  const {
    selectTools,
    alwaysInclude = [],
    maxTools = DEFAULT_MAX_TOOLS,
    minTools = DEFAULT_MIN_TOOLS,
    extractQuery = extractLastUserText,
  } = config;

  async function filterRequest(request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;

    if (tools === undefined || tools.length <= minTools) {
      return request;
    }

    const query = extractQuery(request.messages);
    if (query === "") {
      return request;
    }

    // let: required by try/catch — assigned in try, read after catch
    let selectedNames: readonly string[];
    try {
      selectedNames = await selectTools(query, tools);
    } catch (e: unknown) {
      swallowError(e, { package: "middleware-tool-selector", operation: "selectTools" });
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
    `Tool filtering: selects up to ${String(maxTools)} tools per call (skip below ${String(minTools)})` +
    (alwaysInclude.length > 0 ? `, always includes ${alwaysInclude.join(", ")}` : "");

  return buildMiddleware(filterRequest, description);
}

// ---------------------------------------------------------------------------
// Profile / Auto mode
// ---------------------------------------------------------------------------

function createProfileMiddleware(
  config:
    | Extract<ValidatedToolSelectorConfig, { readonly kind: "profile" }>
    | Extract<ValidatedToolSelectorConfig, { readonly kind: "auto" }>,
): KoiMiddleware {
  const { minTools = DEFAULT_MIN_TOOLS } = config;

  // Resolve profile at factory time. If the model changes after middleware
  // creation (e.g., fallback), the tier cap will NOT be re-evaluated.
  // Recreate the middleware to pick up model changes.
  const resolved = resolveProfile({
    profile: config.profile,
    tier: config.kind === "auto" ? config.tier : undefined,
    include: config.include,
    exclude: config.exclude,
  });

  // Full profile → short-circuit (no filtering)
  if (resolved.isFullProfile) {
    return buildMiddleware(
      async (request) => request,
      "Tool filtering: full profile (no filtering)",
    );
  }

  // Precompute Set for O(1) lookup during filtering
  const allowedSet = new Set(resolved.toolNames);

  async function filterRequest(request: ModelRequest): Promise<ModelRequest> {
    const tools = request.tools;

    if (tools === undefined || tools.length <= minTools) {
      return request;
    }

    // Profile filtering is static — always apply regardless of query content
    const filteredTools = tools.filter((t) => allowedSet.has(t.name));

    // Detect profile tools missing from available tools (for observability)
    const availableNames = new Set(tools.map((t) => t.name));
    const missingTools = resolved.toolNames.filter((name) => !availableNames.has(name));

    const metadata: JsonObject = {
      ...request.metadata,
      toolsBeforeFilter: tools.length,
      toolsAfterFilter: filteredTools.length,
      ...(missingTools.length > 0 ? { profileMissingTools: missingTools } : {}),
    };

    return { ...request, tools: filteredTools, metadata };
  }

  const profileDesc = `profile "${config.profile}" (${String(resolved.toolNames.length)} tools)`;
  const description = `Tool filtering: ${profileDesc}, skip below ${String(minTools)}`;

  return buildMiddleware(filterRequest, description);
}

// ---------------------------------------------------------------------------
// Shared middleware builder
// ---------------------------------------------------------------------------

function buildMiddleware(
  filterRequest: (request: ModelRequest) => Promise<ModelRequest>,
  description: string,
): KoiMiddleware {
  const capabilityFragment: CapabilityFragment = {
    label: "tool-filter",
    description,
  };

  return {
    name: "tool-selector",
    priority: 420,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

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

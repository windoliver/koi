/**
 * Context-editing middleware factory.
 *
 * Scans message history before each model call and replaces old tool
 * result content with a placeholder when total token count exceeds
 * a configurable threshold.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  TurnContext,
} from "@koi/core/middleware";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { editMessages } from "./edit-messages.js";
import type { ContextEditingConfig, ResolvedContextEditingConfig } from "./types.js";
import { CONTEXT_EDITING_DEFAULTS } from "./types.js";

function resolveConfig(config?: ContextEditingConfig): ResolvedContextEditingConfig {
  const triggerTokenCount = config?.triggerTokenCount ?? CONTEXT_EDITING_DEFAULTS.triggerTokenCount;
  const numRecentToKeep = config?.numRecentToKeep ?? CONTEXT_EDITING_DEFAULTS.numRecentToKeep;

  if (triggerTokenCount < 0) {
    throw new Error(`triggerTokenCount must be non-negative, got ${String(triggerTokenCount)}`);
  }
  if (numRecentToKeep < 0) {
    throw new Error(`numRecentToKeep must be non-negative, got ${String(numRecentToKeep)}`);
  }

  return {
    triggerTokenCount,
    numRecentToKeep,
    clearToolCallInputs:
      config?.clearToolCallInputs ?? CONTEXT_EDITING_DEFAULTS.clearToolCallInputs,
    excludeTools: new Set(config?.excludeTools ?? []),
    placeholder: config?.placeholder ?? CONTEXT_EDITING_DEFAULTS.placeholder,
    tokenEstimator: config?.tokenEstimator ?? HEURISTIC_ESTIMATOR,
  };
}

/**
 * Creates a middleware that clears old tool results from message history
 * when the conversation token count exceeds a threshold.
 *
 * Priority 250: runs after pay middleware (200) and before context hydrator (300).
 */
export function createContextEditingMiddleware(config?: ContextEditingConfig): KoiMiddleware {
  const resolved = resolveConfig(config);

  async function applyEdits(request: ModelRequest): Promise<ModelRequest> {
    const tokenCount = await resolved.tokenEstimator.estimateMessages(request.messages);
    const editedMessages = editMessages(request.messages, tokenCount, resolved);
    // Same reference means no edits — return original request
    if (editedMessages === request.messages) {
      return request;
    }
    return { ...request, messages: editedMessages };
  }

  const capabilityFragment: CapabilityFragment = {
    label: "context-editing",
    description: `Old tool results cleared above ${config?.triggerTokenCount ?? "default"} tokens, keeping ${config?.numRecentToKeep ?? "default"} most recent`,
  };

  return {
    name: "koi:context-editing",
    priority: 250,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapModelCall(_ctx, request, next) {
      return next(await applyEdits(request));
    },

    async *wrapModelStream(_ctx, request, next) {
      yield* next(await applyEdits(request));
    },
  };
}

/**
 * Permissions middleware factory — tool-level access control + HITL approval.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { ApprovalCacheConfig, PermissionsMiddlewareConfig } from "./config.js";
import { DEFAULT_APPROVAL_CACHE_MAX_ENTRIES } from "./config.js";
import { fnv1a } from "./hash.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export function createPermissionsMiddleware(config: PermissionsMiddlewareConfig): KoiMiddleware {
  const {
    engine,
    rules,
    approvalHandler,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    approvalCache: approvalCacheOption,
  } = config;

  // Resolve cache config: true → defaults, false/undefined → disabled, object → custom
  const resolvedCache: ApprovalCacheConfig | false =
    approvalCacheOption === true
      ? { maxEntries: DEFAULT_APPROVAL_CACHE_MAX_ENTRIES }
      : approvalCacheOption === false || approvalCacheOption === undefined
        ? false
        : { maxEntries: approvalCacheOption.maxEntries ?? DEFAULT_APPROVAL_CACHE_MAX_ENTRIES };

  /** Cache keyed by fnv1a(toolId + ":" + JSON.stringify(input)). Only approvals are cached. */
  const cache = resolvedCache !== false ? new Map<number, true>() : undefined;

  const capabilityFragment: CapabilityFragment = {
    label: "permissions",
    description: `Tools requiring approval: ${rules.ask.length > 0 ? rules.ask.join(", ") : "none"}. Default: ${config.defaultDeny ? "deny" : "allow"}`,
  };

  return {
    name: "permissions",
    priority: 100,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const decision = engine.check(request.toolId, request.input, rules);

      if (decision.allowed === true) {
        return next(request);
      }

      if (decision.allowed === false) {
        throw KoiRuntimeError.from("PERMISSION", decision.reason, {
          context: { toolId: request.toolId },
        });
      }

      // decision.allowed === "ask"

      // Check approval cache before prompting (true LRU: delete+reinsert on hit)
      if (cache !== undefined) {
        const cacheKey = fnv1a(`${request.toolId}:${JSON.stringify(request.input)}`);
        if (cache.has(cacheKey)) {
          cache.delete(cacheKey);
          cache.set(cacheKey, true);
          return next(request);
        }
      }

      if (!approvalHandler) {
        throw KoiRuntimeError.from(
          "PERMISSION",
          `No approval handler configured for tool "${request.toolId}"`,
          {
            context: { toolId: request.toolId },
          },
        );
      }

      const ac = new AbortController();
      const approved = await Promise.race([
        approvalHandler.requestApproval(request.toolId, request.input, decision.reason),
        new Promise<never>((_, reject) => {
          const timerId = setTimeout(() => {
            reject(
              KoiRuntimeError.from(
                "TIMEOUT",
                `Approval timed out after ${approvalTimeoutMs}ms for tool "${request.toolId}"`,
                {
                  context: { toolId: request.toolId, timeoutMs: approvalTimeoutMs },
                },
              ),
            );
          }, approvalTimeoutMs);
          ac.signal.addEventListener("abort", () => clearTimeout(timerId), { once: true });
        }),
      ]).finally(() => {
        ac.abort();
      });

      if (approved) {
        // Cache the approval (only approvals, not denials)
        if (cache !== undefined && resolvedCache !== false) {
          const cacheKey = fnv1a(`${request.toolId}:${JSON.stringify(request.input)}`);
          if (cache.size >= (resolvedCache.maxEntries ?? DEFAULT_APPROVAL_CACHE_MAX_ENTRIES)) {
            // LRU eviction: Map iteration order is insertion order, so first key is oldest
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(cacheKey, true);
        }
        return next(request);
      }

      throw KoiRuntimeError.from("PERMISSION", `Approval denied for tool "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    },
  };
}

/**
 * Forge usage tracking middleware — records brick usage after successful tool calls.
 *
 * Wraps tool calls via `KoiMiddleware.wrapToolCall`. After a successful call,
 * fires `recordBrickUsage` in fire-and-forget mode. Non-forged tools are silently
 * skipped. Usage recording failures never break tool calls.
 */

import type {
  CapabilityFragment,
  ForgeStore,
  KoiMiddleware,
  StoreChangeNotifier,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { brickId as toBrickId } from "@koi/core";
import type { ForgeConfig } from "./config.js";
import { recordBrickUsage } from "./usage.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForgeUsageMiddlewareConfig {
  readonly store: ForgeStore;
  readonly config: ForgeConfig;
  /** Resolves a tool name to its forge brick ID. Returns `undefined` for non-forged tools. */
  readonly resolveBrickId: (toolName: string) => string | undefined;
  /** Optional notifier for cross-agent cache invalidation after usage-based mutations. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /** Optional error handler for usage recording failures. */
  readonly onUsageError?: (toolName: string, brickId: string, error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Priority 900 — inner layer, runs after audit/permissions middleware. */
const USAGE_MIDDLEWARE_PRIORITY = 900;

/**
 * Creates a `KoiMiddleware` that tracks usage of forged tools.
 *
 * After each successful tool call, looks up the tool's brick ID via
 * `resolveBrickId`. If found, calls `recordBrickUsage` fire-and-forget.
 * Failed tool calls do not record usage. Non-forged tools are silently skipped.
 */
export function createForgeUsageMiddleware(cfg: ForgeUsageMiddlewareConfig): KoiMiddleware {
  const capabilityFragment: CapabilityFragment = {
    label: "forge-usage",
    description: "Forge brick usage tracking active",
  };

  return {
    name: "forge-usage",
    priority: USAGE_MIDDLEWARE_PRIORITY,
    describeCapabilities: () => capabilityFragment,
    wrapToolCall: async (
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => {
      const response = await next(request);

      const brickId = cfg.resolveBrickId(request.toolId);
      if (brickId !== undefined) {
        void recordBrickUsage(cfg.store, brickId, cfg.config)
          .then((result) => {
            if (!result.ok) {
              if (cfg.onUsageError !== undefined) {
                cfg.onUsageError(request.toolId, brickId, result.error);
              }
              return;
            }
            // Notify after successful usage recording (trust tier may have changed)
            if (cfg.notifier !== undefined) {
              void Promise.resolve(
                cfg.notifier.notify({ kind: "updated", brickId: toBrickId(brickId) }),
              ).catch(() => {});
            }
          })
          .catch((error: unknown) => {
            try {
              if (cfg.onUsageError !== undefined) {
                cfg.onUsageError(request.toolId, brickId, error);
              }
            } catch (_: unknown) {
              // Error handler must not crash the process
            }
          });
      }

      return response;
    },
  };
}

/**
 * Compactor bundle — packages compactor middleware + compact_context tool.
 *
 * The bundle factory creates both and wires shared state (scheduleCompaction,
 * formatOccupancy) through closure. Callers register middleware and providers
 * through their respective channels.
 */

import type { MiddlewareBundle } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createCompactContextTool } from "./compact-context-tool.js";
import type { CompactorMiddleware } from "./compactor-middleware.js";
import { createCompactorMiddleware } from "./compactor-middleware.js";
import type { CompactorConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Bundle type
// ---------------------------------------------------------------------------

export interface CompactorBundle extends MiddlewareBundle {
  readonly middleware: CompactorMiddleware;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCompactorBundle(config: CompactorConfig): CompactorBundle {
  const { toolEnabled: _ignored, ...rest } = config;
  const middleware = createCompactorMiddleware({ ...rest, toolEnabled: true });

  const provider = createSingleToolProvider({
    name: "compactor-tool",
    toolName: "compact_context",
    createTool: () =>
      createCompactContextTool({
        scheduleCompaction: middleware.scheduleCompaction,
        formatOccupancy: middleware.formatOccupancy,
      }),
  });

  return { middleware, providers: [provider] };
}
